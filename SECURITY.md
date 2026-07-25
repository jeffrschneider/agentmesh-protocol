# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting. Pick whichever public repository
fits what you found, and include how to reproduce it:

- Specification or conformance suite:
  <https://github.com/jeffrschneider/agentmesh-protocol/security/advisories/new>
- Deployment recipes (compose, kubernetes):
  <https://github.com/jeffrschneider/agentmesh-deploy/security/advisories/new>

Both reach the same maintainers, so if you are unsure which one applies, pick
either and say so in the report. The thread stays private between you and the
maintainers until an advisory is published, and it lives on the repository
itself, so nothing depends on a mailbox being watched.

Please do not open a public issue for a vulnerability. Do not try to report it
on the main AgentMesh repository either: that one is private, so you cannot
reach it and the report would go nowhere.

If you have no GitHub account and cannot create one, open an ordinary issue on
one of the repositories above saying only that you have a security finding and
asking for a private channel. Leave the details out of it.

On timing, an intention rather than a promise: reports are read by a very small
number of people, so expect a first human reply in days rather than hours, and
longer when a finding needs a fix designed before it is safe to say much. If a
report has gone quiet for a fortnight, add a comment to the same private thread.
Silence here means someone is busy, not that you are being ignored.

There is no bug bounty. This is a small project and it would be dishonest to
imply otherwise.

## What we consider a vulnerability

The security model is cryptographic and lives in the protocol, so the interesting
failures are the ones that break a guarantee the specification makes:

- Accepting an envelope whose signature does not verify, or treating "arrived on
  my transport" as evidence of authenticity (SPEC.md §4.5).
- Anything that lets one party act as another: forging or replaying a card, a
  handle claim, a re-home statement, an attestation, or a room membership.
- Taking custody of a name its owner did not move (SPEC-NAMING §5.6), or
  resolving a handle to a key its owner did not bind.
- Reading or writing across an account boundary, or escaping the subject
  permissions an account's credential grants.
- Extracting a credential, seed or operator key from anything that should not
  hold one, including a container image or a log.
- Enumerating what should not be enumerable: the handle log, an operator's
  roster, or agents whose owner has not opted into discovery.

Denial of service by simply sending a lot of traffic is not usually interesting.
Denial of service that costs the attacker nothing, or that one tenant can inflict
on another, is.

## What is out of scope, deliberately

Some things look like vulnerabilities and are documented decisions. Please read
these before reporting them:

- **Portable attestations cannot be revoked** (SPEC.md §9.7). Verifiers enforce
  expiry, issuers keep it short, and withdrawing a claim early means rotating the
  issuing key. This is the DKIM and certificate-revocation lesson, taken
  deliberately.
- **Resolving a handle discloses interest to the anchor domain**
  (SPEC-NAMING §5.5). Consulting the domain first is what makes the owner the
  authority; it cannot be hidden by skipping the probe.
- **Handles embed an email address.** That is the anchor, and it is why the
  history log is owner-scoped rather than public.
- **A visitor is admitted on the receiving mesh's policy alone** (SPEC.md §21).
  There is no global allowlist and there is not meant to be one.

## Supported versions

The published container images and SDK tarballs are supported at their latest
version only. There are no long-term support branches. If you are running an
older version, the fix is to move forward.

## Handling of your report

We will tell you what we found, what we changed, and when it shipped. If you
want credit you will get it; if you would rather not be named, say so. We will
not involve lawyers over a good-faith report, and we would rather hear about a
problem from you than from an incident.
