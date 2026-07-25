# AgentMesh Protocol

The specification for AgentMesh — an open, mesh-native protocol for
agent-to-agent communication — and the conformance suite that proves an
implementation follows it.

This repository is the standard. The reference platform, the SDKs, and the
tools for running a mesh live elsewhere; what lives here is the protocol
itself and the tests any implementation must pass to claim conformance.

## What's here

- **[SPEC.md](SPEC.md)** — the core protocol: identity and signing, the message
  envelope, the six primitives (register, discover, request, respond, emit,
  subscribe), the task model, the registry and presence split, streaming,
  errors, the subject namespace, multi-tenancy, rate limits, extensions, and
  the NATS binding. Also readable at <https://dev.agentmesh.ai/spec.html>.
- **[SPEC-NAMING.md](SPEC-NAMING.md)** — the naming layer (PAN): how a handle
  resolves to a card over ordinary HTTPS, why a domain outranks every
  registrar, portable trust attestations, and re-homing.
- **[conformance/](conformance/)** — two suites of black-box tests run against a
  live mesh. `core/` covers the protocol surface (c01–c11); `peering/` covers
  naming and federation (t01–t12). Each test cites the spec section it checks,
  and a red test is a defect in the code or the spec — decided explicitly, in
  writing, never by editing the test to pass.

## Running the conformance suite

The suites are black-box: they exercise a running mesh over its real wire, not
an in-process mock. Point them at your own mesh, or at the public reference
deployment (the defaults).

```
cd conformance/peering && npm install     # installs shared deps (nats.ws, nkeys)
cd ../core   && node run.mjs              # the core suite
cd ../peering && node run.mjs             # the naming/federation suite
```

Both runners take `--only <id>` to run one test, `--ci` to fail on any
regression against `expectations.json`, and `--update` to re-record the
baseline.

Tests declare what they need. A test whose prerequisite is absent (operator
credentials, a second registrar, a paired handle) reports **env-skip** naming
the missing piece — never a false pass. Set:

- `MESH_WS_URL` — the mesh to test (default `wss://mesh.agentmesh.ai`).
- `MESH_CREDS_FILE` — durable NATS credentials, for tests that register agents.
  Without these, most core tests env-skip.
- `AGENTMESH_SDK` — a local SDK build directory to test instead of the published
  tarball pinned in `conformance/peering/package.json`. The runner prints which
  artifact answered on every run.

Some tests need more (a PAN-handle-paired key for ACL rooms, a two-registrar
rig for re-homing); each names its requirement when skipped. The `peering/rig/`
scripts stand up the local rigs.

## Licensing

The specification prose (SPEC.md, SPEC-NAMING.md) is licensed under
[CC BY 4.0](LICENSE-SPEC) — implement it freely, with attribution. All code,
including the conformance suite, is licensed under [Apache-2.0](LICENSE).

## Reporting a security issue

A break in one of the guarantees the specification makes (an envelope accepted
without a valid signature, one party able to act as another, a name taken from
its owner) is a vulnerability, not an issue. Report it privately, through GitHub
private vulnerability reporting:

<https://github.com/jeffrschneider/agentmesh-protocol/security/advisories/new>

That thread is visible only to you and the maintainers until an advisory is
published. Please do not open a public issue for it. Reports are read by a very
small number of people, so expect a reply in days rather than hours.

## Related

- Run your own mesh: <https://github.com/jeffrschneider/agentmesh-deploy>
- Developer docs: <https://dev.agentmesh.ai>
- Overview: <https://agentmesh.ai>
