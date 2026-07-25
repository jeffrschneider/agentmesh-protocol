# Personal Agent Naming (PAN)

**AgentMesh's naming service** — companion to the protocol specification, `SPEC.md`.

**Version:** 0.5-draft · **Date:** 2026-07-24 · **Status:** draft, one reference implementation
**Authors:** Jeff R Schneider <jeffrschneider@gmail.com>

**Changes from 0.4:** Federation-readiness (companion to `SPEC.md` §1.5's
layering invariants). §5.2 WebFinger upgraded SHOULD → MUST and now
defines domain sovereignty: the anchor domain, where it speaks, outranks
every registrar. §5.1 splits the card into identity fields and
attachment fields (different lifetimes, different TTLs) and adds the
serving mesh to the agentmesh endpoint. New §5.5 (resolution authority:
where authority flows from, and how a registrar of record is found) and
§5.6 (re-homing: moving attachment or custodian with no identity event —
pins deliberately do not alarm). §7 gains two obligations: WebFinger
(MUST) and migration-out (MUST — a registrar executes a key-signed
departure; a registrar that won't let a name leave is not conforming).
§8 extends the trust model to multiple registrars (per-registrar
pinning, conflict precedence, surfaced-never-merged). §10's federation
exclusion narrowed accordingly. No changes to handles, claiming, or
binding; no wire changes to existing fields.

**Changes from 0.3:** PAN is now AgentMesh's naming service, not an
independent standard (repositories merged; positioning rewritten). §5.3
card signing and resolver pinning upgraded from SHOULD to MUST; unsigned
cards are no longer valid. Card signing added to registrar obligations
(§7). §8 states the shared-operator trust posture plainly. No wire
changes: handles, canonical strings, the card, and the resolution API are
unchanged. §4.3 (delegated binding) added: a §3.1 partner that verified
agent-key control first-hand may bind without a second pairing ceremony,
disclosed via `binding: agent-key-delegated:<partner>`. §5.4
(discoverability) added: an anchor is findable by its email only after
its owner opts in; default stays no-enumeration.

A small protocol giving AI agents human-handleable names: something a person
can put in an email signature or say in a meeting, the way they hand out a
phone number or a social handle. PAN targets the largest and least-served
agent population: **personal agents**, owned by people who have an email
address and nothing else. No domain, no PKI, no ops team.

PAN deliberately does one thing. It names agents, binds names to them, and
defines what a resolved name returns. It does not transport messages (that
layer belongs to protocols like A2A and AgentMesh), does not verify
capability claims, does not host agents, and does not do discovery (that
belongs to catalog/search layers like ARD).

**Position within AgentMesh.** PAN is AgentMesh's naming service. It is
normative for the mesh: features that need a named, accountable operator
(sender provenance, admission tiers, durable and sealed rooms) resolve
handles against a PAN registrar. The spec stays deliberately
self-contained as a layering discipline — claiming, binding, and
resolution are defined without reference to mesh internals, and pairing
requires nothing but an Ed25519 key — but PAN is not maintained as an
independent standard, and this document assumes the AgentMesh deployment.

**Relationship to ANS.** The Agent Name Service (ANS) covers
domain-anchored, PKI-backed agent identity for organizations that own a
domain and can run a certificate authority. PAN does not compete there:
it names agents whose owner has an inbox, not a PKI team. Domain
anchoring is out of scope by design (§9).

---

## 1. Terminology

- **Handle**: one globally unique string naming an agent, of the form
  `<name>.<email>`.
- **Anchor**: the email address whose control authorizes claims under it.
- **Registrar**: a service that accepts claims, enforces uniqueness,
  answers resolution queries, and maintains the history log.
- **Agent record**: the registrar's minimal record of the agent a handle
  points at: its public key and, optionally, endpoints. It is created by
  binding, not harvested.
- **Binding**: the attachment of a handle to an agent record.
- **Card**: what resolution returns (§5).

## 2. Handles

A handle has one form:

```
<name>.<email>        PublicAgent.ann@gmail.com
```

- `<name>` is any non-empty string up to 64 characters containing no
  whitespace, no `@`, and no control characters. **Dots are allowed.** There
  is no further grammar.
- `<email>` is lowercased.

**Rule 1: nobody parses handles.** A handle is an opaque key. Resolution is
exact-string lookup of the whole handle; no consumer may decompose it. This
is what lets the grammar stay this simple: the string belongs to whoever
claimed it first, and the registrar knows the anchor because it witnessed
the claim.

**Rule 2: uniqueness is full-string, first come, first served.** The
registrar enforces uniqueness on the case-folded complete handle at claim
time. The second claimant is refused with "taken." No exceptions, no
adjudication.

Handles are case-insensitive for matching and case-preserving for display.

## 3. Claiming

Control of the mailbox authorizes claims under it.

1. Claimant submits the anchor email to the registrar.
2. Registrar delivers a short verification code (6 digits, ≤15-minute
   expiry) to that mailbox, and accepts a bounded number of attempts.
3. A correct code yields a bounded session under which the claimant may
   claim handles, bind, release, and list their handles. Registrars choose
   the lifetime; the reference registrar uses 8 hours (long enough to manage
   a roster, short enough that the emailed code stays the real credential).

Registrars MUST rate-limit code issuance per anchor.

**The operator record.** Every anchor has one REQUIRED public display name,
the operator's chosen label (e.g. "Ana Lima"). It MUST be set no later
than the anchor's first claim, under the verified session; it MAY be updated
at any time under a verified session, and every change MUST be recorded in
the history log. Registrars MUST show the operator name on every card of
that anchor's handles (§5.1). The rationale: PAN is *personal* agent naming,
and the handle already publishes the anchor email, so the human behind an
agent is the meaningful unit of trust; a white pages has names. Consumers
MUST treat the name as a chosen label anchored to the proven email, not as
verified identity (§8).

**Lifetime = anchor lifetime.** A handle lives as long as its owner can
re-prove the anchor when required. This is intended: a personal address that
outlives employers keeps its handles; a work address that dies at
offboarding takes its handles with it. That is the governance boundary
working, not a defect.

**Release and cooling-off.** Releasing a handle tombstones it. A released
handle MUST NOT be claimable by anyone for a cooling-off period (REQUIRED
minimum 90 days), so that a handle written down last year does not silently
start pointing at a stranger.

### 3.1 Delegated witnessing

A registrar MAY accept a partner service's attestation that it has already
verified an email, and mint a session without a second code round trip: the
partner (in the reference deployment, the AgentMesh control plane, whose
accounts are themselves email-verified) authenticates to the registrar
with a pre-shared credential and names the email. This trades one email ceremony for a trust link, and
the spec constrains that trade three ways:

1. **Scope.** A delegated session may *establish*: claim handles, set the
   operator name, start pairing, bind. It MUST NOT *destroy or move*:
   release (and any future transfer) MUST be refused with an instruction to
   sign in directly. A stolen delegate credential can then squat new names
   under emails it names, which is detectable and reversible, but cannot
   take existing names away from their owners.
2. **Disclosure.** Sessions carry a provenance, `email` or
   `delegated:<partner>`. Everything a delegated session establishes MUST
   record it: the history log entry, and a `claimed_via` field on the card
   (§5.1), so a relying party who requires first-hand witnessing can tell
   the difference. A delegated claim is indistinguishable from a direct one
   only in capability, never in the record.
3. **Accountability.** The registrar chooses its partners and vouches for
   the arrangement; §8's "trusting the registrar's word" expands to
   "trusting the registrar's choice of witnesses," and the disclosure rule
   exists exactly so consumers can decline the expansion per handle.

## 4. Binding

Claiming a name and proving you operate an agent are different proofs. A
registrar MUST NOT bind a handle on email proof alone unless the agent
record was submitted under that same anchor.

### 4.1 Agent-key pairing (the primary path)

Most personal-agent runtimes hold an Ed25519 key, and the agent's public key
is its identity. Binding proves control of that key:

1. The handle owner, in an authenticated session, requests a **pairing
   code**: short, single-use, ≤10-minute expiry (e.g. `KX4-92F`).
2. The software that holds the agent's private key (*any* software: a
   gateway, a daemon, a five-line script) signs the UTF-8 bytes of the
   canonical string:

   ```
   pan-pair-v1:<code>:<agent-id>
   ```

3. It submits `{code, agent_id, signature}` to the registrar. This call
   needs no authentication: the code proves the handle owner initiated
   pairing; the signature proves agent control. **The binding is the
   intersection of the two proofs.**
4. The registrar verifies the signature against `agent_id`, records the
   agent (its key, and any endpoints supplied), binds the handle, and logs
   the binding with its method.

The agent record is created by this step. There is no prior directory to
look the agent up in: the signature is the record's authorization, and the
key is the agent's address.

For the v0.3 profile: keys are Ed25519 expressed as nkey public strings
(`U…`), and signatures are base64-encoded raw Ed25519 signatures. Other key
profiles may be added; the canonical string is versioned for this reason.

Replay is prevented by construction: codes are single-use and expiring, and
the signed string includes both the code and the agent ID.

**Host neutrality is normative.** A registrar MUST NOT require any
particular agent host, framework, or network for pairing. Whoever holds the
key can pair, from any runtime. This is what makes PAN implementable by any
personal-agent runtime, not just the reference stack.

### 4.2 Submitter-match

For an agent that does not hold a key (for example, an A2A card reachable
only by URL), the owner may submit a minimal agent record under a verified
anchor. A handle anchored to the same email may then bind to it directly.
The proof is that the same email both submitted the record and owns the
name.

### 4.3 Delegated binding

When the partner behind a delegated session (§3.1) has itself verified
control of an agent key first-hand — by an equivalent signed ceremony, a
single-use code signed by the agent's key — the registrar MAY accept the
partner's attestation and bind without a second pairing ceremony. The
rationale is the person's experience: proving key control twice in one
sitting, once to the partner and once to the registrar, proves nothing
the first proof did not.

The trade is disclosed the same way §3.1 discloses claiming:

1. **Scope.** Only a delegated session may bind this way, and only to
   handles its own email anchors. The §3.1 scope limits apply unchanged:
   a delegated session still cannot release.
2. **Disclosure.** The binding method is recorded and served as
   `agent-key-delegated:<partner>` — in the history log entry and on the
   card's `binding` field — so a relying party that requires first-hand
   pairing (§4.1) can tell the difference and re-run the §4.1 ceremony if
   it cares.
3. **Accountability.** The registrar's word now covers the partner's
   verification of key control, not only the email. §8's expansion
   ("trusting the registrar's choice of witnesses") covers this, and §9
   notes what a stolen delegate credential can and cannot do.

## 5. Resolution

Resolution maps a handle to its **card**.

- Resolution MUST be exact-string: case-folded whole-handle lookup.
- Resolution MUST be publicly available without authentication for active
  handles.
- Released handles MUST NOT resolve; registrars SHOULD signal a tombstone
  distinctly from "never existed" in their history log, and MAY do so at
  resolution.
- A handle claimed but not yet bound resolves to its claim record without an
  address ("reserved").

### 5.1 The card

```json
{
  "handle":   "Coder.ana@example.org",
  "operator": { "name": "Ana Lima" },   // REQUIRED: the anchor's chosen public label (§3)
  "binding":  "agent-key",                 // "agent-key" | "agent-key-delegated:<partner>" | "email-submitter" | null
  "claimed_via": "email",                  // "email" | "delegated:<partner>" (§3.1) | "rehomed:<registrar>" (§5.6)
  "claimed_at":  "2026-07-18T…",
  "presence": { "state": "online", "last_seen_at": "…" },   // OPTIONAL, only if a source provides it
  "encryption_key": "<X25519 public key>",   // OPTIONAL, only if the agent declares one
  "endpoints": [
    { "protocol": "agentmesh", "agent_id": "UD653KLV…", "node": "UB2FF…", "mesh": "https://api.agentmesh.ai" },
    { "protocol": "a2a", "url": "https://…/.well-known/agent-card.json" }
  ]
}
```

**Identity fields and attachment fields.** The card carries two kinds of
fact with different lifetimes. *Identity fields* — `handle`, `operator`,
`binding`, `claimed_via`, `claimed_at`, `encryption_key` — say who the
agent is; they change rarely, and only a key change alarms (§5.3).
*Attachment fields* — `endpoints`, `presence` — say where the agent is
served right now; they are expected to change, and consumers MUST NOT
cache them beyond the registrar's stated TTL. Registrars SHOULD serve
attachment data with a TTL an order of magnitude shorter than identity
data. This split is what makes the serving mesh an implementation
detail: *where* may move freely because *who* never rides on it
(SPEC.md §1.5, invariants 1 and 2).

The OPTIONAL `mesh` field on an agentmesh endpoint names the control
plane of the instance currently serving the agent — its **home mesh**.
It is how a resolver learns *where* alongside *who*, and it is an
attachment field: re-pointing it is routine (§5.6), never an identity
event.

The **endpoints are the address**: the reachable coordinates a messaging
layer uses. For a key-bearing agent, the key itself is the address (on
AgentMesh the agent ID is its inbox); a node or an A2A card URL may
accompany it. Presence is optional and appears only where the registrar
actually observes liveness; PAN does not require or build a presence
subsystem. What a consumer *does* with an endpoint belongs to that
endpoint's protocol, not to PAN.

The OPTIONAL `encryption_key` is the agent's X25519 public key, carried so a
correspondent can *seal* content to the agent before first contact: to
invite a named agent into an end-to-end-private room, or to send it a
confidential message, you resolve the handle and seal to this key. It is a
capability the card advertises, not an address; PAN neither defines nor uses
it, and simply passes through what the agent declares (AgentMesh SPEC §4.3).
Absent means the agent participates only in cleartext.

### 5.2 WebFinger and domain sovereignty

A PAN handle is a valid `acct:` URI. Registrars MUST serve
**WebFinger (RFC 7033)**:

```
GET /.well-known/webfinger?resource=acct:Coder.ana@example.org

{
  "subject": "acct:Coder.ana@example.org",
  "properties": { "urn:pan:binding": "agent-key" },
  "links": [ { "rel": "urn:pan:card", "type": "application/json", "href": "…/api/resolve?handle=…" } ]
}
```

so that two decades of existing `acct:` tooling resolves handles with no
PAN-specific code.

WebFinger is also the sovereignty mechanism. The anchor's **domain** may
serve `/.well-known/webfinger` for its own accounts, and where it does,
its answer is final: a domain speaking for its own addresses outranks
every registrar (§5.5). An organization that serves its own WebFinger
needs no registrar at all for its agents' handles. The registrar is the
path for anchors whose mail provider will never serve PAN records — a
Gmail address cannot make google.com answer for it — not a toll booth on
the namespace.

### 5.3 Signed cards and resolver pinning

A resolve response is the registrar's live word, and everything downstream
(sender provenance labels, endpoint routing, encryption keys) rides on it.
Registrars MUST therefore sign cards: an Ed25519 signature over the
canonical JSON of the card (compact, keys recursively sorted — the same
canonical form as the history log, §6), delivered beside it:

```json
{ "card": { … }, "registrar_key": "<Ed25519 public key>", "registrar_sig": "<base64>" }
```

The signing key MUST also be published out of band at
`GET /api/registrar-key`, so a verifier need not bootstrap trust from the
same response it is verifying. A consumer MUST verify the signature and
MUST discard a card whose signature fails **or is absent**: an unsigned
card is invalid, and a bad signature is evidence of tampering, not noise.

Signatures authenticate the registrar; they do not make it honest (§8). The
complementary consumer-side defense is **pinning**, and it is REQUIRED:
resolvers MUST remember `handle → agent key` on first sight and MUST
surface a loud warning when a known handle resolves to a different key —
legitimate on re-pairing, and exactly the signal that matters if a
registrar is compromised or coerced. Resolvers MUST pin the registrar
signing key the same way. Because the
history log is private (§6), pinning is the only external cross-check a
consumer has; a warning's remedy is out-of-band re-verification with the
owner, not silent acceptance.

### 5.4 Discoverability (opt-in)

Handles embed their anchor email, so §6 keeps the roster log private and
no endpoint enumerates an anchor's handles — someone knowing your email
must not learn your agents. Friend discovery ("do any of my contacts have
agents?") is exactly that lookup, so it exists only as a **consented
exception**:

- Every anchor carries a `discoverable` flag, **default off**. It MAY be
  flipped under a verified session (delegated sessions included), and
  every change is logged (§6). Setting it requires an operator record: you
  become findable as someone, not as a blank.
- `GET /api/discover?email=…` is public. For an opted-in anchor it
  returns the operator name and the anchor's active handles (name and
  bound-or-not; full detail still comes from per-handle resolution). For
  everything else it answers `discoverable: false` — **a not-opted-in
  anchor and a nonexistent one answer identically**, so the endpoint
  confirms nothing about anyone who hasn't consented.
- Registrars SHOULD rate-limit discovery like verification-code issuance:
  consent makes the lookup legitimate, not free to farm.

### 5.5 Resolution authority

Until now this document has said "the registrar" as though there were
exactly one. There need not be. Authority over a handle's resolution
flows from the name's owner outward, in this order:

1. **The anchor domain.** If the handle's anchor domain serves WebFinger
   for the anchor (§5.2), its answer is authoritative and final. No
   registrar's record overrides a domain speaking for its own accounts.
2. **The registrar of record.** Otherwise, the handle resolves at its
   registrar of record: the registrar that witnessed the claim, or the
   one the owner has since re-homed to (§5.6). A resolver finds the
   registrar of record two ways: a DNS `TXT` record at
   `_pan.<anchor-domain>` with the content `pan-registrar=<https-URL>`
   (one record; if several are published, resolvers use the
   lexicographically first — deterministic, if inelegant), where the
   domain owner has published one; failing that, the resolver's
   configured registrar list. (The reference resolver ships with the reference registrar the
   way browsers ship trust stores — the list is the resolver operator's
   policy, and adding to it requires no one's permission.)

**Conflicts are surfaced, never merged.** If two registrars both answer
for a handle, precedence is: the anchor domain's word, if any; else the
registrar whose history log (§6) carries the earliest claim. A resolver
that detects a conflict MUST surface it to its consumer as a warning —
like a pin mismatch (§5.3), the remedy is out-of-band verification with
the owner, never silent selection.

A registrar is a **custodian, never an owner**. Nothing in this section
gives any registrar — including the reference registrar — standing to
retain a handle whose owner has moved on (§5.6, §7).

**The anchor probe is visible to the anchor domain.** Consulting the
domain first means the domain learns that somebody is resolving a handle
under it, and roughly when. For a handle anchored at a large mail
provider this tells that provider a little about who is being looked up.
This is inherent in making the domain authoritative — the owner's chosen
authority has to be asked to answer — and it is the same exposure
WebFinger has always carried. Implementations MUST NOT try to hide it by
skipping the probe; they SHOULD keep it cheap and infrequent (a short
timeout and a negative cache, so a provider that serves no PAN WebFinger
is asked rarely rather than once per resolution), and a resolver SHOULD
document that the probe happens.

### 5.6 Re-homing

The agent's identity is its key, and a key change is the only identity
event (SPEC.md §1.5, invariant 2). Both of a handle's pointers can
therefore move without anything happening, identity-wise:

- **Moving the attachment** (a new home mesh): the owner updates the
  card's endpoints under a verified session, or the agent re-binds from
  its new node (§4.1). Routine; logged (§6); no ceremony.
- **Moving the custodian** (a new registrar of record): the software
  holding the agent's key signs the UTF-8 bytes of the canonical string

  ```
  pan-rehome-v1:<handle>:<new-registrar-url>:<ISO-8601 timestamp>
  ```

  and either party submits `{handle, new_registrar, timestamp,
  signature}` to both registrars. On receipt of a valid re-home
  statement the old registrar MUST append a redirect entry to its
  history log, MUST answer subsequent resolutions of that handle with a
  signed referral to the new registrar for at least the cooling-off
  period (§3), and MUST NOT re-issue the handle. The new registrar
  records the claim with provenance `rehomed:<old-registrar>` and
  continues the handle's history from there.

**A statement is not custody.** The paragraph above describes a bearer
authorization: it is self-signed by whoever holds a key, it names its own
destination, and it is presented by an unauthenticated caller. Taken at
face value it authorizes far more than a move — it lets anyone assert any
name at any registrar. A registrar accepting a migration IN therefore
MUST make all five of these checks, and a registrar that makes fewer is
not conforming:

1. **It must be addressed here.** The signed `<new-registrar-url>` MUST
   equal this registrar's own URL. Otherwise a statement written for one
   registrar is replayable at every other.
2. **It must be fresh.** The signed timestamp MUST be within a short
   window (RECOMMENDED: 15 minutes). Otherwise a captured statement is
   good forever.
3. **It must be unspent.** A registrar MUST record statements it has
   acted on and refuse a repeat. Freshness alone leaves a live window in
   which a replay still works.
4. **It must not take a name already held here by another key.** A
   signature proves control of the key in the statement and nothing else;
   it says nothing about a handle already bound to a different key. The
   same reasoning bars a name inside its cooling-off period here (§3) —
   a move MUST NOT be a way around the wait.
5. **The losing registrar must agree.** Before taking custody, the new
   registrar MUST confirm with the named old registrar that the handle
   has been released *to it* — resolving the handle there and requiring
   the referral to name this registrar is sufficient, and requires
   nothing of the old registrar beyond the referral it already owes.
   Without this the statement is uncorroborated: the handle need never
   have existed at the old registrar, or anywhere.

Check 5 fixes the order: **out first, then in.** A registrar MAY reject a
migration IN that arrives before the corresponding migration OUT, and the
owner retries after the departure is recorded.

**Pinning is unaffected — by design.** Pins are `handle → agent key`
(§5.3), and re-homing moves custodians, not keys: a consumer's existing
pin verifies identically against the new registrar's card. A resolver
MUST NOT alarm on a change of registrar alone; it MUST alarm on a change
of key, exactly as before. (Registrar *signing keys* are pinned per
registrar, so the new custodian's key is pinned on first sight like any
other registrar's.)

## 6. The history log

Every claim, binding (with its proof method), and release appends an entry.
Entries are never updated or deleted.

**The log is not public.** Handles embed the owner's address in the name, so
a world-readable log would let anyone enumerate an owner's entire roster by
filtering on their email. The log is therefore owner-scoped: an owner may
retrieve the full history of their own handles after proving control of the
anchor, and it is not otherwise readable.

**Hash chaining is REQUIRED.** Each entry carries the SHA-256 hash of the
previous entry, computed over a canonical serialization that includes that
previous hash, so the log is a chain and any rewrite of history is
detectable:

```json
{ "seq": 1041, "at": "…", "action": "bound", "handle": "…",
  "detail": { "method": "agent-key" },
  "prev_hash": "b64…", "entry_hash": "b64…" }
```

Public, privacy-preserving verifiability (letting a third party confirm the
registrar has not rewritten history without learning who owns what) is
future work; see §10.

## 7. Registrar obligations

A conforming registrar:

1. Enforces full-string uniqueness and the cooling-off window.
2. Never parses handles on behalf of consumers, and never exposes an API
   that requires consumers to parse them.
3. Maintains the append-only, hash-chained history log of §6, and serves
   each owner only their own entries.
4. Serves resolution without authentication, and labels every card with its
   binding method.
5. Requires binding proofs per §4: email proof alone never binds to an agent
   record the anchor did not submit.
6. Signs every card it serves and publishes its signing key out of band
   (§5.3).
7. Serves WebFinger for every active handle (§5.2).
8. Executes migration out: on a valid `pan-rehome-v1` statement (§5.6),
   it publishes the redirect, serves the signed referral, and releases
   custody. A registrar that will not let a name leave is not a
   conforming registrar. This obligation is worded so that the reference
   registrar binds itself first — the credibility of the whole namespace
   rests on custodians being fireable.

## 8. Trust model: read this before trusting a handle

**The registrar is a notary, not an oracle.** An email verification is
witnessed once, by one party; no third party can re-run it. Everyone who
trusts a handle is trusting the registrar's word — and, for a handle whose
card says `claimed_via: delegated:<partner>`, the registrar's choice of
witness (§3.1). The history log records
every action under a hash chain, so tampering is detectable, and an owner
can audit the full history of their own handles. But the log is private
(§6), so this version offers no public cross-check on the registrar: a
deliberate trade of external auditability for owner privacy.

**The registrar and the mesh share an operator.** In the AgentMesh
deployment, the party that runs the registrar also runs the transport.
Signed cards authenticate *which* registrar spoke, and the hash-chained
log makes tampering detectable to the owner — but nothing structural
prevents the operator from rebinding a handle. The defense is §5.3's
mandatory resolver pinning: clients *detect* rebinding rather than
trusting the registrar not to. Authority separation is now *specified* —
an anchor domain may answer for itself (§5.2), authority has a defined
order (§5.5), and owners can move custodians (§5.6) — but until
independent registrars exist in practice, pinning remains the operative
defense, and this document does not pretend otherwise.

**Many registrars, one namespace.** Nothing above requires a single
registrar, and §5.5 defines where authority lies when there are several.
The consumer-side rules generalize cleanly: pin each registrar's signing
key on first sight, scoped to that registrar (§5.3); treat the anchor
domain's WebFinger, where it exists, as outranking any registrar (§5.2);
and treat a two-registrar conflict like a pin mismatch — a loud warning
whose remedy is out-of-band, never silent preference (§5.5). Trusting a
handle still means trusting a registrar's word; with §5.5 the consumer
at least chooses *whose* word, and the owner can fire a custodian who
loses their confidence (§5.6). Authority separation stops being a
federation-era aspiration and becomes a property the owner exercises.

Binding sharpens what a handle claims. An `agent-key` binding is
cryptographic: someone holding the agent's key cooperated with the handle
owner, and that proof does not depend on the registrar's honesty. An
`email-submitter` binding is notarized only.

**The operator name is a label, not an identity.** It is required, stable
across the anchor's handles, set only under a verified session, and
change-logged — which makes it a consistent, auditable claim rather than a
per-message assertion. It is still whatever the mailbox owner chose to
type. The verified fact remains the anchor email (which the handle itself
displays); the name rides on it. Renderers SHOULD source the name from
resolution, never from message contents, so a message sender cannot assert
an operator name at all.

What a handle does **not** prove: that the agent is competent, safe,
endorsed by anyone, or that its capability claims are true. A handle is an
address, not a badge. If you need domain-anchored, publicly re-verifiable,
CA-backed identity, that is what ANS is for; PAN does not reach that bar and
does not try to.

## 9. Security considerations and non-goals

- **Code guessing**: registrars MUST bound verification attempts and rate-
  limit issuance (reference: 5 attempts/code, 5 codes/hour/anchor).
- **Squatting**: full-string uniqueness plus visible anchors makes
  impersonation self-labeling: `support.paypal.attacker@gmail.com` carries
  its own anchor in plain sight. Registrars MAY additionally police names
  but the protocol does not require taste.
- **Email-costume confusion**: handles look like email addresses; mail sent
  to one goes wherever the mail system says, which is unrelated to the
  agent. Registrars SHOULD present handles in contexts that discourage
  mailto interpretation.
- **Delegate credential compromise**: a stolen §3.1 credential could
  always squat new names under emails it names; with §4.3 it can
  additionally bind those names to attacker keys. Both remain
  establish-only (release still requires the owner signing in directly),
  both are fully disclosed on cards and in the log, and resolver pinning
  (§5.3) alarms on any rebinding of a known handle.
- **Anchor compromise**: whoever controls the mailbox controls its handles.
  Anchor hygiene (2FA on the account) is inherited, which is also PAN's
  strength: it rides the most hardened credential most people already have.
- **Non-goal, domain anchoring**: PAN does not anchor names to domains or
  issue certificates. That is ANS's domain, and PAN defers to it rather than
  duplicating a lighter, weaker version. (Distinguish this from §5.2/§5.5
  domain *sovereignty over resolution*: a domain serving WebFinger decides
  where its anchors' handles resolve — routing authority — but the names
  stay email-anchored and the proofs stay §3/§4's; no certificate or
  DNS-proven identity is introduced.)

## 10. Out of scope

- **Domain-anchored identity**: names proven by DNS or well-known records,
  CA-backed certificates, DANE. Covered by ANS.
- **Discovery**: search and browse across agents. Covered by catalog/search
  layers like ARD. PAN resolves a name you already have.
- **Reachability and messaging**: contacting a resolved agent, including any
  registrar-hosted chat or relay surface, belongs to the messaging protocols
  named in the card's endpoints (A2A, AgentMesh).
- **A registrar network**: §5.5 defines resolution authority and §5.6
  defines migration between registrars, but a live mesh of referring
  registrars — shared uniqueness enforcement, referral chains, gossip —
  is not specified. One namespace with well-defined precedence is
  claimed; registrar-to-registrar protocol is not, yet.
- **Additional anchor proofs**: e.g. OIDC sign-in as a mailbox proof.
- **Public, privacy-preserving verifiability**: letting outside parties
  confirm the registrar has not rewritten history without exposing who owns
  what (e.g. Merkle commitments / SCITT-style inclusion proofs over the §6
  chain).

## 11. Reference implementation

The reference registrar lives in the `naming/` directory of the AgentMesh
repository and is deployed as part of the AgentMesh platform. Live and
verified end-to-end: email-tier claiming, §4.1 agent-key pairing (with the
agent record created from the signed pairing), §5 resolution (card +
WebFinger, signed per §5.3), and the §6 hash-chained, owner-scoped history
log. The AgentMesh Rust SDK carries `examples/pan_pair.rs`, a standalone
pairing signer demonstrating §4.1 without any particular agent host. The
mesh-adapter is the reference resolver: it verifies, pins, and warns per
§5.3.

Not yet implemented (0.5 additions, specified ahead of code): the §5.5
resolution-authority chain (the reference resolver still consults the
reference registrar only), §5.6 re-homing, and the §5.1 home-mesh
endpoint field. Implementation status will be updated here as each
lands.
