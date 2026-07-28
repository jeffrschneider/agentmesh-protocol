# Peering conformance suite

Executable form of the peered-mesh acceptance criteria: SPEC.md §1.5 (the
five layering invariants), §21 (federation preconditions), §10.14
(`describe`), §8.7 (the public block), §9.7 (portable attestations), and
SPEC-NAMING §5.3/§5.5/§5.6 (signed cards, resolution authority, re-homing).

Written **before** the implementation, deliberately: the red tests are the
Phase 1–3 work list, and §21's sentence — *a second production instance must
be connectable without amending the spec* — stops being prose and becomes
`node run.mjs` the day the peer exists.

## Run

```
cd conformance/peering
npm install
node run.mjs            # the board
node run.mjs --only t05 # one test
node run.mjs --ci       # exit 1 on any REGRESSION vs expectations.json
node run.mjs --update   # rewrite expectations.json from this run
```

## The discipline

A red test is either a **code defect** or a **spec defect** — decided
explicitly, in writing (commit message or spec changelog). Editing a test to
make it pass, without naming which of the two it was, is prohibited. The
tests cite their spec sections precisely so that argument can be had against
the text, not against vibes.

`expectations.json` is the recorded truth of the current run. CI (`--ci`)
fails on regression — a test recorded as `pass` that stops passing — and on
any `not-validated` result (below). Turning a red test green is celebrated
by updating the baseline (`--update`) in the same commit as the
implementation.

**`not-validated` is not a skip.** When a credential file was CONFIGURED
(explicit env var, or the default path exists on disk) but could not be read,
was empty, or was malformed, the tests that needed it report `not-validated`
instead of `env-skip`, the summary calls them out separately, and `--ci`
exits 1. The reason: "passes and env-skips only" must never be satisfiable by
breaking a secret — an unreadable creds file would otherwise skip exactly the
tests that would have caught it. The fix is always the credential file, never
the baseline.

## Environment contract

Everything defaults to the public reference deployment; tests that need
more, env-skip with the variable named.

**The defaults are agentmesh.ai.** Any run in which an endpoint falls back to
its default prints a banner naming every fallen-back variable and stating
that the run is testing agentmesh.ai, not your mesh. If you operate your own
instance, export the variables below — a board produced under the banner is
evidence about the reference deployment only.

| Variable | Default | Used by |
|---|---|---|
| `MESH_WS_URL` | `wss://mesh.agentmesh.ai` | t02 t03 t05 t09 |
| `MESH_CREDS_FILE` | `~/.agentmesh/mesh.creds` | t02 t03 t05 t09 (durable NATS creds) |
| `MESH_IDENTITY_FILE` | `~/.agentmesh/adapter/identity.json` | t02 t05 (envelope signing identity) |
| `REGISTRAR` | `https://naming.agentmesh.ai` | handle resolution |
| `ECHO_TARGET` | `codex.test@agentmesh.ai` | a live fleet agent |
| `STOREFRONT_BASE` | `https://api.agentmesh.ai` | t05 (HTTPS storefront, §10.14) |
| `RESOLVER_MJS` | `../../mesh-adapter/mesh-adapter.mjs` | t06a t06b (resolver under test) |
| `REGISTRAR_A`, `REGISTRAR_B` | unset → env-skip | t07 t08 (two registrars; Phase 2) |
| `PEER_MESH_URL` | unset → pending-peer | t10 (the second instance; Phase 3) |
| `AGENTMESH_SDK` | unset → the published tarball | test a release candidate instead (see below) |

**Which SDK is under test.** By default the suite runs against the published
`agentmesh` tarball pinned in `package.json` — the artifact real consumers
install, and the right thing to hold to the spec. Point `AGENTMESH_SDK` at a
build directory (e.g. `AGENTMESH_SDK=../../sdk-typescript`) to test a release
candidate before publishing it. Every run prints which one answered; a green
board that does not name the artifact it tested is not evidence about any
particular artifact.

**Release gate, worked example.** t09 went red on the published 0.17.0 the moment SPEC.md §9.7 gained the type-tag and expiry requirements, and stayed red until 0.19.0 shipped with them. That is the gate working: the board reports on the artifact consumers actually install, and `AGENTMESH_SDK` is how you check a candidate before publishing it.

**Which AGENT is under test** (`conformance/core` only, for now).
`AGENTMESH_SDK` above chooses which build of the *TypeScript* SDK the harness
imports. It cannot choose a different *language*, because the runner is Node
and a Rust crate cannot be imported into it — so every core test that needed a
live agent was an assertion about TypeScript and nothing else.
`AGENTMESH_AGENT_SDK` fixes that by naming which implementation plays the agent
under test:

| Value | What answers |
|---|---|
| `typescript` | **the default** — the imported TS SDK, in the runner's own process, exactly as before this knob existed |
| `typescript-subprocess` | the same TS SDK, driven as a child process over the conformance-agent line protocol (the control that proves the protocol, not the SDK) |
| `rust` | the `agentmesh` crate, via `sdk-rust/examples/conformance_agent.rs` — build it first: `cd sdk-rust && cargo build --example conformance_agent` |

The default is in-process on purpose: a run that asks for nothing new must
behave exactly as it did before, with no child process in the picture. Every
core run prints both lines — the SDK module the harness imported and the agent
implementation that answered. The protocol, the backend table and the rules
that keep the agents from becoming second SDK implementations are documented in
`../core/lib/agent-under-test.mjs`.

**An SDK that cannot run a test reports `not-validated`**, for the same reason
a broken-but-configured credential does: the operator asked for that
implementation, the test did not run, and a green board must not be reachable
by pointing the suite at something that cannot answer. Converted so far: `c03`.

**Conformance seams** (test-only injection points implementations MUST honor):

- `--anchor-webfinger <base>` — a command-line flag (NOT an environment
  variable) giving an http base URL the resolver treats as the anchor domain's
  well-known host, so §5.5 domain preference is testable without owning a
  domain. It was an env var, `CONFORMANCE_ANCHOR_WEBFINGER`, until 2026-07-24:
  §5.5 makes whatever answers this probe outrank the registrar, so it decides
  which key a name resolves to, and that is not a decision anything sitting in
  a daemon's environment should be able to make. An implementation under test
  MUST honor the flag per invocation and MUST NOT read the old variable.
  Loopback card URLs are followed only when this flag is present.

## Current board (2026-07-24, pre-Phase-1)

Green today: t01 (carrier independence), t04 (subject mappability),
t06a (unsigned cards die). Red by design until the phase that turns them:
t02 hops guard, t03 reserved namespace (Phase 1/infra), t05 describe +
storefront (Phase 1), t06b anchor-domain authority (Phase 2), t09 portable
attestations (Phase 3 groundwork). Env-skipped: t07/t08 re-homing pair
(Phase 2 brings the registrar pair). Pending peer: t10 (Phase 3, the
acceptance run).
