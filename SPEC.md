# AgentMesh Protocol Specification

**Version:** 0.2.0-draft
**Status:** Working Draft
**Date:** 2026-07-24

> **0.2 revision in progress.** This draft is being revised per `SPEC-0.2-PLAN.md`.
> The prior draft is archived at `SPEC-0.1.0.md`. Key structural changes:
> a first-class **Node** concept (a host that connects once and vouches for the
> agents it hosts), a **registry/presence split**, **optional Tasks**, and the
> relocation of economics and speculative operations into extensions. All
> structural changes and wording polish are applied across §§1–19 (identity/
> envelope, optional tasks, registry/presence split, composed-op disposition,
> node-held inbox, extensions registry, optional observability, economics →
> extension, tenancy/visibility). **§4.5 message signing is locked to
> always-sign**, with stream chunks authenticated at the stream level rather
> than per chunk (§4.5, §11.6). Implemented: TypeScript and Rust SDKs (node model,
> streaming, chunk verification), platform services (registry, presence, node
> profiles, sandbox enforcement), and a public reference deployment.
>
> **2026-07-24: federation-readiness revision.** New §1.5 states the five
> layering invariants this spec and `SPEC-NAMING.md` are subordinate to.
> New `describe` composed operation (§10.14): the pre-admission read.
> Manifest gains the `public` block (§8.7). Registry scoped as
> attachment-only (§9). Node attestations defined as portable objects
> (§9.7). `mesh.peer.` reserved (§14.1). §21 federation constraints made
> normative-now. Companion changes in `SPEC-NAMING.md` 0.5-draft
> (resolution authority, re-homing, registrar obligations).

---

## 1. Introduction

The AgentMesh Protocol is an open specification for reliable, secure agent-to-agent communication over messaging infrastructure. Unlike HTTP-based agent protocols that impose a client-server interaction model, AgentMesh treats the network as a **mesh** — any agent can request, respond, emit, subscribe, and discover any other agent, with the platform providing routing, delivery, persistence, security, and observability.

AgentMesh is a **platform protocol**, not an application protocol. It defines the low-level primitives and infrastructure services that agents consume, rather than prescribing how agents should behave internally.

### 1.1. Design Goals

- **Mesh-native:** Peer-to-peer topology. Any agent can initiate communication with any other agent. No fixed client-server roles.
- **Primitive-first:** A minimal set of irreducible operations from which all higher-level patterns compose.
- **Infrastructure-secure:** Identity, authentication, and authorization enforced at the transport layer via cryptographic primitives, not application-layer tokens.
- **Async-first:** All interactions are natively asynchronous. Synchronous request-response is a special case, not the default.
- **Node-aware:** A single host (a **Node**) MAY connect once and serve many agents. Identity, presence, and delivery are defined so that co-located agents are first-class mesh peers without per-agent connection or credential ceremony.
- **Observable:** Distributed **tracing** context is carried in every envelope. Trace/metric/log *storage* is an optional deployment concern, not a protocol requirement.
- **Binding-defined:** The abstract protocol is separated from its platform binding (Section 18). NATS JetStream is the reference binding; alternative bindings MAY be defined but MUST satisfy the Binding Requirements (§18.1).

> Economics (cost, negotiation, metering) is **not** part of the core protocol in 0.2. It is defined as an optional extension (see Section 17). This keeps the core focused on connectivity, identity, and delivery.

### 1.2. Non-Goals

- Prescribing agent internal architecture, reasoning, or tool use.
- Defining a user-facing API or UI protocol.
- Replacing HTTP-based protocols for browser-to-agent communication. AgentMesh is agent-to-agent infrastructure.

### 1.3. Related Specifications

AgentMesh is designed to compose with the emerging agent ecosystem, not replace it. Two specifications overlap its surface directly. For each, this section states explicitly what AgentMesh **leverages** (reuses rather than reinvents), what it **cedes** (defers to that spec as the authority), and the **boundary** (what AgentMesh contributes that the other does not). A third spec, MCP, is listed as an explicit non-overlap.

**A2A (Agent2Agent Protocol)** — a named protocol for direct agent-to-agent calls: a request/response and task method surface (`message/send`, `message/stream`, `tasks/*`), an Agent Card, and a Task lifecycle.

- *Leverage:* the AgentMesh Task model (Section 7) mirrors A2A's states and object, and the Agent Manifest (Section 8) maps to the A2A Agent Card. Where both name an operation, AgentMesh's wire form is intended to map one-to-one onto A2A's, so a gateway between them is a renaming, not a translation.
- *Cede:* AgentMesh does not seek to redefine A2A's request/response and task **method surface**; A2A is the authority for the direct-call method layer. *(Open decision: whether AgentMesh adopts A2A's method names verbatim on the wire, or keeps its own 1:1-mappable verbs. Not yet resolved.)*
- *Boundary:* AgentMesh contributes what sits *beneath* that method layer — a signed, always-on **mesh** that reaches agents behind firewalls, plus **presence** and an **emit/subscribe event bus**, none of which A2A defines.

**ARD (Agentic Resource Discovery)** — a federated discovery and search layer: an artifact-agnostic catalog envelope, `/.well-known/ai-catalog.json` manifests, and a registry search API that indexes heterogeneous agents (A2A and MCP artifacts among them).

- *Leverage:* an AgentMesh manifest is intended to also publish as an ARD catalog entry, so AgentMesh agents are findable across the wider ecosystem.
- *Cede:* AgentMesh **defers broad, cross-ecosystem discovery to ARD**; ARD is the authority for catalog and search. AgentMesh's own `discover` primitive (Section 6) and registry (Section 9) are scoped to *live, in-mesh* discovery only.
- *Boundary:* AgentMesh contributes **liveness and presence** (who is reachable right now, not just a description) and signed delivery, which ARD does not cover.

**MCP (Model Context Protocol)** connects an agent to its own tools and data (agent-to-resource). It does not overlap AgentMesh's agent-to-agent surface; the two are complementary and require no alignment. The reference adapter exercises that complementarity directly: `mesh-adapter mcp` exposes mesh operations (messaging, rooms, resolution, naming) as MCP tools, so any MCP-capable agent reaches the mesh as a resource without speaking the protocol itself.

**Identity and trust** cuts across A2A and ARD, and is also the subject of dedicated identity specs — W3C DIDs and **ANS** (the IETF Agent Name Service, `draft-narajala-courtney-ansv2`), a domain-anchored, certificate-based trust layer that fills exactly the "who is this agent, and should I trust it" gap A2A and MCP defer. Here AgentMesh is a *provider* rather than a ceder. Neither A2A nor ARD ships a concrete cryptographic root: ARD's TrustManifest is a *container* for pluggable schemes (SPIFFE, DID, attestations), and A2A's Agent Card *declares* an auth scheme. AgentMesh defines an actual one (Section 4): an agent's Ed25519 public key is its ID, and an operator → account → node → agent attestation chain roots trust, anchored at the operator's DNS domain.

- *Own (boundary):* the cryptographic root of trust — per-agent Ed25519 keys, the operator/node/agent attestation chain, DNS-anchored operator identity, and always-signed envelopes. This is what neither ARD nor A2A provides on its own. AgentMesh's *on-mesh* trust stays signature-chain based; it does **not** adopt X.509/CA machinery internally.
- *Cede:* the **auth-advertisement format** to A2A's Agent Card, and cross-ecosystem *catalog* naming to ARD's `urn:air:<publisher>:<namespace>:<agent>` scheme (with the operator's DNS domain as the `publisher`).
- *Own (naming):* human-handleable **naming** is no longer ceded outward. AgentMesh ships its own naming service, **PAN**, specified normatively in the companion **`SPEC-NAMING.md`**: a handle anchored to a verified email, bound to the agent's Ed25519 key, resolving to a registrar-signed card that consumers verify and pin.
- *Leverage / express:* the same Ed25519 identity is intended to be expressed as a `did:key` and carried in ARD's TrustManifest (the attestation chain as its `attestations`); a signed AgentMesh manifest is, by construction, a signed A2A Agent Card. For *cross-organizational* trust, an AgentMesh agent MAY additionally carry a domain-anchored **ANS** identity: AgentMesh's operator DNS anchor (§4.1) aligns with ANS's domain anchoring, `did:key` bridges the two (ANS accepts a DID as a principal binding), and ANS's domain-anchored model plus its SCITT transparency log are directly relevant to Federation (§21). *(Open decisions: whether to adopt `did:key`, `urn:air:`, and/or an ANS identity as external expressions. SPIFFE is a different model, workload identity via a trust domain, and is not currently planned.)*

**NATS** is not a peer protocol but AgentMesh's **substrate**. The reference binding (Section 18) realizes the protocol — transport, identity/credentials, and persistence — on NATS JetStream. NATS is a dependency AgentMesh builds on, not a specification it aligns or competes with; alternative bindings MAY target other infrastructure, provided they meet the Binding Requirements (§18.1).

> In one line: **ARD finds, A2A talks, AgentMesh connects** (reach, trust, presence, and events).

Throughout this document, **"A2A" refers to the named Agent2Agent Protocol**, never to "agent-to-agent" used generically; the generic concept is always written out in full.

### 1.4. Requirements Language

The keywords "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).

### 1.5. Layering Invariants

AgentMesh and its companion naming specification (`SPEC-NAMING.md`, PAN) divide one question — *how do I reach an agent I can trust?* — into layers: **PAN answers who (identity), the mesh answers where and how (attachment and delivery), and the resolved card is the bridge between them.** Five invariants keep the layers from absorbing each other. Every section of both specifications is subordinate to these; a change that violates one is a regression, not an evolution.

1. **A name never encodes a server.** No handle, anywhere, embeds the mesh instance that serves its agent. Which mesh an agent attaches to is a detail of reachability, never part of its name. The moment a name carries an instance, portability is forfeit — the federated-platform trap this design exists to avoid.

2. **The keypair is the identity; everything else is a pointer.** The registrar of record, the home mesh, endpoints, even the handle are re-pointable references to the agent's Ed25519 key. Exactly one event is an identity event — a key change — and only that event trips pinning alarms (SPEC-NAMING §5.3).

3. **Resolution authority flows from the name's owner.** A handle's anchor domain outranks any registrar; a registrar is a custodian, never an owner; and a custodian can be replaced by a statement signed with the agent's own key (SPEC-NAMING §5.5, §5.6).

4. **Strangers may read, never run.** The entire pre-admission surface is two verbs: `describe` (read an operator-declared document, §10.14) and `knock` (a content-free admission request, EXT-6). Neither invokes the agent's model, tools, or memory.

5. **Nothing trusts the wire.** Every object that crosses a boundary — envelope, card, attestation — verifies on its own signature, independent of which connection, node, or instance carried it (§4.5). Federation (§21) is possible precisely because transit was never trusted.

---

## 2. Terminology

- **AgentMesh:** The open protocol defined by this specification: a signed, mesh-native protocol for agent-to-agent communication that provides identity, discovery, request/response, events, presence, and a task model over a messaging transport. "AgentMesh" names the *protocol*; a **Mesh** (below) is a running network that speaks it, and an **instance** is one operator's deployment of that network.
- **Agent:** An autonomous software entity that communicates via the AgentMesh protocol. Agents are opaque — the protocol does not require knowledge of their internal implementation. An agent has its own cryptographic keypair; its public key is its **agent ID**. An agent is always **hosted by a Node**.
- **Node:** A host that maintains a transport connection to the mesh and serves one or more agents over it. The Node holds the transport credential and **vouches** for the agents it hosts (see Section 4). A Node has its own keypair (the **node ID**). One always-on host — e.g. a personal gateway or a machine running an agent fleet — is one Node hosting N agents.
- **Mesh Server:** The infrastructure role a node's connection terminates at. A mesh server routes messages, verifies node credentials at connection time, enforces subject-level authorization and tenant isolation on every operation, and provides durable delivery, the task store, and the presence substrate. It is run by the instance's operator, hosts no agents, and vouches for nothing — a mesh server is the opposite of a node in almost every respect. In the reference binding a mesh server is a NATS server (Section 18.2); its client↔server wire protocol is defined by the binding, not by this document (§18.1).
- **Presence:** The ephemeral liveness state of a node or agent (`online`, `busy`, `degraded`, `offline`) plus load signals. Presence is separate from the manifest and expires on missed heartbeats; it never mutates or deletes a manifest (see Section 9).
- **Node Profile:** Durable, node-keyed metadata describing the *conditions* a host runs under — trust tier, expected uptime, reachability, capacity. Joined into discovery like presence; see Section 9.7.
- **Mesh:** The interconnected network of nodes, agents, registries, and infrastructure services communicating via AgentMesh.
- **Standalone mesh:** An instance with no peers — a legitimate end state (a corporate mesh behind a firewall), not a failure to federate. Also called a *private* instance when unreachable from outside its boundary.
- **Peered mesh:** An instance connected to one or more peer instances under §21, so that agents on each can resolve and reach agents on the other. "Peered", not "federated": the name-and-identity layer never changes with peering (§1.5, invariant 1) — only reachability does.
- **World Wide Mesh:** The connected whole — every peered instance, one namespace, one protocol. The ladder reads: instance → peered mesh → World Wide Mesh.
- **Primitive:** An irreducible protocol operation. All agent interactions compose from primitives.
- **Composed Operation:** A higher-level interaction pattern built from multiple primitives. Standardized for interoperability but not fundamental.
- **Manifest:** A durable self-description document published by an agent, declaring its identity, hosting node, capabilities, and skills. (Liveness is *not* in the manifest — see Presence; cost is an extension field — see Section 17.)
- **Task:** A stateful unit of work with a defined lifecycle, created when an agent processes a request.
- **Message:** A structured communication between agents, carrying metadata, identity, and payload.
- **Artifact:** A discrete output produced by an agent as the result of a Task, distinct from conversational messages.
- **Envelope:** The standard wire format wrapping all protocol messages.
- **Subject:** A routing address for messages: hierarchical, dot-delimited, and supporting multi-level wildcards. Realized as a NATS subject in the reference binding (Section 18).
- **Binding:** A concrete realization of the abstract protocol on specific infrastructure — transport, identity/credentials, and persistence. NATS JetStream is the reference binding (Section 18); AgentMesh terms such as **NKey** and **User JWT** are binding-level names, not protocol concepts.
- **Tenant:** An isolation boundary within the mesh, mapped to a NATS account.
- **Registry:** A platform service that stores agent manifests and serves discovery queries.
- **Bus:** The event distribution infrastructure supporting publish-subscribe patterns.
- **Trace:** A distributed trace spanning multiple agents and operations, identified by a trace ID.
- **Span:** A single unit of work within a trace, scoped to one agent's processing of one operation.

---

## 3. Architecture

### 3.1. Layers

```
┌───────────────────────────────────────────────────────────┐
│                    Agent Applications                      │
│         (LLM agents, tool agents, orchestrators)           │
├───────────────────────────────────────────────────────────┤
│                   Composed Operations                      │
│   connect, delegate, negotiate, stream, broadcast, ...     │
├───────────────────────────────────────────────────────────┤
│                    Core Primitives                          │
│     register, discover, request, respond, emit, subscribe  │
├───────────────────────────────────────────────────────────┤
│                     Task Model                             │
│          lifecycle, state machine, artifacts                │
├───────────────────────────────────────────────────────────┤
│                   Message Envelope                         │
│       identity, tracing, error, versioning                 │
├───────────────────────────────────────────────────────────┤
│                  Platform Services                         │
│         registry, presence, task manager                   │
├───────────────────────────────────────────────────────────┤
│                       Nodes                                │
│   one connection + credential per host; vouches for its    │
│   agents; holds their durable inboxes; local delivery      │
├───────────────────────────────────────────────────────────┤
│                     Transport                              │
│                   NATS JetStream                           │
│       subjects, streams, consumers, KV, security           │
└───────────────────────────────────────────────────────────┘
```

### 3.2. Topology

AgentMesh is a **mesh topology**. There are no fixed client-server roles. Agents do not connect to the transport individually — a **Node** connects on behalf of the agents it hosts (Section 4). Over that connection, each hosted agent is a first-class peer that can:

- Publish messages to any subject its node is authorized to publish on.
- Subscribe to any subject its node is authorized to subscribe to.
- Request-reply with any agent that is listening on its inbox subject — whether that agent is on another node across the internet or on the **same node** (see Section 4.7, Local Delivery).

The transport handles routing, delivery, persistence, and node-level security; the reference binding (Section 18) provides these via JetStream and the NATS credential chain. Agents do not need to know each other's network addresses — only their mesh identities. Whether a peer is remote or co-located is transparent to the agent (**location transparency**).

### 3.3. Agent Surface Area

Every agent MUST implement four inbound handlers:

| Handler | Trigger | Responsibility |
|---------|---------|---------------|
| `onRequest(envelope)` | Incoming request message on the agent's inbox subject | Process the request, create a Task if needed, and respond. |
| `onEvent(envelope)` | Incoming event message on a subscribed subject | React to the event. MAY emit new events or initiate new requests. |
| `onLifecycle(event)` | Agent start or stop | On start: register with the registry. On stop: deregister. |
| `onTaskUpdate(envelope)` | Incoming task status or artifact update | Process updates for tasks this agent has initiated. |

Agents MAY implement additional handlers for composed operations but MUST NOT require counterparties to implement anything beyond these four.

---

## 4. Identity, Nodes & Security

AgentMesh separates two identities that v0.1 conflated: the **Node** (a host that connects to the transport) and the **Agent** (a peer that sends and receives messages). A node connects once and serves many agents. This section defines both identities, how a node vouches for its agents, and how a receiver trusts the `from` field when many agents share one connection.

### 4.1. Trust Hierarchy

```
Operator (root of trust)
  └── Account (tenant isolation boundary)
        └── Node (a host; holds the transport connection + credential)
              └── Agent (a peer identity; hosted and vouched for by a Node)
```

- **Operator:** The operator of a mesh **instance**. Holds that instance's root signing key and authorizes the accounts beneath it. An operator is *a* root of trust, not *the* root: a deployment is one operator's instance, and many independent instances MAY exist (public, corporate, or personal). An operator SHOULD be identified by a DNS domain (e.g. `mesh.example.com`); this domain anchor is reserved for cross-instance (federation) trust, where a peer instance verifies an operator's root key as published at its domain. Federation itself is out of scope for this spec (see §21).
- **Account:** A tenant: the isolation boundary. It issues node credentials and defines the subject import/export rules for cross-tenant communication. (Realized as a NATS account; see §18.2.)
- **Node:** A host that connects to the transport. It holds a keypair (the **node ID**) and a signed credential from its account that authorizes its connection and carries its subject publish/subscribe permissions. One node serves one or more agents. (Concrete credential format: §18.2.)
- **Agent:** A peer identity with its **own** Ed25519 keypair, generated locally. An agent's public key is its **agent ID**. Agents do **not** hold transport credentials and do **not** establish their own connections. An agent exists on the mesh because a node **vouches** for it (§4.4).

> **Why the Node layer.** In v0.1 an agent was a NATS user: 1 agent = 1 NKey = 1 JWT = 1 connection, and `from` was verified at connection granularity (old §5.3). A host running N agents therefore needed N credentialed connections — the per-agent issuance ceremony that made a commercial credential control plane look necessary. Collapsing the connection+credential to the **node** removes that: agents are cheap, keypair-only identities; only nodes need issued transport credentials.

### 4.2. Node Identity

Every node MUST possess:

- A **keypair** (Ed25519) — the node's cryptographic identity (**node ID** = its public key).
- A **signed credential** issued by its account, authorizing the node's transport connection and carrying its subject publish/subscribe permissions plus expiration/revocation metadata. The credential MAY also carry the node's **attested profile claims** (`trust_tier`, `role`; §9.7), since these are operator-signed and a node MUST NOT self-declare them.

The node presents these at connection time. All of the node's hosted agents share this one connection. The concrete credential format (a NATS NKey + a User JWT) is defined in the reference binding (§18.2).

### 4.3. Agent Identity

Every agent MUST possess an Ed25519 keypair generated on (or provisioned to) its host. The public key is the immutable **agent ID**. Agent keys are **not** issued by the account and require no JWT — an agent's right to speak on the mesh comes entirely from its node's vouch (§4.4). This makes creating an agent a local, zero-round-trip operation.

**Encryption key (OPTIONAL).** An agent MAY additionally hold an X25519 keypair, distinct from its Ed25519 signing keypair, used only for receiving sealed content (never for signing). Its purpose is end-to-end confidentiality where the transport or its operator is not trusted to read payloads: a sender seals a symmetric key or a message to the agent's X25519 **public** key, and only the agent can open it. An agent that declares an encryption key publishes the public half in its manifest (§8) as `encryption_key` and, outside the mesh, on its PAN card. The signing key remains the agent's identity and address; the encryption key is a capability attached to it, and its absence simply means the agent participates only in cleartext. This field is the sole prerequisite for the `sealed` privacy grade of the Rooms extension (§17.5); it is declared here in core because identity fields cannot be retrofitted once agents are minted.

### 4.4. Vouching (Node → Agent Attestation)

A node asserts that it hosts an agent by issuing a signed **attestation**:

```json
{
  "node": "<node-nkey-public>",
  "agent": "<agent-nkey-public>",
  "issued_at": "<ISO-8601>",
  "expires_at": "<ISO-8601>",
  "sig": "<Ed25519 signature by the node key over the canonical attestation>"
}
```

- The attestation is included in the agent's manifest (`node` field, Section 8) at `register` time.
- The registry MUST verify: (a) the attestation signature is valid for the claimed node key, and (b) the **registering connection's identity is that node**. This binds the agent to a node that actually connected.
- An agent MAY be re-vouched by a different node (e.g. it migrates hosts) by registering a new attestation. Only the current attestation is authoritative.

The registry records the node→agent binding so any party can resolve "which node hosts agent A?".

### 4.5. Message Identity Assertion

Because one node connection carries messages `from` many agents, the transport can only prove *"a legitimate node published this,"* not *"agent A published this."* AgentMesh closes that gap at the envelope layer:

- Every envelope carries a `sig` field: an Ed25519 signature over the canonical envelope (all fields except `sig`) using the **sending agent's private key** (which its node holds, §4.6).
- A receiver MUST verify `sig` against the `from` agent's public key, and SHOULD confirm (via the registry) that `from` is currently vouched for by a node.
- This makes `from` trustworthy independent of which connection carried the message, restoring per-agent identity in a multiplexed world, and keeps envelopes portable across transports. Because the node currently holds its agents' keys, the signature attests the agent identity **as asserted by its node**; it becomes independent per-agent non-repudiation once agents hold their own keys (the E2E work deferred in `SPEC-0.2-PLAN.md`).

> **Decision (locked, 2026-07-13): always-sign.** Every envelope is signed and every receiver verifies, with a single exception mechanism for high-frequency streams (§11.6): a stream is authenticated by signing its opening and closing envelopes, and the chunks in between are not individually signed. Rationale for always-sign over cross-node-only:
>
> - **One rule, one verification path.** There is no "is this crossing a node boundary?" branch, which is the class of bug where a message that should have been signed is not. Same-node signing (§4.7) adds no cryptographic security under node-held keys (the node holds both keys and delivers the message to itself), but is kept anyway for uniformity and a complete audit trail. The cost is roughly one Ed25519 sign plus one verify per message, negligible beside LLM and network cost.
> - **Forward-compatible.** When agents eventually hold their own keys, always-sign already yields true per-agent non-repudiation with no protocol change.
> - **Cross-node-only stays on the table as a later, profiling-driven optimization**, not a second trust mode in 0.2. The real cost lever is per-chunk signing on streams, not per-message signing, and §11.6 addresses that directly.

### 4.6. Authentication & Authorization

**Transport (node-level):** authentication happens once at connection establishment — the node proves possession of its node key and presents its credential, and the transport verifies the credential chain (node → account → operator). The node's subject publish/subscribe permissions and its account's import/export rules are then enforced by the transport on every operation. The concrete mechanism (NKey nonce signing + Node JWT → Account JWT → Operator JWT verification) is defined in the reference binding (§18.2).

**Message (agent-level):** the envelope `sig` (§4.5) authenticates the individual agent. Receivers use the verified `from` for authorization decisions.

**Application:** agents and platform services MAY apply their own policy on top of a verified `from`.

### 4.7. Local Delivery (Same-Node Agents)

Two agents hosted by the same node ARE mesh peers and CAN communicate. A node MAY deliver an envelope addressed to an agent it hosts **without transiting the transport**, provided delivery is **observationally equivalent** to remote delivery:

- Same envelope schema and validation, same identity verification (`sig` against `from`), same trace propagation, same per-subject ordering, same dedup-by-`id` semantics.
- The node MUST record local-delivery envelopes in the same audit/observability path as remote ones — a node sees 100% of its agents' traffic regardless of path, so tracking is complete either way.
- Because signing is always-on (§4.5), a locally-delivered envelope is signed exactly like a remote one; there is **no unsigned local fast path**. A message that later transits the shared transport (for example after an agent migrates nodes, §4.4) therefore always carries a valid `sig`.

This preserves **location transparency**: an agent's code is identical whether its peer is across the internet or in the same process, and moving an agent between hosts changes nothing semantically.

- **`request`/`respond`** (point-to-point, addressed): the node SHOULD short-circuit locally when the recipient is a hosted agent and the node is the sole authority for the reply.
- **`emit`/`subscribe`** (bus fan-out): membership lives at the transport (who else subscribed?), so events SHOULD transit NATS when the node is online; the node falls back to local event delivery only while offline. Dedup-by-`id` (§5.5) covers any double-hearing.

### 4.8. Credential Lifecycle

Credential lifecycle applies to **node** credentials only (agents are keypair-only and are managed by their node). The operator issues and rotates node credentials; no external/commercial control plane is required at the scale this protocol targets. The protocol REQUIRES:

- Account/operator **signing** keys MUST NOT be stored on individual nodes.
- Node credentials MUST have a finite expiration.
- Node revocation MUST be achievable without restarting other nodes or the mesh servers.
- Node credential rotation MUST be achievable without downtime.
- A node MUST protect the agent private keys it holds at rest (host-appropriate key storage).

### 4.9. Owners and Authority

The **owner** is the principal — a person or an organization — that holds an account (§4.1). Where the account is the tenancy and isolation boundary, the owner is who controls it: who registers the nodes and agents under it, and who sets the **policy** that governs them (for example, who may reach an agent's inbox, or who is admitted to a room). An agent has an identity (§4.3); an owner has **authority** over agents. The two are distinct: identity is who is speaking, authority is who may change the rules.

An owner authenticates to a mesh instance through that instance's account control plane (the reference binding uses email-verified account sessions; §18). A successful authentication establishes an **account session**: proof that a request is made by the account's owner.

**Owner policy** is any owner-controlled configuration the mesh or its agents act on — contact rosters, admission policy, room membership. A change to owner policy is authorized in one of two ways. An implementation MUST support the first; the second is OPTIONAL and exists for portability and for reduced trust in the operator.

- **Account-session authority (primary).** The owner authenticates an account session and the mesh authorizes the write directly. This is the default path for owner-facing management: the owner signs in, edits policy, and the mesh stores and enforces it. It is the natural model for a hosted management surface such as a web console, and it assumes what mesh-side enforcement already assumes — that the owner trusts the operator to store and enforce policy faithfully, since the operator is the party enforcing it.

- **Owner-key authority (secondary, OPTIONAL).** The owner holds an **owner key**: an account-level Ed25519 keypair, distinct from any node or agent key, whose public half is recorded on the account. The owner signs a policy artifact with this key, and any party — including a client that does not trust the storing operator — verifies the signature and treats the signature, not the storage location, as the authority. This makes a policy artifact **portable**: it can be carried between meshes, held on untrusted storage, and enforced by a client with no server involvement. It is the right path for a headless client that authors its own policy and for an owner who does not trust a given operator.

The two paths are not exclusive: a policy MAY be authored under an account session and additionally signed for portability, and a signed artifact MAY be uploaded to a mesh that stores it under account-session control. An extension that defines owner policy MUST state which path or paths it uses and what trust each assumes, and MUST reference this section rather than redefine the model.

Account-session authority trusts the operator; it is appropriate wherever the operator is already trusted to enforce. Owner-key authority trusts only the owner's signature; it is appropriate wherever the operator or the storage is not trusted. Neither affects agent identity (§4.5): every message an agent sends is signed by the agent key regardless of how owner policy was authorized.

---

## 5. Message Envelope

All AgentMesh protocol messages use a standard envelope format. The envelope is the wire format for every primitive operation.

### 5.1. Envelope Schema

```json
{
  "v": "0.1.0",
  "id": "<message-uuid>",
  "type": "<primitive-type>",
  "ts": "<ISO-8601-timestamp>",

  "from": "<agent-nkey-public>",
  "to": "<agent-nkey-public | subject-pattern>",

  "trace": {
    "trace_id": "<32-hex-char W3C trace-id>",
    "span_id": "<16-hex-char W3C span-id>",
    "parent_span_id": "<16-hex-char span-id | null>",
    "tracestate": "<W3C tracestate | absent>"
  },

  "task_id": "<uuid | null>",
  "in_reply_to": "<message-uuid | null>",
  "context_id": "<uuid | null>",

  "error": "<ErrorObject | null>",

  "payload": "<arbitrary-json>",
  "artifacts": ["<ArtifactObject>"],

  "meta": {
    "<key>": "<value>"
  },

  "sig": "<Ed25519 signature by the `from` agent's key over the canonical envelope (all fields except `sig`)>"
}
```

### 5.2. Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `v` | string | REQUIRED | Protocol version. Semver format. |
| `id` | string | REQUIRED | Unique message identifier. UUID v7 RECOMMENDED (time-ordered). |
| `type` | enum | REQUIRED | The primitive type. One of: `register`, `discover`, `request`, `respond`, `emit`, `subscribe`. |
| `ts` | string | REQUIRED | ISO 8601 timestamp in UTC. Millisecond precision RECOMMENDED. |
| `from` | string | REQUIRED | Ed25519 public key of the sending agent (its agent ID). Authenticity is established by the envelope `sig` (§4.5). |
| `to` | string | RECOMMENDED | Ed25519 public key of the intended recipient, or a subject pattern for broadcast. MAY be omitted for bus-targeted emits. |
| `trace` | object | REQUIRED | Distributed tracing context. See Section 13. |
| `trace.trace_id` | string | REQUIRED | Trace identifier in W3C Trace Context format: 32 lowercase hex characters. All messages in a causal chain share the same trace_id. |
| `trace.span_id` | string | REQUIRED | Span identifier for this specific operation, in W3C format: 16 lowercase hex characters. |
| `trace.parent_span_id` | string | OPTIONAL | Span ID of the parent operation. Null for root spans. |
| `trace.tracestate` | string | OPTIONAL | W3C `tracestate` value, carried verbatim for vendor-specific trace data. |
| `task_id` | string | OPTIONAL | Task identifier. Present when the message is part of a Task lifecycle. |
| `in_reply_to` | string | OPTIONAL | Message ID this message is responding to. Present in `respond` messages. Links response to request. |
| `context_id` | string | OPTIONAL | Context identifier. Groups related tasks and messages into a logical session. |
| `error` | object | OPTIONAL | Error information. Present only when the message represents an error condition. See Section 12. |
| `payload` | any | OPTIONAL | The message payload. Structure depends on the primitive type and the agent's skill contract. |
| `artifacts` | array | OPTIONAL | Output artifacts produced by a Task. See Section 7.5. |
| `meta` | object | OPTIONAL | Extensible key-value metadata. Used for extensions, routing hints, etc. The key `hops` is **reserved** for cross-instance relay counting (§21) and MUST NOT be used for anything else. |
| `sig` | string | REQUIRED | Ed25519 signature over the canonical envelope (all fields except `sig`) by the `from` agent's private key. Establishes per-agent identity independent of the transport connection. See Sections 4.5 and 5.3. |

### 5.3. Identity Verification

Because one node connection may carry messages from many agents (Section 4), the transport connection identity is the **node**, not the sending agent. Per-agent identity is therefore established by the envelope signature, not the connection:

1. The receiver MUST verify `sig` against the public key in `from` (an Ed25519 verify over the canonical envelope). If verification fails, the message MUST be rejected with `IDENTITY_MISMATCH`.
2. The receiver SHOULD confirm, via the registry, that `from` is currently **vouched for** by a node (Section 4.4). An unvouched or revoked agent SHOULD be rejected with `UNAUTHORIZED`.
3. Transport-level node authentication (Section 4.6) still applies underneath: the publishing connection is a cryptographically authenticated node with enforced subject permissions.

A verified `from` is trustworthy and non-repudiable: only the holder of the agent's private key could have produced `sig`. Agents SHOULD use the verified `from` for authorization decisions.

Canonicalization for signing/verification: serialize the envelope excluding `sig`, sort object keys, and use minimal whitespace (the same canonical-JSON procedure as manifest signing, Section 8.3).

### 5.4. Message Ordering

Within a single subject, messages are delivered in the order they are published; the binding guarantees this per-subject ordering (§18.1). Cross-subject ordering is NOT guaranteed.

For operations requiring strict ordering (e.g., streaming responses to a single request), all messages MUST be published to the same subject.

### 5.5. Idempotency

The `id` field enables idempotent processing:

- Senders SHOULD use deterministic IDs for retries of the same logical operation.
- Receivers SHOULD track processed message IDs and skip duplicates.
- Deduplication is keyed by the envelope `id`; the binding provides publish-side deduplication (§18.8).

---

## 6. Primitives

AgentMesh defines six atomic primitives. All agent interactions compose from these operations.

### 6.1. Primitive Summary

| Primitive | Direction | Subject Pattern | Description |
|-----------|-----------|----------------|-------------|
| `register` | Agent → Registry | `mesh.registry.register` | Publish the agent's manifest to the registry. |
| `discover` | Agent → Registry | `mesh.registry.discover` | Query the registry for agents matching criteria. |
| `request` | Agent → Agent | `mesh.agent.{agent_id}.inbox` | Send a request to a specific agent. Expects a `respond`. |
| `respond` | Agent → Requester | Reply subject (NATS inbox) | Return a response to a prior request. Completes or progresses a Task. |
| `emit` | Agent → Bus | `mesh.event.{domain}.{event_type}` | Publish a fire-and-forget event. No reply expected. |
| `subscribe` | Agent → Bus | `mesh.event.{domain}.{event_type}` | Declare interest in events matching a subject pattern. |

### 6.2. `register`

Publishes or updates the agent's manifest in the registry.

**Subject:** `mesh.registry.register`

**Envelope:**
```json
{
  "type": "register",
  "from": "<agent-nkey>",
  "payload": { "<ManifestObject>" }
}
```

**Behavior:**
- The registry MUST validate the manifest schema.
- The registry MUST verify that `from` matches `payload.id`.
- If a manifest with the same `id` already exists, the registry MUST treat this as an update (upsert).
- The registry MUST persist the manifest in durable storage (§18.4).
- The registry SHOULD emit a `mesh.event.registry.agent_registered` event upon successful registration.

**Errors:**
- `INVALID_MANIFEST`: The manifest fails schema validation.
- `IDENTITY_MISMATCH`: The `from` field does not match the manifest `id`.

### 6.3. `discover`

Queries the registry for agents matching specified criteria.

**Subject:** `mesh.registry.discover` (NATS request-reply)

**Envelope:**
```json
{
  "type": "discover",
  "from": "<agent-nkey>",
  "payload": {
    "capabilities": ["web-scrape", "search"],
    "availability": "online",
    "skill_id": "<optional-specific-skill>",
    "tags": ["<optional-tags>"],
    "version": "<optional-semver-range>",
    "limit": 10
  }
}
```
*(Cost-based discovery filters — `max_cost` — are provided by the Economics extension, Section 17, not core.)*

**Response Envelope:**
```json
{
  "type": "respond",
  "in_reply_to": "<discover-message-id>",
  "payload": {
    "agents": [ "<ManifestObject>", "..." ],
    "total": 42
  }
}
```

**Behavior:**
- The registry MUST filter manifests against all provided criteria using AND semantics.
- The registry MUST only return manifests visible to the requesting agent's tenant (NATS account), unless cross-tenant discovery has been explicitly configured via account subject imports.
- The registry SHOULD support pagination via `limit` and a `cursor` field in subsequent requests.
- Capability matching SHOULD support subset matching: an agent with capabilities `["a", "b", "c"]` matches a query for `["a", "b"]`.

**Errors:**
- `INVALID_QUERY`: The query payload fails schema validation.

### 6.4. `request`

Sends a request to a specific agent, expecting a `respond`.

**Subject:** `mesh.agent.{agent_id}.inbox`

**Envelope:**
```json
{
  "type": "request",
  "from": "<requester-nkey>",
  "to": "<responder-nkey>",
  "trace": { "trace_id": "...", "span_id": "...", "parent_span_id": "..." },
  "context_id": "<optional-session-context>",
  "payload": {
    "skill": "<skill-id>",
    "input": { "<skill-specific-input>" },
    "config": {
      "timeout_ms": 30000,
      "stream": false,
      "accepted_output": ["text/plain", "application/json"]
    }
  },
  "meta": {
    "idempotency_key": "<optional-dedup-key>",
    "priority": "normal"
  }
}
```

**Behavior:**
- A request has two possible response shapes, chosen by the responder and discovered by the requester from the first reply (see Section 7.0):
  - **Bare response** — the responder answers within the reply window with a single terminal `respond` (`task_id: null`). No Task object is created. This is the expected path for quick, synchronous work (status checks, lookups, one-shot answers).
  - **Task response** — the responder cannot finish now (long-running work), is streaming, or needs further input; it MUST create a Task (see Section 7) and reply with a non-terminal status and a `task_id`, then deliver progress via task update subjects.
- The agent MUST create a Task **only when** it defers, streams, or enters `input_required`/`auth_required`. It MUST NOT create a Task solely to answer a request it can complete immediately.
- If the agent cannot handle the request, it MUST respond with an appropriate error (see Section 12). Error responses need not create a Task.
- The request MUST include a reply subject for response delivery.
- If `config.stream` is `true`, the agent SHOULD use the Task response shape and deliver incremental results as a sequence of `respond` messages on a task-specific subject (see Section 11).
- If `config.stream` is `true`, the agent SHOULD deliver incremental results as a sequence of `respond` messages on a task-specific subject (see Section 11).
- If `config.timeout_ms` is specified, the requester SHOULD cancel the request if no response is received within the timeout.
- If `payload.skill` is specified, the agent SHOULD dispatch to the named skill. If the skill is not found, the agent MUST respond with a `SKILL_NOT_FOUND` error.

**Offline targets (the queued outcome).** A request to an agent that is not
currently connected is not necessarily lost: if the target has a redelivery
buffer (Section 16.4), the transport captures the request and the target
processes it when it returns. Because the original reply channel does not
survive the wait, the late `respond` is delivered as a normal message to the
**sender's own inbox**, correlated by `in_reply_to` — buffered in turn if the
sender has meanwhile gone offline. Senders SHOULD therefore treat silence from
a registered agent as *possibly queued* rather than failed, and surface it
that way. `AGENT_UNAVAILABLE` means the request was undeliverable **and
unbuffered** (e.g., sandbox agents, which have no buffer). A responder MAY
still create a Task (Section 7) for buffered work; nothing requires it —
`in_reply_to` correlation suffices.

**Errors:**
- `AGENT_UNAVAILABLE`: The agent is not accepting requests and has no redelivery buffer (offline sandbox agent, unregistered id, or at capacity).
- `SKILL_NOT_FOUND`: The requested skill is not supported by the agent.
- `INPUT_INVALID`: The input payload does not conform to the skill's expected schema.
- `UNAUTHORIZED`: The requesting agent does not have permission to invoke this skill.
- `CONTENT_TYPE_NOT_SUPPORTED`: The requested output modes are not supported.

### 6.5. `respond`

Returns a response to a prior `request`. Completes or progresses a Task.

**Subject:** NATS reply subject (for synchronous) or `mesh.task.{task_id}.update` (for async updates)

**Envelope:**
```json
{
  "type": "respond",
  "from": "<responder-nkey>",
  "to": "<requester-nkey>",
  "in_reply_to": "<request-message-id>",
  "task_id": "<task-uuid>",
  "trace": { "trace_id": "...", "span_id": "...", "parent_span_id": "..." },
  "payload": {
    "status": "<TaskState>",
    "message": "<optional-human-readable-status>",
    "output": { "<skill-specific-output>" }
  },
  "artifacts": [
    {
      "id": "<artifact-uuid>",
      "name": "report.pdf",
      "media_type": "application/pdf",
      "parts": [
        { "text": "..." },
        { "data": { "<structured-data>" } },
        { "ref": "nats://objectstore/bucket/key", "media_type": "application/pdf", "size": 1048576 }
      ]
    }
  ],
  "error": null
}
```

**Behavior:**
- A `respond` MUST reference the original request via `in_reply_to`.
- A `respond` carries a `task_id` **only** when the interaction is in Task mode. A **bare** response (§6.4) sets `task_id: null` and MUST use a terminal `payload.status` (`completed` or `failed`).
- The `payload.status` field indicates the outcome (bare) or the Task state transition (Task mode; see Section 7).
- A `respond` with `status: "completed"` is a terminal response. In Task mode, no further responses for this Task are expected unless the Task is reopened.
- A `respond` with `status: "input_required"` indicates the agent needs additional input to proceed. The requester SHOULD send a new `request` with the same `task_id` and `context_id`.
- Artifacts are deliverables. Messages are communication. Do not use `payload.output` for large results; use `artifacts`.

### 6.6. `emit`

Publishes a fire-and-forget event to the bus. No reply expected.

**Subject:** `mesh.event.{domain}.{event_type}` (e.g., `mesh.event.scraping.profile_found`)

**Envelope:**
```json
{
  "type": "emit",
  "from": "<emitter-nkey>",
  "trace": { "trace_id": "...", "span_id": "...", "parent_span_id": "..." },
  "task_id": "<optional-originating-task>",
  "payload": {
    "domain": "scraping",
    "event_type": "profile_found",
    "data": { "<event-specific-data>" }
  }
}
```

**Behavior:**
- Events are published to a subject derived from the domain and event type.
- Events MUST be persisted durably for replay (§18.3).
- Events MAY reference a Task via `task_id` for traceability but are not required to.
- Emitters MUST NOT expect or wait for a response. Events are fire-and-forget from the publisher's perspective.
- The platform SHOULD enforce rate limiting on event emission per agent per subject.

### 6.7. `subscribe`

Declares interest in events matching a subject pattern.

**Subject:** Not a message type — this is a NATS subscription operation.

**Behavior:**
- Agents subscribe to event subjects using NATS wildcard patterns:
  - `mesh.event.scraping.*` — all scraping events.
  - `mesh.event.>` — all events across all domains.
  - `mesh.event.scraping.profile_found` — a specific event type.
- Subscriptions MAY be durable or ephemeral. Durable subscriptions MUST provide at-least-once replay with explicit acknowledgment (§18.6).
- The agent's `onEvent` handler is invoked for each matching event.
- Subscription permissions are enforced by the transport based on the hosting **node's** credential, which must permit the subjects of every agent the node hosts (§18.2).

---

## 7. Task Model

A Task is a stateful unit of work. Tasks provide the structure for tracking, resuming, and completing **deferred** work. They are not required for every request.

### 7.0. When a Task Exists

A responder creates a Task **only** when a request cannot be answered with a single terminal reply — i.e. when the work is long-running, streamed, or needs another round (`input_required` / `auth_required`). See Section 6.4.

- **No Task** (bare mode): the responder returns a terminal `respond` (`task_id: null`). Nothing is persisted; the interaction is a single request/response round. This is the common case.
- **Task** (deferred mode): the responder returns a non-terminal `respond` with a `task_id`, then drives the Task through its lifecycle (below). The Task is the durable, resumable record of that work.

Requesters need no advance knowledge of which mode applies: the first `respond` tells them — a terminal status with `task_id: null` means done; a `task_id` with a non-terminal status means subscribe for updates.

> **A2A alignment.** This Task model mirrors the A2A Protocol (Section 1.3): the state set below, the Task object, and Artifacts/Parts correspond to A2A's, and the Agent Manifest (Section 8) maps to the A2A Agent Card. This keeps AgentMesh Tasks interoperable with A2A at the task layer.

### 7.1. Task Object

```json
{
  "id": "<uuid>",
  "context_id": "<uuid>",
  "requester": "<agent-nkey>",
  "responder": "<agent-nkey>",
  "skill": "<skill-id>",
  "state": "<TaskState>",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "history": [ "<EnvelopeObject>" ],
  "artifacts": [ "<ArtifactObject>" ],
  "meta": {}
}
```

### 7.2. Task States

```
             ┌──────────┐
             │ submitted │
             └─────┬─────┘
                   │
             ┌─────▼─────┐
        ┌────│  working   │────┐
        │    └─────┬─────┘    │
        │          │          │
  ┌─────▼──────┐   │    ┌────▼─────┐
  │   input    │   │    │   auth   │
  │  required  │   │    │ required │
  └─────┬──────┘   │    └────┬─────┘
        │          │          │
        └────┬─────┘──────────┘
             │
      ┌──────┼──────────┐
      │      │          │
┌─────▼──┐ ┌─▼────┐ ┌──▼──────┐
│completed│ │failed│ │canceled │
└────────┘ └──────┘ └─────────┘
```

| State | Terminal | Description |
|-------|----------|-------------|
| `submitted` | No | Request received, Task created, processing has not yet begun. |
| `working` | No | Agent is actively processing the request. |
| `input_required` | No | Agent needs additional input from the requester to continue. |
| `auth_required` | No | Agent needs additional credentials or authorization to continue. |
| `completed` | Yes | Task finished successfully. Artifacts are available. |
| `failed` | Yes | Task terminated due to an error. Error details in the envelope. |
| `canceled` | Yes | Task was canceled by the requester or the responder. |
| `rejected` | Yes | Responder declined the Task (cannot or will not perform the skill). Distinct from `failed`, which is an error *during* execution. Matches A2A's `rejected`. |

> The diagram above shows the execution lifecycle. `rejected` is an additional terminal state entered directly from `submitted` when the responder declines the Task, and is omitted from the diagram for clarity.

### 7.3. Task State Transitions

| From | To | Trigger |
|------|----|---------|
| — | `submitted` | Agent receives a `request` and creates a Task. |
| `submitted` | `working` | Agent begins processing. |
| `working` | `completed` | Agent finishes successfully. |
| `working` | `failed` | Agent encounters an unrecoverable error. |
| `working` | `input_required` | Agent needs more information from the requester. |
| `working` | `auth_required` | Agent needs additional credentials. |
| `working` | `canceled` | Requester or responder cancels the Task. |
| `input_required` | `working` | Requester provides the requested input via a follow-up `request`. |
| `auth_required` | `working` | Requester provides the required credentials. |
| `submitted` | `canceled` | Requester cancels before processing begins. |
| `submitted` | `rejected` | Responder declines the Task before processing begins. |

Transitions not listed in this table are invalid. Implementations MUST reject invalid state transitions with a `TASK_INVALID_TRANSITION` error.

### 7.4. Task Persistence

Tasks MUST be durably persisted, keyed by `task_id`, in a store that is the authoritative source of truth for task state and is updated on every state transition. Task status updates and artifact deliveries are published to the task's update channel for delivery to the requester, with the durable store remaining canonical for lookups.

The concrete store and channels (a NATS KV bucket plus the `mesh.task.{task_id}.update` subjects and `MESH_TASKS` stream) are defined in the reference binding (§18.4).

### 7.5. Artifacts

Artifacts are the outputs of a Task — the deliverables. They are distinct from conversational messages.

```json
{
  "id": "<artifact-uuid>",
  "name": "<human-readable-name>",
  "media_type": "<MIME-type>",
  "parts": [
    { "text": "<text-content>" },
    { "data": { "<structured-json>" } },
    { "ref": "<nats-object-store-reference>", "media_type": "<MIME>", "size": 12345 }
  ],
  "created_at": "<ISO-8601>",
  "meta": {}
}
```

**Part Types:**
- `text`: Inline text content.
- `data`: Inline structured JSON data.
- `ref`: A reference to a binary object stored in NATS Object Store. Used for files, images, and large payloads that exceed the NATS maximum message size.

An artifact MAY contain multiple parts (e.g., a text summary + a data table + a PDF reference).

### 7.6. Context

A `context_id` groups related Tasks into a logical session. When a requester sends multiple related requests, they SHOULD use the same `context_id`. The responder MAY use the context to maintain conversational state, memory, or shared context across tasks.

- If a `request` does not include a `context_id`, the responder MUST generate one and include it in the `respond`.
- If a `request` includes both `task_id` and `context_id`, the responder MUST verify that the task belongs to the specified context.
- Context expiration and cleanup policies are implementation-defined. Agents SHOULD document their context retention policies in their manifest.

---

## 8. Agent Manifest

The manifest is an agent's self-description document. It is published to the registry via `register` and queried via `discover`.

### 8.1. Manifest Schema

```json
{
  "id": "<agent-nkey-public>",
  "name": "<human-readable-name>",
  "description": "<what-this-agent-does>",
  "version": "<semver>",
  "protocol_version": "0.1.0",

  "provider": {
    "name": "<organization-or-individual>",
    "url": "<provider-url>"
  },

  "endpoint": "mesh.agent.<agent-nkey>.inbox",

  "encryption_key": "<X25519 public key, OPTIONAL>",

  "public": {
    "description": "<one-paragraph storefront: what this agent does, in the operator's words>",
    "skills": ["<skill-ids the operator advertises to strangers>"],
    "admission": "<what admission takes: terms, expectations, or a URL>",
    "links": [ { "handle": "<related-agent-handle>", "rel": "<relationship>" } ]
  },

  "node": {
    "id": "<node-nkey-public>",
    "attestation": {
      "node": "<node-nkey-public>",
      "agent": "<agent-nkey-public>",
      "issued_at": "<ISO-8601>",
      "expires_at": "<ISO-8601>",
      "sig": "<Ed25519 signature by the node key>"
    }
  },

  "capabilities": ["<capability-tag>"],

  "skills": [
    {
      "id": "<skill-id>",
      "name": "<human-readable>",
      "description": "<what-this-skill-does>",
      "tags": ["<tag>"],
      "input_schema": { "<json-schema>" },
      "output_schema": { "<json-schema>" },
      "input_modes": ["text/plain", "application/json"],
      "output_modes": ["text/plain", "application/json"],
      "examples": [
        {
          "input": "<example-input>",
          "output": "<example-output>"
        }
      ],
      "streaming": false,
      "estimated_duration_ms": 5000
    }
  ],

  "accepts": ["<event-subject-patterns-this-agent-subscribes-to>"],
  "emits": ["<event-subject-patterns-this-agent-publishes>"],

  "cost": {
    "per_request": 0.01,
    "per_token": 0.0001,
    "currency": "credits",
    "billing_model": "per_request"
  },

  "rate_limits": {
    "requests_per_second": 10,
    "requests_per_minute": 100,
    "concurrent_tasks": 5
  },

  "trust": {
    "tenant": "<nats-account-public-key>",
    "signed_at": "<ISO-8601>",
    "signature": "<Ed25519-signature-of-canonical-manifest>"
  },

  "extensions": [
    {
      "uri": "<extension-identifier-uri>",
      "description": "<what-it-does>",
      "required": false,
      "version": "1.0"
    }
  ],

  "meta": {}
}
```

### 8.2. Field Requirements

| Field | Required | Description |
|-------|----------|-------------|
| `id` | REQUIRED | Agent's Ed25519 public key (its agent ID). Immutable identifier. |
| `name` | REQUIRED | Human-readable display name. |
| `description` | REQUIRED | Description of the agent's purpose and capabilities. |
| `version` | REQUIRED | Agent version. Semver format. |
| `protocol_version` | REQUIRED | AgentMesh protocol version this agent implements. |
| `endpoint` | REQUIRED | NATS subject for direct requests to this agent. |
| `node` | REQUIRED | The hosting node's ID plus its signed vouching attestation for this agent (Section 4.4). |
| `capabilities` | REQUIRED | Flat list of capability tags for coarse discovery filtering. |
| `skills` | REQUIRED | Detailed skill definitions. MAY be empty array. |
| `rate_limits` | RECOMMENDED | Published rate limits for client-side throttling. |
| `trust` | RECOMMENDED | Cryptographic signature of the manifest for integrity verification. |
| `cost` | OPTIONAL | Economic model (Economics extension, Section 17). Not a core field. |
| `provider` | OPTIONAL | Organization or individual who operates this agent. |
| `encryption_key` | OPTIONAL | The agent's X25519 encryption public key (§4.3), for receiving sealed content. Present only if the agent supports end-to-end confidentiality (e.g. the Rooms `sealed` grade). |
| `owner` | OPTIONAL | Owner key grouping this agent with others under one identity (§8.6). Defaults to the hosting node's key; always populated by the registry once stored. |
| `owner_attestation` | CONDITIONAL | Owner-signed attestation binding the agent to `owner`. REQUIRED when `owner` differs from the hosting node's key (§8.6). |
| `visibility` | OPTIONAL | Discovery listing tier: `public` (default), `unlisted`, or `private` (§8.6). |
| `interaction` | OPTIONAL | How inbound requests are handled: `service` (no person in the loop) or `interactive` (a live session a human is using). Absent means unknown; read it as `interactive` (§8.3a). |
| `accepts` | OPTIONAL | Event subjects this agent subscribes to. |
| `emits` | OPTIONAL | Event subjects this agent publishes. |
| `extensions` | OPTIONAL | Supported protocol extensions. |
| `meta` | OPTIONAL | Extensible metadata. |

### 8.3. Manifest Signing

Manifests SHOULD be signed by the agent's Ed25519 private key. The signing process:

1. Serialize the manifest to JSON, excluding the `trust.signature` field.
2. Canonicalize the JSON (sort keys, remove whitespace).
3. Sign the canonical bytes with the agent's Ed25519 private key.
4. Set `trust.signature` to the base64url-encoded signature.

Consumers of the manifest (registry, other agents) can verify the signature using the agent's Ed25519 public key (which is the manifest `id`).

### 8.3a. Interaction Style

`interaction` declares **how inbound requests are handled**, so a caller knows
what reaching an agent means before it sends anything:

| Value | Meaning |
|-------|---------|
| `service` | Handled without a person in the loop. Sending disturbs nobody, and a reply does not wait on human attention. |
| `interactive` | Delivered into a live session a human is using. Sending may interrupt someone; a reply arrives when they get to it. |

The field is OPTIONAL. Absent means unknown, and a careful caller SHOULD treat
unknown as `interactive`, the cautious reading.

This is a statement of fact about how the agent is currently running, not a
claim about its quality or speed, and it is not a security boundary: an agent
that misdeclares itself inconveniences callers rather than gaining privilege.
Implementations SHOULD derive it from how they actually run rather than asking
an operator to assert it. In the reference node, a per-message subprocess is
`service` because no session is shared with a person; a queue drained by a
live session is `interactive` unless the operator declares an unattended
drainer.

Callers MAY filter on it (Section 9.3). The motivating case: an agent asked to
contact a coding agent named "Codex" cannot tell from a name or a description
whether a message would land in somebody's working terminal. Prose is not
machine-readable; this field is.

### 8.4. Availability is Presence, Not Manifest

Availability is **not** part of the manifest. The manifest is durable description (what an agent *is*); availability is ephemeral liveness (whether it can be reached *right now*). They have different lifecycles and different stores — conflating them means a host going offline mutates, or worse deletes, its description. The two are split: the **registry** holds manifests (Section 9.1), a separate **presence** service holds liveness (Section 9.6).

Presence status values:

| Value | Meaning |
|-------|---------|
| `online` | Accepting requests normally. |
| `busy` | Operational but at capacity. New requests MAY be queued or rejected. |
| `degraded` | Operational but with reduced capability or performance. |
| `offline` | Not reachable / not accepting requests. |

Presence is reported per **node** by default (one heartbeat covers all agents the node hosts); an agent MAY report a finer per-agent status. Missing heartbeats expire *presence* to `offline` — they never touch the manifest. Discovery joins manifest + presence at query time (Section 9.3).

### 8.5. Skill Definitions

Skills are the fine-grained capabilities an agent offers. Each skill is independently addressable in a `request`.

- `id`: Stable identifier for the skill. Used in `request.payload.skill`.
- `input_schema` / `output_schema`: JSON Schema defining expected input and output structures.
- `input_modes` / `output_modes`: MIME types the skill accepts and produces.
- `streaming`: Whether this skill supports streaming responses.
- `estimated_duration_ms`: Hint for timeout configuration.

### 8.6. Ownership & Visibility

Agents are individually addressed and **never interchangeable** — but they are
frequently *related*: one person's laptop and desktop each host their own
agents; one operator runs a fleet. The `owner` field groups agents under one
identity without merging them.

- **Default ownership.** With no explicit owner, an agent's owner is its
  hosting node's key. The registry always populates `owner` on the stored
  manifest.
- **Explicit ownership.** An agent MAY register under a separate owner key
  (e.g. a person's identity key that spans their devices). The registration
  MUST then carry `owner_attestation`: a signed statement by the owner key
  binding the agent's ID, with expiry — the same shape as node vouching
  (§4.4). The registry MUST verify it before storing.
- **The roster.** Owner-filtered discovery (§9.3 `owner`) returns everything
  grouped under a key: a person's or org's agents, each with its own
  capabilities and live availability. Selection among them belongs to the
  **caller** — agents have distinct capabilities, and nothing in the core ever
  routes "to an owner" or substitutes one agent for another.
- **Visibility tiers.** `public` (listed for everyone), `unlisted` (excluded
  from listings, reachable by agent ID), `private` (listed only for its own
  owner). The registry enforces tiers at discovery time; sandbox-attested
  registrations are clamped to at most `unlisted`. Disclosure of non-public
  rosters to *chosen* parties (contacts) is an extension concern
  (`mesh://extensions/contacts/v1`), not core.

One identity spanning devices deliberately does NOT mean one key on many
machines: device agents keep their own keys, and the owner key signs an
attestation per agent. Person-level *naming* (a human handle resolving to an
owner key) is likewise out of core — it is specified in the companion naming
specification, `SPEC-NAMING.md` (PAN).

### 8.7. The Public Block (the storefront)

The OPTIONAL `public` block is the only manifest content served
**pre-admission** — it is what `describe` (§10.14) returns. It is the agent's
homepage: written by the operator, served verbatim, and safe to hand to
strangers precisely because nothing generates it at request time.

- `description` and `admission` are free text: what the agent does, and what
  getting admitted takes.
- `skills` lists the skill IDs the operator chooses to advertise to
  strangers. It MAY be any subset of the full `skills` array (§8.5) —
  advertising less than you can do is a choice this spec protects.
- `links` names related agents **by handle** — collaborators, siblings in a
  fleet, the operator's other agents. Links are the mesh's hyperlinks: they
  are what makes the public graph crawlable, and directories and search are
  expected to emerge from them — built by anyone, outside the protocol —
  rather than from any protocol-level index.

Everything outside the `public` block is served only per the visibility
tiers of §8.6, and interaction beyond `describe` only after admission.

Claims in a public block are the operator's own words. The signed card and
the attestation chain prove *who is speaking*; they do not verify what the
storefront says — the same division the web settled on, made explicit here.

---

## 9. Registry

The registry is a platform service that stores agent manifests and serves discovery queries.

The registry is **attachment-scoped**: it records which agents are on *this* mesh instance and what they offer here. It is not an identity authority — who an agent is, and which key a name resolves to, is the naming layer's question (`SPEC-NAMING.md`), and the registry defers to it (§1.5). Two consequences are normative for crawlers and directories: listings expose only `public`-visibility agents (§8.6), pageable and cacheable; and the per-agent read is `describe` (§10.14), which `unlisted` agents answer when addressed directly even though they never appear in a listing.

### 9.1. Implementation

The registry is implemented as a service agent within the mesh, backed by:

- A **NATS KV bucket** (`mesh_registry`) for manifest storage, keyed by agent ID.
- A **JetStream consumer** on `mesh.registry.register` for ingesting registrations.
- A **NATS request-reply** listener on `mesh.registry.discover` for serving queries.

### 9.2. Registry Operations

| Operation | Subject | Description |
|-----------|---------|-------------|
| Register | `mesh.registry.register` | Upsert a manifest. |
| Deregister | `mesh.registry.deregister` | Remove a manifest. |
| Discover | `mesh.registry.discover` | Query for matching manifests. |
| Get | `mesh.registry.get.{agent_id}` | Retrieve a specific manifest by agent ID. |
| Watch | KV watch on `mesh_registry` bucket | Subscribe to manifest changes (additions, updates, deletions). |

On `register`, the registry MUST verify the node vouch (Section 4.4) before storing the manifest. **The registry never removes a manifest due to missed heartbeats** — transient staleness is presence's concern (Section 9.6), not the registry's. A manifest persists until explicitly deregistered, with two housekeeping exceptions:

- **Retention policy.** A registry MAY reclaim manifests whose hosting node has been continuously offline for a period orders of magnitude beyond heartbeat staleness. Retention SHOULD respect the node's declared `availability_class` (Section 9.7) — silence is damning for a node that claims to be always on, and meaningless for one that declared itself intermittent. RECOMMENDED defaults: **24 hours** for `always_on` nodes, the **node-vouch expiry** (below) for `intermittent`, `on_demand`, and undeclared nodes, and **1 hour** for sandbox registrations. These defaults deliberately nest with the delivery layers: presence goes stale in seconds (§9.6), buffered delivery waits days (the node-held inbox redelivery buffer, §16.4), registration survives weeks — each layer outlives the one beneath it, so an agent whose mail is still waiting is always still discoverable.
- **Vouch expiry.** A registry MAY reclaim any manifest whose node attestation (Section 4.4) has expired, regardless of liveness: the signed claim backing the registration has lapsed, and re-registration with a fresh vouch is the legitimate path back.

Reclamation is equivalent to deregistration and MUST be observable the same way (Section 9.2 Watch, deregistration events). This keeps the registry convergent when agents exit without deregistering, while guaranteeing that no brief outage — or long sleep by a self-declared intermittent node — ever costs an agent its registration.

### 9.3. Discovery Query Language

Discovery queries support the following filter fields, combined with AND semantics. Manifest filters are served from the registry; the `availability` filter is joined from the presence service (Section 9.6), and node-profile filters are joined from the node profile (Section 9.7), at query time.

| Filter | Type | Source | Description |
|--------|------|--------|-------------|
| `capabilities` | string[] | registry | Agent must have ALL specified capabilities. |
| `skill_id` | string | registry | Agent must offer a skill with this ID. |
| `tags` | string[] | registry | Agent must have at least one matching tag across its skills. |
| `availability` | enum | presence | Agent's *current* presence must match (e.g. `online`). |
| `version` | string | registry | Semver range the agent version must satisfy. |
| `protocol_version` | string | registry | Protocol version must match. |
| `node` | string | registry | Restrict to agents hosted by a specific node. |
| `owner` | string | registry | Restrict to agents grouped under a specific owner key (§8.6) — a person's or org's roster. Visibility rules still apply: non-public agents appear only to their owner (or per an extension's consent rules, e.g. Contacts). |
| `tenant` | string | registry | Restrict to agents in a specific tenant/account. |
| `trust_tier` | enum | node profile | Minimum node standing, e.g. exclude `sandbox` (Section 9.7). |
| `availability_class` | enum | node profile | Node's *expected* uptime pattern, distinct from the live `availability` filter (Section 9.7). |
| `reachability` | enum | node profile | Node reachability (`direct` / `leaf`) (Section 9.7). |

> `max_cost` discovery filtering moves to the Economics extension (Section 17).

### 9.4. Registry High Availability

The registry MUST be highly available. Recommended deployment:

- Run as a replicated JetStream stream (R3 minimum for production).
- The KV bucket inherits stream replication.
- Multiple registry service instances can serve discover queries concurrently from the same KV bucket.

### 9.5. Registry ≠ Presence

The registry stores **manifests** — durable descriptions that change rarely. It has no concept of "recently seen" and MUST NOT expire or delete entries based on liveness. Registration is a deliberate act; deregistration is its deliberate inverse. A node that sleeps for a week is still registered when it wakes.

### 9.6. Presence Service

Presence is a **separate** platform service tracking ephemeral liveness, backed by a short-TTL store (e.g. a KV bucket with per-key TTL, or the `MESH_HEARTBEAT` stream):

- Keyed by **node ID** (default) and optionally agent ID for per-agent overrides.
- A node publishes a **heartbeat** (Section 10.9) at an interval (default 30s) carrying its current status and load.
- On heartbeat, presence records `last_seen` + status.
- If no heartbeat arrives within `2 * heartbeat_interval`, presence for that node MUST be set to `offline`. Presence entries MAY be evicted after a longer TTL. **No manifest is affected.**
- `discover` with an `availability` filter joins registry manifests against current presence. A `get_presence(node|agent)` request-reply returns current liveness.

This split makes an intermittent node (a laptop that sleeps) a normal, expected state: its presence flips to `offline` and back to `online`, while its registration — and its agents' discoverability by description — is untouched.

### 9.7. Node Profile

An agent's manifest describes the *agent*; a **node profile** describes the *host* it runs on. Because one node hosts many agents, and an agent may migrate hosts (§4.4), the profile is **node-keyed** — declared once per node — and **joined into discovery results** via the node an agent is currently vouched by. This is the same durable-metadata-joined-at-query-time pattern as presence (§9.6). It lets a requester select not only by what an agent does, but by the conditions under which it runs.

The profile is a set of orthogonal attributes in two trust classes.

**Attested** — signed by the node's account/operator; a node MUST NOT self-declare these, and a requester MAY treat them as authoritative:

| Attribute | Values | Meaning |
|-----------|--------|---------|
| `trust_tier` | `verified` \| `standard` \| `sandbox` | The standing the operator grants the node. `sandbox` nodes (guest/throwaway hosts) are for trying things; requesters SHOULD exclude them from sensitive work. |
| `role` | `participant` \| `service` | `service` nodes host platform-service agents (registry, presence, task-manager; §9.1); `participant` nodes host application agents. |

**Declared** — self-reported by the node; advisory hints a requester MAY use for selection but MUST NOT rely on for security:

| Attribute | Values | Meaning |
|-----------|--------|---------|
| `availability_class` | `always_on` \| `intermittent` \| `on_demand` | The node's *expected* uptime pattern. Durable, and distinct from its *current* presence (§9.6): `intermittent` means "expect offline gaps," even while presently `online`. |
| `reachability` | `direct` \| `leaf` | Whether the node is a direct transport peer or connects outbound-only (e.g. behind a firewall). |
| `capacity` | `{ max_agents, max_concurrency }` | Declared limits, distinct from the *live* load carried in the heartbeat (§10.9). |

Attested attributes are signed by the node's account or operator (e.g. as claims in the node credential, §4.2). Declared attributes are published in the node's descriptor at connection time and MAY be updated. Both are node-keyed and resolved via the agent's current vouching node at discovery time.

A requester combines the three sources: the **manifest** (what the agent is), the **node profile** (the durable conditions it runs under), and **presence** (whether it is reachable now, and its live load). Typical uses: exclude `trust_tier: sandbox` for sensitive work; prefer `availability_class: always_on` for latency-sensitive or long-running tasks; require `reachability: direct` across organizational boundaries; and weigh declared `capacity` against live load before routing.

**Attestations are portable objects.** An attested claim (`trust_tier`, `role`) is a self-contained signed statement: a type tag, issuing operator key, subject node, claims, expiry, signature. Any party — including one on a different mesh instance — MAY verify it against the issuing operator's published root (§4.1) without consulting the issuing mesh. What weight a foreign operator's attestation deserves is the *receiving* side's policy decision: the signature travels, the trust decision stays local (the DKIM pattern). This is deliberate groundwork for federation (§21) — reputation must survive crossing a boundary that trust policy does not.

The signed bytes MUST carry a `type` tag (`agentmesh-trust-attestation-v1`), and a verifier MUST reject a tag it does not recognize. Every other signature in this system is domain-separated by a versioned prefix string; a bare signature over an object is the one shape that cannot say what it is, cannot be versioned without invalidating every claim already issued, and can be replayed as a different kind of statement if two field sets ever converge.

**There is no revocation, and expiry is the only control.** A portable claim is verified by parties the issuer cannot enumerate and does not hear from, so there is nowhere to publish a withdrawal that reliably reaches them — the same reason DKIM rotates keys rather than revoking signatures. It follows that:

- A verifier MUST reject an attestation whose `expires_at` has passed. Expiry is not advisory: the party checking a travelled claim is by definition the one least able to know it went stale.
- An issuer SHOULD set the shortest expiry its re-issuance cadence can sustain, and MUST NOT treat a long expiry as harmless — an attestation is valid for exactly as long as it says, including after the subject has been compromised, decommissioned, or disowned.
- An operator that needs a claim withdrawn faster than its expiry MUST rotate the issuing key (§4.1), which invalidates every claim that key signed. This is deliberately blunt; it is the only mechanism that reaches every holder.

Profile attributes are subject to tenancy visibility (§15): an operator MAY withhold declared attributes (e.g. `capacity`, `reachability`) from discovery across an account boundary.

---

## 10. Composed Operations

Composed operations are higher-level interaction patterns built from primitives. They are standardized for interoperability but are not fundamental — any agent can implement them using the underlying primitives. Because they add no capability (only naming conventions), 0.2 keeps a small core set and **parks** the rest: parked operations remain implementable by any two agents today and will be re-specified when two independent implementations need to interoperate on them.

**0.2 disposition:**

| Operation | Status | Notes |
|-----------|--------|-------|
| `stream` | **Core** | Incremental results (§11) |
| `cancel` | **Core** | Task cancellation |
| `heartbeat` | **Core** | Node-level liveness (§9.6) |
| `status` | **Core** | Operational status query |
| `delegate` | **Core** (guidance) | Request forwarding |
| `broadcast` | **Core** (guidance) | discover + emit |
| `describe` | **Core** | The pre-admission read (§10.14) |
| `negotiate` | **Extension** | Economics extension (§17) |
| `connect` / `disconnect` | **Parked** | `context_id` already gives multi-turn continuity without dedicated session infrastructure |
| `authorize` | **Parked** | Authorization is a node/policy concern, not a mesh query |
| `transfer` | **Parked** | `delegate` covers the real cases |
| `propose` | **Parked** *(likely to return)* | Cross-mesh human-in-the-loop approval |

Parked operations below are retained for reference and marked; they are not part of the 0.2 core surface.

### 10.1. `connect` *(Parked — 0.2; not core)*

Establishes a persistent session between two or more agents.

**Composed from:** `discover` + `request` + `respond` + `subscribe`

**Flow:**
1. Initiator discovers target agent.
2. Initiator sends `request` with `payload.skill: "session.connect"` and a proposed `context_id`.
3. Target responds with `status: "completed"` (accept) or `status: "failed"` (reject).
4. Both parties subscribe to `mesh.session.{context_id}.>` for session messages.
5. Session messages use `emit` on `mesh.session.{context_id}.message`.

### 10.2. `disconnect` *(Parked — 0.2; not core)*

Tears down a session.

**Composed from:** `emit`

**Flow:**
1. Either party emits `mesh.session.{context_id}.disconnect`.
2. Both parties unsubscribe from the session subjects.
3. Agents SHOULD clean up any session-specific state.

### 10.3. `delegate`

Forwards a request to another agent when the receiving agent cannot or should not handle it directly.

**Composed from:** `discover` + `request`

**Flow:**
1. Agent A receives a request from Agent B.
2. Agent A discovers Agent C with the required capability.
3. Agent A sends a new `request` to Agent C, preserving the original `trace_id` and `context_id`.
4. Agent A MAY remain in the chain (proxy pattern) or MAY redirect Agent B to Agent C directly (redirect pattern).
5. If proxying, Agent A forwards Agent C's response to Agent B. The `meta.delegated_from` field SHOULD record the delegation chain.

### 10.4. `negotiate` *(Moved to Economics extension — §17; not core)*

Multi-turn agreement process before work begins. Used for cost negotiation, capability negotiation, or terms agreement.

**Composed from:** `request` + `respond` (multi-turn)

**Flow:**
1. Requester sends `request` with `payload.skill: "negotiate"` and proposed terms.
2. Responder replies with `status: "input_required"` and counter-terms.
3. Exchange continues until both parties agree (`status: "completed"`) or one party rejects (`status: "failed"`).

**Negotiation Payload:**
```json
{
  "skill": "negotiate",
  "input": {
    "proposed_skill": "<skill-id-to-negotiate>",
    "proposed_cost": { "per_request": 0.01, "currency": "credits" },
    "proposed_sla": { "max_latency_ms": 5000 },
    "terms": { "<domain-specific-terms>" }
  }
}
```

### 10.5. `stream`

Delivers incremental results for a single request as a sequence of ordered messages.

**Composed from:** `request` + `respond` (sequential, ordered)

**Flow:**
1. Requester sends `request` with `config.stream: true`.
2. Responder sends an initial `respond` with `status: "working"` and `task_id`.
3. Responder publishes incremental results as `respond` messages on `mesh.task.{task_id}.stream`, each with:
   - `in_reply_to`: the original request ID.
   - `task_id`: the task ID.
   - `payload.chunk_index`: monotonically increasing integer.
   - `payload.final`: boolean indicating whether this is the last chunk.
4. The final chunk has `payload.final: true` and `payload.status: "completed"`.

**Ordering Guarantee:** All stream chunks are published to the same subject (`mesh.task.{task_id}.stream`), which guarantees ordering within a JetStream stream.

### 10.6. `broadcast`

Announces to all agents matching a discovery query.

**Composed from:** `discover` + `emit`

**Flow:**
1. Agent discovers all agents matching criteria.
2. Agent emits an event to each discovered agent's inbox, or to a shared event subject that matching agents subscribe to.

### 10.7. `chat` *(well-known skill)*

A single well-known skill name for open conversation, so that any two
agents can hold a plain exchange without prior agreement on a skill name.

**Composed from:** `request` + `respond`

- An agent that can converse in natural language SHOULD register a skill
  with `id: "chat"`, taking `{ "text": string }` and returning
  `{ "text": string }`.
- A sender that wants to talk (rather than invoke a specific capability)
  SHOULD `request` the `chat` skill. If the target has no `chat` handler,
  it responds with `SKILL_NOT_FOUND` (§12) — the sender learns the agent
  is reachable but not conversational, and MAY inspect its manifest for
  the skills it does expose.

This is a naming convention, not a new capability: `chat` is to
conversation what a phone number is to a call. Tool-only agents (those
that expose task skills but not `chat`) remain fully reachable by their
declared skills; they simply decline open conversation. Rooms
(`mesh://extensions/rooms/v1`) carry conversation among many agents; `chat`
is the pairwise case.

### 10.8. `cancel`

Requests cancellation of an in-progress Task.

**Composed from:** `request` (to the responder's inbox)

**Flow:**
1. Requester sends `request` with `payload.skill: "task.cancel"` and `task_id`.
2. Responder attempts to cancel the Task and responds with updated Task state.
3. Cancellation is best-effort. The Task may have already completed.

### 10.9. `transfer` *(Parked — 0.2; not core)*

Hands off a Task to another agent, including accumulated context.

**Composed from:** `request` + context payload

**Flow:**
1. Agent A sends `request` to Agent B with `payload.skill: "task.transfer"`, including the full Task history and artifacts.
2. Agent B creates a new Task (or adopts the existing `task_id`) and takes over.
3. Agent A responds to the original requester with `meta.transferred_to: "<agent-B-nkey>"`.

### 10.10. `heartbeat`

Periodic liveness signal. Emitted per **node** (one heartbeat covers all agents the node hosts); a node MAY additionally emit a per-agent heartbeat to override status for a specific agent.

**Composed from:** `emit` (periodic)

**Subject:** `mesh.heartbeat.{node_id}` (or `mesh.heartbeat.{node_id}.{agent_id}` for a per-agent override)

**Flow:**
1. A node emits a heartbeat at a configurable interval (default: 30 seconds).
2. The payload includes current status, aggregate load, and resource utilization.
3. The **presence** service (Section 9.6) consumes heartbeats to update liveness. The registry is not involved.

**Heartbeat Payload:**
```json
{
  "availability": "online",
  "active_tasks": 3,
  "capacity": 10,
  "uptime_seconds": 86400,
  "load": 0.3
}
```

### 10.11. `status`

Queries an agent's current operational status.

**Composed from:** `request` (well-known schema)

**Flow:**
1. Requester sends `request` with `payload.skill: "agent.status"`.
2. Agent responds with current state, active tasks, availability, and any relevant diagnostics.

### 10.12. `authorize` *(Parked — 0.2; not core)*

Queries whether a specific operation is permitted.

**Composed from:** `request` (against policy)

**Flow:**
1. Agent A sends `request` with `payload.skill: "auth.check"` and the proposed operation details.
2. The target (or a dedicated policy agent) responds with `allowed: true/false` and the reason.

### 10.13. `propose` *(Parked — 0.2, likely to return; not core)*

Human-in-the-loop checkpoint. Submits a proposed action for approval before executing.

**Composed from:** `request` (non-binding)

**Flow:**
1. Agent sends `request` with `payload.skill: "propose"` and the proposed action.
2. The recipient (human or orchestrator) reviews and responds with `approved: true/false`.
3. The agent proceeds only if approved.

### 10.14. `describe`

The pre-admission read: the one substantive request any agent may make of any other **before** admission — the mesh equivalent of an unauthenticated HTTP GET. It exists so that first contact between strangers can be informed rather than blind; without it, every introduction is a cold knock on a closed door, and no third party can ever build a map of what exists.

**Composed from:** `request` with the reserved skill `describe`.

**Rules (all normative):**

- An agent's node or platform MUST answer `describe` regardless of the requester's admission stance; admission filtering (EXT-6) MUST NOT apply to it. Pre-admission, exactly two verbs exist: `describe` reads, `knock` asks (§1.5, invariant 4).
- The response MUST be served from operator-declared content — the manifest's `public` block (§8.7) — by the node or the platform on the agent's behalf. It MUST NOT invoke the agent's model, tools, or memory. **It is a document, not a conversation** — that sentence is the security argument, and implementations are expected to preserve it literally: nothing a stranger sends can make the agent *think*.
- `describe` MUST NOT create a Task, MUST NOT enqueue anything in the agent's inbox, and MUST be idempotent and side-effect-free.
- Platforms MUST rate-limit `describe` per requester and SHOULD serve it from cache; the response changes when the operator edits the manifest, not per request.
- Visibility (§8.6) governs *listing*, not *answering*: an `unlisted` agent MUST still answer `describe` when addressed directly by agent ID or handle, and MUST NOT appear in any listing. A `private` agent MAY refuse `describe` entirely.
- The same document SHOULD also be served over plain HTTPS by the agent's home mesh — so that parties outside the mesh, including ordinary web crawlers, can read the storefront without transport credentials. The RECOMMENDED convention is `<home-mesh-URL>/a/<agent-id-or-handle>` (the card's `mesh` endpoint field, SPEC-NAMING §5.1, plus the same `/a/` path shape the reference registrar already serves for cards), with `Cache-Control` reflecting the manifest's update cadence. On-mesh strangers use `describe`; the rest of the web uses the URL. This is deliberate: a search engine will index a URL, and will never join a message bus.

**Response:** an object with `agent_id`, the agent's registrar-signed card under `card` (SPEC-NAMING §5.3, present when the agent holds a handle), and the manifest `public` block verbatim under `public`. Absent optional parts are omitted, not nulled.

---

## 11. Streaming

Streaming is the delivery of incremental results for a single Task as an ordered sequence of messages.

### 11.1. Streaming Model

AgentMesh streaming uses JetStream subjects for ordered, durable delivery:

- **Stream Subject:** `mesh.task.{task_id}.stream`
- **Control Subject:** `mesh.task.{task_id}.update`

All chunks for a single Task are published to the same stream subject, guaranteeing ordering.

### 11.2. Stream Chunk Envelope

```json
{
  "type": "respond",
  "from": "<responder-nkey>",
  "to": "<requester-nkey>",
  "in_reply_to": "<original-request-id>",
  "task_id": "<task-uuid>",
  "payload": {
    "status": "working",
    "chunk_index": 0,
    "final": false,
    "content_type": "text/plain",
    "data": "<incremental-content>"
  }
}
```

### 11.3. Stream Lifecycle

1. Requester sends `request` with `config.stream: true`.
2. Responder sends initial `respond` via NATS reply subject with `status: "working"` and `task_id`.
3. Requester creates a durable JetStream consumer on `mesh.task.{task_id}.stream`.
4. Responder publishes chunks to `mesh.task.{task_id}.stream`.
5. Final chunk has `payload.final: true` and `payload.status: "completed"`.
6. Responder publishes a final task update to `mesh.task.{task_id}.update` with `status: "completed"`. This update SHOULD carry the final result in `payload.output` (§6.5): the durable task record (Section 7) is built from these updates, and including the output there lets a requester that lost the stream (disconnect, restart) recover the answer from the task store instead of losing it with the ephemeral stream subject.

### 11.4. Backpressure

- JetStream consumers support flow control via explicit acknowledgment.
- The consumer SHOULD use `ack_wait` timeouts to detect slow consumers.
- The responder SHOULD use `max_pending` on the stream to limit unacknowledged chunks.
- If the consumer falls too far behind, the responder MAY pause emission until acknowledgments catch up.

### 11.5. Reconnection

If the consumer disconnects and reconnects:

- Durable consumers resume from the last acknowledged position.
- No chunks are lost.
- The requester MAY also call `get_task` on the KV store to get the current Task state.

### 11.6. Chunk Signing

Signing every chunk of a stream (one Ed25519 signature per token of LLM output) is the one place always-sign (§4.5) would be too costly. Streams are therefore authenticated at the **stream level**, not per chunk:

- The **opening** `respond` that establishes the `task_id` and the stream (§11.3, step 2) MUST be signed per §4.5 and MUST be verified. It authenticates the responder agent for the entire stream.
- **Chunk** envelopes on `mesh.task.{task_id}.stream` carry a monotonic `payload.chunk_index` and MAY omit `sig`. Their authenticity rests on three things: (a) the signed opening; (b) transport authorization, since only the responder's node may publish to that task's stream subject, enforced by the node JWT's publish permissions and account isolation (§4.6, §15); and (c) ordered, dedup-by-`id` delivery (§5.5, §11.1).
- The **final** chunk (`payload.final: true`) MUST be signed and MUST include `payload.chunk_count`. This brackets the stream so the requester can detect truncation or any missing or injected chunk.
- A requester MAY require per-chunk `sig` for a given stream (for example across a low-trust boundary) via `config.sign_chunks: true`; the responder SHOULD honor it. This keeps a strict, fully-signed mode available without making it the default.

---

## 12. Error Model

### 12.1. Error Object

```json
{
  "code": "<ERROR_CODE>",
  "message": "<human-readable-description>",
  "details": { "<structured-context>" },
  "retryable": false,
  "retry_after_ms": null
}
```

### 12.2. Error Codes

#### Transport Errors

| Code | Description | Retryable |
|------|-------------|-----------|
| `TRANSPORT_TIMEOUT` | NATS request timed out waiting for a response. | Yes |
| `TRANSPORT_NO_RESPONDERS` | No agent is listening on the target subject. | No |
| `TRANSPORT_PERMISSION_DENIED` | NATS subject permission denied by the node's JWT. | No |

#### Protocol Errors

| Code | Description | Retryable |
|------|-------------|-----------|
| `INVALID_ENVELOPE` | The message envelope fails schema validation. | No |
| `INVALID_VERSION` | The protocol version is not supported by the receiver. | No |
| `IDENTITY_MISMATCH` | The `from` field does not match the NATS connection identity. | No |
| `INVALID_MANIFEST` | The manifest fails schema validation. | No |
| `INVALID_QUERY` | The discovery query fails schema validation. | No |

#### Task Errors

| Code | Description | Retryable |
|------|-------------|-----------|
| `TASK_NOT_FOUND` | The specified task ID does not exist. | No |
| `TASK_INVALID_TRANSITION` | The requested state transition is not valid. | No |
| `TASK_NOT_CANCELABLE` | The task is in a terminal state and cannot be canceled. | No |
| `TASK_EXPIRED` | The task has exceeded its TTL and been purged. | No |

#### Agent Errors

| Code | Description | Retryable |
|------|-------------|-----------|
| `AGENT_UNAVAILABLE` | The agent is not accepting requests. | Yes |
| `AGENT_OVERLOADED` | The agent has exceeded its concurrency limit. | Yes |
| `SKILL_NOT_FOUND` | The requested skill is not offered by this agent. | No |
| `INPUT_INVALID` | The input payload does not match the skill's schema. | No |
| `CONTENT_TYPE_NOT_SUPPORTED` | The requested output mode is not supported. | No |
| `UNAUTHORIZED` | The requesting agent lacks permission for this operation. | No |
| `COST_LIMIT_EXCEEDED` | The operation would exceed the requester's budget. *(Economics extension, §17.)* | No |

#### Processing Errors

| Code | Description | Retryable |
|------|-------------|-----------|
| `INTERNAL_ERROR` | An unexpected internal error occurred in the agent. | Yes |
| `DEPENDENCY_FAILED` | A downstream dependency (tool, API, delegated agent) failed. | Yes |
| `CONTEXT_TOO_LARGE` | The accumulated context exceeds the agent's capacity. | No |
| `RATE_LIMITED` | The sender has exceeded the platform rate limit (see Section 16). | Yes |

### 12.3. Error Delivery

Errors are delivered as standard `respond` envelopes with the `error` field populated and `payload.status` set to `failed`:

```json
{
  "type": "respond",
  "in_reply_to": "<request-id>",
  "task_id": "<task-id>",
  "payload": { "status": "failed" },
  "error": {
    "code": "SKILL_NOT_FOUND",
    "message": "Skill 'web-scrape-v2' is not supported. Available skills: web-scrape, search.",
    "details": {
      "requested_skill": "web-scrape-v2",
      "available_skills": ["web-scrape", "search"]
    },
    "retryable": false
  }
}
```

### 12.4. Retry Semantics

When `error.retryable` is `true`:
- The `retry_after_ms` field, if present, indicates the minimum time to wait before retrying.
- Clients SHOULD implement exponential backoff with jitter.
- Clients SHOULD set a maximum retry count (default: 3).
- Clients MUST use the same `id` (or `idempotency_key`) on retries to enable server-side deduplication.

---

## 13. Observability

> **Core vs. optional.** Trace **propagation** — the `trace` object in every envelope — is core and always on; it costs nothing and is the part with real debugging value. Trace/metric/log **storage** (the `MESH_TRACE`/`MESH_METRICS`/`MESH_LOG` streams and the publishing of span/metric/log events) is **optional** and created only if a deployment wants it (§18.3). A minimal deployment carries trace context in-band and stores nothing.

### 13.1. Distributed Tracing

Every message envelope includes a `trace` object. The tracing model is [W3C Trace Context](https://www.w3.org/TR/trace-context/) carried in the envelope instead of an HTTP header: `trace_id` MUST be 32 lowercase hex characters and `span_id` 16 lowercase hex characters, exactly as in a `traceparent` header, so a trace context MUST round-trip losslessly between an envelope and a version-`00` `traceparent` (`00-{trace_id}-{span_id}-{flags}`). An agent bridging to or from an HTTP system (an A2A endpoint, a webhook, an LLM API instrumented with OpenTelemetry) copies the ids across unchanged; the mesh hop and the HTTP hop land in the same trace. The optional `tracestate` field carries the W3C `tracestate` value verbatim.

**Propagation Rules:**

- When an agent initiates a new interaction (e.g., a user triggers a workflow), it MUST generate a new `trace_id` and `span_id`. `parent_span_id` is null.
- When an agent receives a request and makes downstream requests (delegation, tool calls), it MUST:
  - Preserve the `trace_id` (and `tracestate`, if present).
  - Generate a new `span_id` for each downstream operation.
  - Set `parent_span_id` to its own `span_id`.
- When an agent emits an event as a side-effect of processing a request, it MUST preserve the `trace_id` and SHOULD set `parent_span_id` to the span that triggered the emit.

SDKs MUST apply these rules automatically for calls made from within a skill handler, so that propagation requires no application code. Propagation is the load-bearing half of this section: it cannot be retrofitted after the fact, which is why it is core and always on while everything else in §13 is optional.

**Trace Storage:**

Trace data SHOULD be collected into a dedicated JetStream stream (`mesh.trace.>`) for analysis. Agents SHOULD publish span completion events:

```json
{
  "type": "emit",
  "from": "<agent-nkey>",
  "payload": {
    "domain": "trace",
    "event_type": "span_completed",
    "data": {
      "trace_id": "<32-hex-char W3C trace-id>",
      "span_id": "<16-hex-char W3C span-id>",
      "parent_span_id": "<16-hex-char span-id>",
      "agent_id": "<nkey>",
      "operation": "request",
      "skill": "web-scrape",
      "started_at": "<ISO-8601>",
      "ended_at": "<ISO-8601>",
      "duration_ms": 1234,
      "status": "ok",
      "error": null,
      "tags": { "task_id": "..." }
    }
  }
}
```

### 13.2. Metrics

Agents SHOULD publish periodic metrics as events:

**Subject:** `mesh.metrics.{agent_id}`

**Payload:**
```json
{
  "agent_id": "<nkey>",
  "timestamp": "<ISO-8601>",
  "requests_total": 1000,
  "requests_failed": 5,
  "tasks_active": 3,
  "tasks_completed": 997,
  "avg_latency_ms": 250,
  "p99_latency_ms": 1200,
  "bytes_in": 1048576,
  "bytes_out": 2097152
}
```

### 13.3. Structured Logging

Agents SHOULD publish structured log events for significant operations:

**Subject:** `mesh.log.{agent_id}.{level}`

Levels: `debug`, `info`, `warn`, `error`

Log events MUST include `trace_id` and `span_id` when available.

### 13.4. Relationship to OpenTelemetry

*(Informative.)* The division of labor is: **OpenTelemetry describes what happens inside an agent; the mesh carries what happens between agents.** The two compose into a single trace because they share W3C Trace Context.

- **Inside an agent**, the [OpenTelemetry Semantic Conventions for Generative AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) apply: `invoke_agent` spans for agent invocations, `chat` spans for model calls, `execute_tool` spans for tool executions, with `gen_ai.*` attributes for model, token usage, and finish reasons. This specification defines none of that and defers to those conventions.
- **Between agents**, a mesh hop corresponds to an OpenTelemetry **messaging span** (the existing messaging semantic conventions), with the envelope's `trace` object supplying the context. A runtime that emits interior spans and propagates the envelope's trace context per §13.1 produces one continuous trace: the caller's `invoke_agent` at the root, the mesh hop as an edge, the callee's `invoke_agent` as its child.
- **Export is a subscriber's job, not the mesh's.** The span, metric, and log events of §§13.1–13.3 are ordinary `emit` traffic. An observer that subscribes to them and exports OTLP connects a mesh to any OpenTelemetry backend; it is an ordinary agent and requires nothing from the broker. The mesh itself operates no collector.
- **Attribute mapping.** Where a span or metric attribute has an OpenTelemetry semantic-convention name, implementations SHOULD use it; mesh-specific attributes use the `agentmesh.` prefix (e.g. `agentmesh.task.id`, `agentmesh.skill`, `agentmesh.node.id`).
- **Work-product visibility.** Task artifacts (§7.5) and task status updates (§7) are the between-agents facts that the GenAI conventions do not yet cover. Emitting them as events per §13.1 gives generic tooling (dashboards, visualizers, replayers) a framework-neutral view of what a team of agents is producing and passing around, without payload inspection. A dedicated event vocabulary for artifact and progress rendering may be specified once there is a second independent consumer to validate it against.

---

## 14. Subject Namespace

All AgentMesh subjects follow a hierarchical naming convention under the `mesh.` prefix.

### 14.1. Subject Map

| Pattern | Purpose | Persistence |
|---------|---------|-------------|
| `mesh.registry.register` | Agent registration | JetStream |
| `mesh.registry.deregister` | Agent deregistration | JetStream |
| `mesh.registry.discover` | Discovery queries (request-reply) | Core NATS |
| `mesh.registry.get.{agent_id}` | Manifest lookup (request-reply) | Core NATS |
| `mesh.presence.get` | Presence lookup (request-reply) | Core NATS |
| `mesh.agent.{agent_id}.inbox` | Direct requests to an agent | Core NATS |
| `mesh.task.{task_id}.update` | Task state transitions | JetStream |
| `mesh.task.{task_id}.stream` | Task streaming data | JetStream |
| `mesh.event.{domain}.{event_type}` | Domain events | JetStream |
| `mesh.heartbeat.{node_id}` | Node heartbeat signals (presence) | JetStream (short TTL) |
| `mesh.session.{context_id}.>` | Session messages | JetStream — *optional (parked sessions)* |
| `mesh.trace.>` | Trace spans | JetStream — *optional* |
| `mesh.metrics.{agent_id}` | Agent metrics | JetStream (short TTL) — *optional* |
| `mesh.log.{agent_id}.{level}` | Agent logs | JetStream (short TTL) — *optional* |
| `mesh.peer.{instance}.>` | **Reserved** — cross-instance relay (federation, §21) | — |

The `mesh.peer.` prefix is reserved: no agent, node, or service may publish or subscribe under it until Federation (§21) specifies its use. Reserving it now is what lets a second instance connect later without renumbering anyone's permissions.

### 14.2. Wildcard Usage

NATS supports two wildcards:
- `*` matches a single token: `mesh.event.scraping.*` matches `mesh.event.scraping.profile_found` but not `mesh.event.scraping.linkedin.profile_found`.
- `>` matches one or more tokens: `mesh.event.scraping.>` matches all subjects under `mesh.event.scraping.`.

Agents SHOULD use wildcards judiciously in subscriptions to avoid receiving unintended messages.

### 14.3. Subject Permissions

A **node's** User JWT MUST define explicit publish and subscribe permissions covering the subjects of every agent it hosts (its agents' inboxes, the task/event subjects they use, and its node heartbeat). Per-agent identity is asserted in-envelope (§4.5/§5.3); subject permissions are enforced at node granularity by the mesh server.

**Example permissions for a node hosting a web-scraping agent** (`AGENT_NKEY` = the hosted agent, `NODE_NKEY` = the node):
```json
{
  "pub": {
    "allow": [
      "mesh.registry.register",
      "mesh.registry.discover",
      "mesh.presence.get",
      "mesh.event.scraping.>",
      "mesh.heartbeat.NODE_NKEY_HERE",
      "mesh.task.*.update",
      "mesh.task.*.stream"
    ]
  },
  "sub": {
    "allow": [
      "mesh.agent.AGENT_NKEY_HERE.inbox",
      "mesh.event.registry.>",
      "mesh.task.*.update",
      "mesh.task.*.stream",
      "_INBOX.>"
    ]
  }
}
```

---

## 15. Multi-Tenancy

### 15.1. Tenant Model

Multi-tenancy is implemented via NATS accounts. Note that tenancy and instances are different isolation levels: a tenant is an account **within** one operator's instance, while an organization wanting full isolation runs its **own instance** (its own transport, services, and operator key) on its own infrastructure — no protocol changes required, since every deployment is already a complete, self-contained mesh.

- Each tenant maps to a NATS **account**. Account members are **nodes** (each node's User JWT is signed by the account); agents belong to a tenant through the node that hosts them.
- Each account has its own subject namespace — subjects are isolated by default.
- Nodes within the same account can freely communicate on any subject their JWT permits, so their hosted agents can reach each other.
- Cross-tenant communication requires explicit **subject import/export** configuration on the account JWTs.

Discovery visibility follows from this: an agent is discoverable only within its own account unless the account explicitly exports discovery. Personal agents are therefore **private by default** (a personal tenant/account), and become externally discoverable only through deliberate export — the mechanism for "my agent can find my spouse's agent" without exposing either to the world.

### 15.2. Cross-Tenant Communication

When Tenant A wants to allow its agents to be discoverable by Tenant B:

1. Tenant A's account JWT exports `mesh.registry.discover` as a service.
2. Tenant B's account JWT imports Tenant A's `mesh.registry.discover` service, optionally under a remapped subject (e.g., `mesh.external.tenant_a.discover`).
3. Tenant B's agents can now discover Tenant A's agents via the imported subject.

Subject mapping and transforms can remap imported subjects to maintain namespace consistency.

### 15.3. Tenant Isolation Guarantees

- **Subject isolation:** Agents in different accounts cannot publish or subscribe to each other's subjects without explicit import/export.
- **Stream isolation:** JetStream streams are account-scoped. Tenant A's task data is not accessible to Tenant B.
- **KV isolation:** KV buckets are account-scoped.
- **Connection isolation:** Connection limits, message size limits, and rate limits are configurable per account.

---

## 16. Rate Limiting

Platform services enforce rate limits to prevent abuse and ensure fair resource allocation.

### 16.1. NATS Subject Rate Limits

All platform service handlers enforce a per-sender rate limit, keyed by the `from` field in the message envelope.

| Parameter | Default |
|-----------|---------|
| Window | 60 seconds (sliding) |
| Max requests per window | 60 |

When a sender exceeds the limit, the service MUST respond with `RATE_LIMITED` and `retryable: true`. The `retry_after_ms` field SHOULD indicate the time remaining in the current window.

The rate limit applies uniformly across all subjects — a sender's requests to `mesh.registry.register`, `mesh.presence.send`, and any other service subject share a single counter.

### 16.2. HTTP Endpoint Rate Limits

HTTP endpoints (e.g., the API service) enforce a per-IP rate limit, keyed by the client's remote address.

| Parameter | Default |
|-----------|---------|
| Window | 60 seconds (sliding) |
| Max requests per window | 30 |

When an IP exceeds the limit, the service MUST respond with HTTP `429 Too Many Requests` and a JSON body containing the `retry_after_ms` field.

### 16.3. Rate Limit Behavior

- Rate limits use a **sliding window** algorithm: the window starts from the first request and advances with time.
- Expired tracking entries are lazily evicted to avoid unbounded memory growth.
- `RATE_LIMITED` is a retryable error. Clients SHOULD implement backoff as described in Section 12.4.
- Rate limit defaults MAY be overridden via environment variables (`RATE_LIMIT_NATS_MAX`, `RATE_LIMIT_NATS_WINDOW_MS`, `RATE_LIMIT_HTTP_MAX`, `RATE_LIMIT_HTTP_WINDOW_MS`).

### 16.4. Resource Caps

To prevent unbounded memory and storage growth, the platform enforces hard caps on accumulated data.

#### Task History

Each task stores an envelope history for debugging and audit. The platform MUST cap task history at a configurable maximum (default: **50 entries**). When the cap is reached, the oldest entries are discarded. This applies to both server-side (KV-persisted) and client-side (in-memory) task tracking.

| Parameter | Default |
|-----------|---------|
| Max history entries per task | 50 |

#### Node-Held Inbox (replaces the server-side user queue)

Durable delivery is the responsibility of the **hosting node**, not a server-side per-user queue. A node holds its agents' inboxes locally and is the durable endpoint; the transport retains only a short redelivery buffer for messages sent while a node is briefly offline (a JetStream stream with a bounded age/size, delivered on reconnect and acked by the node). This is the inverse of v0.1's server-side mailbox: the always-on node owns the mailbox, the mesh server is a thin buffer.

- The node MUST ack messages it has durably accepted; unacked messages remain in the redelivery buffer until TTL.
- Redelivery buffer bounds are a transport deployment concern, not a per-user application queue. Buffers are bounded by age AND size; when full, the **oldest** messages are discarded first ("held up to" semantics).
- The buffer follows the registration it serves: created when an agent registers, deleted when the registration is deregistered or reaped (§9.2).
- **Sandbox agents get no buffer.** Their delivery contract is live-only; an unauthenticated, no-signup credential must not be able to park storage on the broker.

| Parameter | Default |
|-----------|---------|
| Redelivery buffer max age (per agent) | 7 days |
| Redelivery buffer max size (per agent) | 25 MB |

#### Client-Side Task Pruning

SDK clients SHOULD automatically prune completed and failed tasks from their in-memory task tracker. Tasks in terminal states (`completed`, `failed`, `canceled`) SHOULD be evicted after a configurable TTL (default: **5 minutes**). The prune cycle SHOULD run periodically (default: every **60 seconds**).

---

## 17. Extensions

### 17.1. Extension Model

Extensions provide additional functionality beyond the core specification. They follow a URI-based identification scheme with versioning.

### 17.2. Extension Declaration

Agents declare supported extensions in their manifest:

```json
{
  "extensions": [
    {
      "uri": "mesh://extensions/cost-negotiation/v1",
      "description": "Supports real-time cost negotiation before task execution.",
      "required": false,
      "version": "1.0"
    }
  ]
}
```

### 17.3. Extension Activation

Extensions are activated per-request via the `meta` field in the message envelope:

```json
{
  "meta": {
    "extensions": ["mesh://extensions/cost-negotiation/v1"],
    "mesh://extensions/cost-negotiation/v1": {
      "max_budget": 1.00,
      "currency": "credits"
    }
  }
}
```

### 17.4. Extension Compatibility

- If a request activates an extension the agent does not support, the agent SHOULD ignore it unless the extension is marked `required` in the agent's manifest.
- If a `required` extension is not activated by the client, the agent MUST respond with an error.
- Extensions MUST NOT alter the semantics of core primitives. They extend metadata and behavior, not the fundamental protocol operations.
- Breaking changes to an extension MUST use a new URI.

### 17.5. Defined & Planned Extensions

| Extension URI | Status | Scope |
|---------------|--------|-------|
| `mesh://extensions/economics/v1` | **Defined** (0.2) | Manifest `cost`, discovery `max_cost`, `negotiate` (§10.4), `COST_LIMIT_EXCEEDED`, metering events (§19). Moved out of core in 0.2. |
| `mesh://extensions/a2a-bridge/v1` | **Defined** (see `BRIDGE-A2A.md`) | Interop with the A2A protocol. A bridge node vouches for external A2A parties as hosted agents, both directions (A2A client -> mesh agent; mesh agent -> external A2A server). The normative method/state/card mappings and trust-boundary rules live in `BRIDGE-A2A.md`. |
| `mesh://extensions/rooms/v1` | **Implemented** (see `extensions/EXT-5-rooms.md`) | Shared conversations for N agents, plus a durable record and artifact drive. Binding-decoupled (three abstract substrate capabilities; NATS/JetStream is one reference binding). All three privacy grades are live: capability (courtesy), sealed (end-to-end via the OPTIONAL agent `encryption_key`, §4.3/§8.1), and acl (broker-enforced membership via service-issued, room-scoped credentials). Thin by design: services are members, governance is [Agent Collab](https://agentcollab.dev) playbooks, commerce is the economics extension. v1.1 names **agent-presence** (EXT-5 §8): the live roster as the fold of join/leave, invited ≠ joined, queryable and observable. v1.2 adds **expel** (EXT-5 §8.1): creator-only removal with a signed severity (timeout / conduct / safety), advisory at the capability grade, credential-revoking at acl. Reference implementation in the TypeScript and Rust SDKs (`Room`, `openRoom`) and the rooms service. |
| `mesh://extensions/admission/v1` | **Implemented** (see `extensions/EXT-6-admission.md`) | Unilateral, owner-controlled admission policy for direct inbound messages: a signed, portable admission roster (allow / hold / block per sender), held-sender review, and `knock` — the content-free admission request that is one of the two pre-admission verbs (§1.5 invariant 4; the other, `describe` §10.14, is exempt from admission filtering by definition). Live across the reference adapter, the fleet, and the operator console's Waiting list. |
| `mesh://extensions/e2e-encryption/v1` | **Implemented** (see `extensions/EXT-7-pairwise-sealing.md`) | End-to-end payload confidentiality. The core still secures only the transport, not payloads; the key substrate is the OPTIONAL agent X25519 `encryption_key` (§4.3). Two consumers exist: the Rooms `sealed` grade (rooms/v1, above) for multi-party conversations, and the **pairwise profile** (EXT-7) for direct messages — a request payload is boxed to the recipient's declared key (`sealedpayload.v1`, ephemeral-sender crypto_box), replies seal back to the sender's `reply_key`, and the mesh routes and buffers only ciphertext. Senders SHOULD seal whenever the recipient's card or manifest declares a key. TypeScript SDK ≥ 0.8.0 and the reference adapter ≥ 0.12.0; Rust SDK parity pending. |
| `mesh://extensions/device-profile/v1` | **Draft** (see `extensions/EXT-1-device-profile.md`) | Standardized node device self-description (`platform`, `os_version`, `client`, `device_class`) as declared profile keys (§9.7). |
| `mesh://extensions/usage/v1` | **Draft** (see `extensions/EXT-2-usage.md`) | Durable, identity-resolved usage & engagement store over the activity/heartbeat taps; operator read subjects `mesh.usage.*`. Operational layer, not core. |
| `mesh://extensions/contact/v1` | **Draft** (see `extensions/EXT-3-contact.md`) | Account contact channels (email, verified SMS) and notification preferences; API-layer, consent-gated. |
| `mesh://extensions/contacts/v1` | **Draft** (see `extensions/EXT-4-contacts.md`) | Private, mutual-consent contact exchange between people: handle → owner-key resolution, roster disclosure (§8.6), revocation. Explicitly NOT a public directory and NOT org modeling — public/organizational discovery is ceded to ARD (agenticresourcediscovery.org). |
| Sessions (`connect`/`disconnect`) | Candidate | The parked session operations (§10.1–10.2), if a durable-session extension is ever needed beyond `context_id`. |

Extensions whose normative text lives outside this document are collected in
the `extensions/` directory (`extensions/README.md`), which also defines the
shared rules: optional to implement but mandatory names when implemented,
carriage only in existing extensible slots, independent versioning.

---

## 18. Bindings

AgentMesh separates its **abstract protocol** (Sections 4–17) from the concrete **platform binding** that realizes it. The abstract protocol names concepts — a signed operator → account → node credential chain, subject addressing, a durable task store — and a binding defines how those concepts are provided on specific infrastructure. NATS JetStream is the **reference binding**. Alternative bindings MAY be defined but MUST satisfy the requirements in §18.1.

### 18.1. Binding Requirements

Any transport-and-platform binding MUST provide:

- **Addressing:** hierarchical, dot-delimited subject addressing with multi-level wildcards, per the Subject Namespace (Section 14).
- **Delivery:** ordered, at-least-once delivery per subject, with deduplication keyed by the envelope `id` (Section 5).
- **Request-reply:** correlated request-reply with a per-request reply address and a configurable timeout.
- **Durable task store:** a durable, keyed store holding authoritative Task state, updated on every transition (Section 7).
- **Large-payload storage:** an object store (or equivalent) for payloads exceeding the message size limit, referenced by artifact `ref` parts (Section 7.5).
- **Identity & credentials:** a signed operator → account → node credential chain (Section 4), node-key connection authentication, subject-scoped publish/subscribe authorization, and tenant import/export enforcement.
- **Presence:** periodic node liveness with TTL expiry (Section 9).

In addition to providing these guarantees, a binding MUST **document the mesh-server
interface**: the client↔server wire protocol and framing, the connection/authentication
handshake, the precise semantics of subject authorization, and the durable-consumer
semantics (acknowledgment, redelivery, resume). This document deliberately does not
re-specify them for the reference binding — they are the NATS client protocol and
JetStream API, normatively defined by the [NATS documentation](https://docs.nats.io/reference/reference-protocols/nats-protocol).
A node (or SDK) built for one binding is not expected to interoperate with a mesh
server from another binding; interoperability across bindings is at the envelope and
primitive layer, not the wire layer.

### 18.2. NATS JetStream Binding: Identity & Credentials

This realizes the abstract trust roles of §4.1 on NATS:

- **Node key** — the node's Ed25519 keypair is a NATS **NKey**; its public key is the node ID.
- **Node credential** — a NATS **User JWT** signed by the node's Account signing key, carrying the node's public NKey, its subject publish/subscribe permissions, and expiry/revocation metadata. The node presents it at connection time; all hosted agents share the one connection.
- **Account** — a NATS **account**: the tenant isolation boundary. Its signing key signs node User JWTs, and its subject import/export rules govern cross-tenant communication.
- **Operator** — the NATS **operator**: signs Account JWTs; its root key is the instance's root of trust.
- **Connection authentication** — at connection establishment the node signs a nonce from the mesh server with its NKey and presents its User JWT; the mesh server verifies the chain **Node JWT → Account JWT → Operator JWT**, then enforces the node's subject permissions and account import/export on every operation.
- Agents are **not** NATS users and hold no JWT (§4.3); an agent's right to speak comes from its node's vouch (§4.4) plus the per-envelope signature (§4.5).

### 18.3. Streams

**Required** (core):

| Stream Name | Subjects | Retention | Max Age | Replicas | Purpose |
|-------------|----------|-----------|---------|----------|---------|
| `MESH_REGISTRY` | `mesh.registry.>` | Limits | 24h | 3 | Registration events |
| `MESH_TASKS` | `mesh.task.>` | Limits | 7d | 3 | Task update delivery + redelivery buffer |
| `MESH_EVENTS` | `mesh.event.>` | Interest | 24h | 3 | Domain events |
| `MESH_HEARTBEAT` | `mesh.heartbeat.>` | Limits | 5m | 1 | Node heartbeats (presence) |
| `MESH_INBOX_{agent_id}` | `mesh.agent.{agent_id}.inbox` | Limits | 7d / 25 MB, discard old | 1 | Per-agent offline redelivery buffer (§16.4). Created by the registry at registration (non-sandbox only), deleted at deregistration/reaping. Capture works even when core NATS reports no-responders, so the live fast path is untouched. |

**Optional** (create only if the deployment wants them; the protocol does not require them):

| Stream Name | Subjects | Purpose | Notes |
|-------------|----------|---------|-------|
| `MESH_TRACE` | `mesh.trace.>` | Distributed trace storage | Trace *propagation* is in-envelope and always on; this stream only stores spans for analysis. |
| `MESH_METRICS` | `mesh.metrics.>` | Agent metrics storage | Optional. |
| `MESH_LOG` | `mesh.log.>` | Structured log storage | Optional. |
| `MESH_SESSIONS` | `mesh.session.>` | Session messages | Only if the parked `connect`/`disconnect` session ops are in use. |

### 18.4. KV Buckets & Task Persistence

| Bucket Name | Key Pattern | TTL | Replicas | Purpose |
|-------------|-------------|-----|----------|---------|
| `mesh_registry` | `{agent_id}` | None | 3 | Agent manifest storage |
| `mesh_tasks` | `{task_id}` | 7d | 3 | Task state (authoritative store) |
| `mesh_sessions` | `{context_id}` | 1h | 1 | Session metadata |

Tasks (Section 7) are persisted in the `mesh_tasks` KV bucket keyed by `task_id`; this KV entry is the authoritative source of truth for task state and is updated on every state transition. Task status and artifact updates are published to `mesh.task.{task_id}.update` subjects, which the Task Manager consumes; the `MESH_TASKS` stream captures these for delivery guarantees, while the KV bucket remains canonical for lookups.

### 18.5. Required Object Store Buckets

| Bucket Name | Purpose |
|-------------|---------|
| `mesh_artifacts` | Binary artifact storage (files, images, large payloads) |

### 18.6. Consumer Configuration

**Task Update Consumer (per requester):**
```
Stream: MESH_TASKS
Filter: mesh.task.{task_id}.update
Deliver Policy: All
Ack Policy: Explicit
Ack Wait: 30s
Max Deliver: 3
Durable: mesh_task_{task_id}_{requester_id}
```

**Inbox Buffer Consumer (per agent, §16.4):**
```
Stream: MESH_INBOX_{agent_id}
Durable: inbox_{agent_id}
Deliver Policy: All
Ack Policy: Explicit
Ack Wait: 30s
Max Deliver: 5
```
The agent (its node) binds this consumer on connect and acks each message only
after durably accepting it — the ack is the §16.4 handoff. Because the live
core subscription and this consumer can deliver the same envelope, receivers
MUST dedup by envelope `id` (§5.5). Responses to drained messages are
published to the sender's inbox (there is no live reply subject).

**Event Consumer (per subscriber):**
```
Stream: MESH_EVENTS
Filter: mesh.event.{subscribed_pattern}
Deliver Policy: New (or All for replay)
Ack Policy: Explicit
Ack Wait: 30s
Max Deliver: 5
Durable: mesh_event_{agent_id}_{subscription_hash}
```

### 18.7. Request-Reply Mapping

Synchronous `request`/`respond` uses NATS core request-reply:

1. Requester publishes to `mesh.agent.{agent_id}.inbox` with a NATS reply subject (`_INBOX.{uuid}`).
2. Responder publishes the response to the reply subject.
3. NATS delivers the response to the requester.
4. Default timeout: 30 seconds (configurable per request via `config.timeout_ms`).

For long-running requests, the responder publishes an immediate acknowledgment response (Task in `submitted` state) to the reply subject, then delivers subsequent updates via JetStream on `mesh.task.{task_id}.update`.

With inbox buffers (§16.4) in place, a no-responders or timeout outcome on an
agent inbox no longer implies the request was lost — only that the agent was
not live; the buffered copy survives and the queued-outcome semantics of §6.4
apply.

*Informative:* core NATS answers a request on a subject with no subscribers with an immediate **no-responders** error rather than a timeout. In this binding that signal doubles as a definitive agent-liveness probe: an agent's inbox has a subscriber exactly while the agent is connected and serving, so a registry implementing the retention policy (§9.2) can distinguish a dead agent on a live node (no responders) from a slow one (any reply, including an error, proves liveness). This is a binding technique, not core protocol — other bindings supply their own liveness signal or rely on node-level presence alone.

### 18.8. Exactly-Once Delivery

For critical operations (task state transitions, artifact delivery):

- Publishers MUST set the `Nats-Msg-Id` header to the envelope `id` for JetStream deduplication.
- Consumers MUST use explicit ack policy and track processed message IDs.
- The deduplication window SHOULD be set to at least 2 minutes.

### 18.9. Message Size

- NATS default max message size: 1 MB.
- For payloads exceeding the message size limit, agents MUST use NATS Object Store and include a `ref` part in the artifact.
- The platform SHOULD configure max message size based on deployment requirements.

### 18.10. Bootstrap: Finding the Mesh

A client should never need to ship with transport addresses. A mesh **instance**
(§2) is identified by one stable name — its control plane's HTTPS origin (its
*mesh home*, e.g. `https://api.agentmesh.ai`) — and everything else is learned
from it at credential time.

Every credential-issuing response of the control plane (guest issuance, app
connect, app provision/refresh) MUST include a `mesh` object:

```json
{
  "jwt": "…", "seed": "…", "publicKey": "…",
  "mesh": {
    "name": "agentmesh.ai",
    "protocol": "0.2",
    "nats_endpoints": [
      "nats://mesh.agentmesh.ai:4222",
      "ws://mesh.agentmesh.ai:4443"
    ]
  }
}
```

- `name` — the instance's identity, normally its control-plane domain.
- `protocol` — the protocol version the instance speaks (major must match, §20).
- `nats_endpoints` — transport addresses in preference order; a client picks the
  first scheme it supports (TCP vs WebSocket).

Clients SHOULD treat the mesh home as the only configured address, re-reading
`nats_endpoints` at every credential issuance/refresh so operators can move or
add transport endpoints without client changes. Clients MAY maintain a set of
known mesh homes (e.g. the public instance plus a self-hosted one) and connect
to one as the active mesh.

*Addressing note (federation seam, §21):* because agent keys are self-minted
and portable, an agent ID alone does not name a location — **agent ID + mesh
instance** does. The RECOMMENDED written form for cross-context handles is
`<agent-public-key>@<mesh-name>` (e.g. `UAB4K2…@agentmesh.ai`). Within a single
instance the domain part is implicit and MAY be omitted.

---

## 19. Metering and Cost  *(Economics extension — not core in 0.2)*

> **Moved out of core.** In 0.2, economics — the manifest `cost` block, discovery `max_cost`, the `negotiate` operation (§10.4), the `COST_LIMIT_EXCEEDED` error, and everything below — is the **Economics extension** (`mesh://extensions/economics/v1`, registered in §17.5), not part of the core protocol. Nothing is buying anything on the mesh yet; keeping economics out of core keeps the core focused on connectivity, identity, and delivery. The material is retained here as the extension's normative content and will move to a standalone extension document.

### 19.1. Cost Model

Agents declare their cost structure in the manifest. The platform provides metering infrastructure, but billing is application-defined.

### 19.2. Metering Events

The platform SHOULD emit metering events for every completed task:

**Subject:** `mesh.event.metering.task_completed`

```json
{
  "task_id": "<uuid>",
  "requester": "<nkey>",
  "responder": "<nkey>",
  "skill": "<skill-id>",
  "started_at": "<ISO-8601>",
  "completed_at": "<ISO-8601>",
  "duration_ms": 1234,
  "tokens_in": 500,
  "tokens_out": 1200,
  "cost": { "amount": 0.017, "currency": "credits" },
  "status": "completed"
}
```

### 19.3. Budget Enforcement

Agents MAY implement budget enforcement:

- The requester can include `meta.budget` in the request envelope.
- The responder SHOULD check the budget before beginning work and respond with `COST_LIMIT_EXCEEDED` if the estimated cost exceeds the budget.
- The `negotiate` composed operation provides a mechanism for pre-work cost agreement.

---

## 20. Versioning

### 20.1. Protocol Versioning

The protocol version follows [Semantic Versioning](https://semver.org/):

- **Major:** Breaking changes to primitives, envelope format, or security model.
- **Minor:** New composed operations, new optional envelope fields, new error codes.
- **Patch:** Clarifications, typo fixes, non-normative changes.

### 20.2. Version Negotiation

- Every envelope includes a `v` field with the protocol version.
- Receivers MUST check the `v` field and reject messages with unsupported major versions using `INVALID_VERSION`.
- Receivers SHOULD accept messages with the same major version and a higher minor version, ignoring unknown fields.
- The manifest includes `protocol_version` so that discovery can filter by protocol compatibility.

### 20.3. Skill Versioning

Skills are versioned independently of the protocol:

- Skill IDs SHOULD include a version suffix when breaking changes occur (e.g., `web-scrape-v2`).
- The manifest `version` field tracks the agent's overall version.
- The `negotiate` composed operation can be used for skill version negotiation.

---

## 21. Federation (Planned)

This spec defines a single mesh **instance**: one operator, one transport, one
registry. Many independent instances are expected (public, corporate,
personal), and connecting them — so an agent on one instance can reach an agent
on another — is **federation**. The mechanism is not yet implemented. The
*model* is settled, and it is written down here rather than deferred, because
the choice constrains what this specification may do elsewhere.

### The model: agents visit, traffic does not tunnel

**An agent that needs to reach an agent on another instance connects to that
instance and talks to it there.** It does not relay through its home instance,
and the two instances need no bilateral arrangement for it to work.

The sequence is the web's:

1. **Resolve.** Handle → signed card, over HTTPS (SPEC-NAMING §5). This is
   already global and involves no messaging infrastructure at all.
2. **Read where.** The card's agentmesh endpoint names the agent's **home
   mesh** (the `mesh` field, SPEC-NAMING §5.1) alongside its key.
3. **Visit.** The requester connects to that mesh as a visitor, presenting its
   own key, and addresses the agent's inbox there normally.

The recipient never leaves home. **The sender travels.** An agent's inbox,
tasks, and rooms live on its own instance, and a stranger reaches them by
becoming — briefly, and on that instance's terms — a client of it.

What follows from this, and is normative:

- **An instance MUST be able to admit a key it has never seen**, on its own
  policy alone, using only what travels: the requester's signed identity (§4)
  and whatever portable attestations it presents (§9.7). Sandbox/guest
  credentials (§4.9) are the existing mechanism; a visitor is a guest with a
  verified key. No instance may require pre-arrangement with the visitor's home
  operator as a condition of basic reachability.
- **Instance-scoped state stays instance-scoped.** The registry, task streams,
  and rooms belong to the instance whose storage holds them. Under this model
  that is not a limitation to be engineered around: a visitor is a real client
  of the instance holding the state, so tasks and rooms work normally without
  any cross-instance state protocol. Nothing here needs distributed streams.
- **Peering is an optimization, never a precondition.** Two instances with
  heavy mutual traffic MAY establish a transport-level link (the NATS gateway
  topology, with account import/export deciding which subjects cross). Basic
  reachability MUST NOT depend on one, and no agent's behavior may differ by
  whether a link exists. The relay guard (below) and the reserved
  `mesh.peer.{instance}.>` namespace (§14.1) exist for that path.
- **Discovery does not cross by default.** Cross-instance discovery is strictly
  opt-in per operator; personal and private agents remain non-discoverable
  (§8.6, SPEC-NAMING §5.4). Note that *resolution* and *discovery* are
  different: resolving a name you already know is global today; enumerating
  what an instance holds is not, and should not become so.
- **Cross-operator metering/settlement**, when it exists, layers on the
  Economics extension (§19).

### Why this shape (design context)

This subsection is rationale, not requirements. It is here because the failure
modes it describes are easy to re-introduce by someone implementing in good
faith, and each rejected alternative looks locally reasonable.

**Keep the directory and the messaging layer apart.** Naming is HTTPS and
signed documents; messaging is a message bus. They are different systems with
different trust models, and they federate by different mechanisms — the
directory already does, over ordinary HTTPS, with no peering anywhere. Welding
them together is the root error from which most of the rest follow: it is what
makes people reach for "the instances must peer so that names work", which is
false, and then for "so tasks and rooms must span instances too", which is
expensive and unnecessary. Federation closes a *reachability* gap. It adds
nothing to naming.

**The Mastodon lesson: portability is right; the instance in the handle is
not.** Account portability was the correct goal, and putting the instance name
inside the handle defeated it — moving instances rewrote every user's
identity. The deeper error was that one instance was simultaneously the
identity, the storage, and the address. AgentMesh separates these into three
independent pointers, and this separation MUST be preserved:

| | what it is | may it move? |
|---|---|---|
| **Key** | identity (§4) | no — a key change *is* an identity event (§1.5) |
| **Handle** | a name anchored to an email domain (SPEC-NAMING §2) | custodian may change; the name does not (§5.6) |
| **Home mesh** | an attachment field on the card | freely, and routinely |

No instance name appears in a handle, and none ever should. An agent may
re-home its name and move its serving mesh without either being an identity
event, because who it is never rode on where it lives.

**The DNS lesson: resolve, then connect.** DNS scales because those are two
steps. A resolver returns an address; your traffic then goes to that address —
it is not tunnelled back through the resolver, and resolvers need no
relationship with each other for a name to work globally. The visiting model is
that shape. It also explains what AgentMesh copies from DNS deliberately:
delegation with referrals (SPEC-NAMING §5.6), caching with bounded lifetimes,
and **no enumeration** — DNS lets you look up a name you know and does not let
you list a zone, which is why the handle log is owner-scoped and discovery is
opt-in. Resolution is global; enumeration is not, and conflating them is a
privacy failure, not a feature.

**The certificate lesson: take the delegation, leave the trust monopoly.** The
root → intermediate → leaf chain is a genuinely good idea: it delegates
authority without sharing the root key, and it lets a leaf be verified by a
party that has never met its issuer. AgentMesh uses that shape (operator →
account → node → agent, §4). Two failure modes of the CA world are excluded
deliberately:

- **Any root can vouch for any name.** In the certificate world a hundred roots
  can each sign the same domain, and name constraints are rarely used, so the
  system's security is its weakest issuer. The registrar analogue is a
  registrar asserting a handle it was never given, which is why taking custody
  of a name requires corroboration from the registrar releasing it
  (SPEC-NAMING §5.6) and why the anchor domain outranks every registrar
  (§5.5). Registrars are therefore **DNS registrars, not CAs**: custodians of a
  delegation, not issuers of trust. The trust root is the key and the domain.
- **Revocation does not work at scale.** CRLs and OCSP largely failed in
  practice; the honest mitigations are short lifetimes and rotation. AgentMesh
  therefore has no revocation for portable attestations, and says so (§9.7):
  expiry is enforced by the verifier, issuers keep it short, and an operator
  needing faster withdrawal rotates the issuing key.

**Why not relay through the home instance?** It is the intuitive design — your
mesh talks to their mesh on your behalf — and it is what "peering" suggests.
It requires a bilateral export/import contract per pair of instances (which
does not scale, and makes reachability a business relationship rather than a
protocol property), it puts a relay in the path of every cross-instance message
with the loops and state that implies, and because durable streams do not span
a transport link, it forces either a cross-instance state protocol or a fleet
of subtly degraded features. Visiting has none of these costs. Its own cost is
real and accepted: an agent that talks to many instances holds many
connections, and each visit is subject to the visited instance's admission
policy — which is the correct place for that decision to live.

Nothing in this spec may be implemented in a way that precludes the above; in
particular, operator identity is plural (§4.1) and envelopes remain valid and
verifiable independent of which connection or instance carried them (§4.5).

### Preconditions (normative now)

The mechanism is unbuilt, but its **preconditions bind this version of the
specification**, so that a second instance can be connected without amending
it. These are the constraints conformance tests t01–t04 exercise, and they are
cited elsewhere as §21.1 through §21.6 by number:

1. **Carrier independence.** An envelope MUST verify — signature, identity,
   trace — independent of which connection, node, or instance carried it
   (§4.5, restated here as a federation precondition). No implementation may
   treat "arrived on my transport" as evidence of authenticity.
2. **Relay guard.** The envelope `meta` field reserves `hops`: an integer
   incremented by each relaying instance. Instances MUST drop envelopes whose
   `hops` exceeds a small bound (RECOMMENDED: 3). This is the loop-prevention
   primitive peering will rely on; single-instance deployments simply never
   set it.
3. **Subject mappability.** All protocol subjects live under prefixes an
   importing instance can rewrite mechanically (§14), and
   `mesh.peer.{instance}.>` is reserved for the relay path (§14.1).
4. **Peer identity is operator identity.** A peer instance is identified and
   verified exactly as an operator is: root key anchored at its DNS domain
   (§4.1), in the manner of DKIM. Federation adds no new identity type.
5. **Names precede peering.** Handle resolution is already global
   (SPEC-NAMING §5.5): an agent on another instance is *resolvable* before it
   is *reachable*. Federation closes the reachability gap only; it adds
   nothing to naming, per invariant 1 (§1.5).
6. **Where travels with who.** A resolver MUST NOT assume a resolved agent
   lives on the instance it is currently connected to. An agent's card carries
   its home mesh (the `mesh` field on the agentmesh endpoint, SPEC-NAMING
   §5.1), and any implementation that turns a name into a connection MUST read
   it rather than defaulting to the local instance. An implementation that
   silently assumes "resolved here means reachable here" works perfectly on one
   instance and cannot be corrected later without breaking every consumer of
   its resolution path.

The test of these constraints is concrete: **a second production instance must
be connectable without amending this specification.** If connecting one
requires a change to anything above, one of the six constraints was violated —
file it as a defect against this section.

---

## Appendix A: Example — Complete Request-Respond Flow

```
Agent A (requester)                     Agent B (responder)
       |                                        |
       |  1. discover("web-scrape")             |
       |------> mesh.registry.discover          |
       |<------ [manifest of Agent B]           |
       |                                        |
       |  2. request(skill: "web-scrape")       |
       |------> mesh.agent.{B}.inbox            |
       |        reply: _INBOX.abc123            |
       |                                        |
       |  3. respond(status: submitted)         |
       |<------ _INBOX.abc123                   |
       |        task_id: task-789               |
       |                                        |
       |  4. [subscribe to task updates]        |
       |------> consumer on mesh.task.task-789  |
       |                                        |
       |  5. respond(status: working)           |
       |<------ mesh.task.task-789.update       |
       |                                        |
       |  6. respond(status: completed,         |
       |             artifacts: [...])          |
       |<------ mesh.task.task-789.update       |
       |                                        |
```

## Appendix B: Example — Event-Driven Collaboration

```
Agent A (scraper)       Bus                Agent B (analyzer)    Agent C (reporter)
       |                 |                        |                      |
       |  1. emit        |                        |                      |
       |  profile_found  |                        |                      |
       |---------------->|  mesh.event.scraping   |                      |
       |                 |  .profile_found        |                      |
       |                 |----------------------->|  2. onEvent          |
       |                 |                        |     (analyze)        |
       |                 |                        |                      |
       |                 |  3. emit               |                      |
       |                 |  analysis_complete     |                      |
       |                 |<-----------------------|                      |
       |                 |  mesh.event.analysis   |                      |
       |                 |  .complete             |                      |
       |                 |----------------------------------------------->|
       |                 |                        |  4. onEvent          |
       |                 |                        |     (generate report)|
```

## Appendix C: Example — Streaming LLM Output

```
Agent A (requester)                     Agent B (LLM agent)
       |                                        |
       |  request(stream: true)                 |
       |------> mesh.agent.{B}.inbox            |
       |                                        |
       |  respond(status: working, task_id)     |
       |<------ _INBOX (reply subject)          |
       |                                        |
       |  [subscribe: mesh.task.{id}.stream]    |
       |                                        |
       |  chunk 0: "The "                       |
       |<------ mesh.task.{id}.stream           |
       |  chunk 1: "quick "                     |
       |<------ mesh.task.{id}.stream           |
       |  chunk 2: "brown fox"                  |
       |<------ mesh.task.{id}.stream           |
       |  chunk 3 (final: true)                 |
       |<------ mesh.task.{id}.stream           |
       |                                        |
       |  task update: completed                |
       |<------ mesh.task.{id}.update           |
```

---

*End of specification.*
