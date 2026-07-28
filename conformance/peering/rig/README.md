# The peering rigs

Local infrastructure that stands in for "a second instance" so the
federation tests (t07, t08, t10) run without cloud deployment. Everything is
localhost, ephemeral, and torn down by re-running the launcher.

## Two registrars (t07, t08, t11, t13)

```
bash rig/two-registrars.sh
export REGISTRAR_A=http://localhost:18081 REGISTRAR_B=http://localhost:18082 REGISTRAR_TEST_PEER=http://127.0.0.1:18089
```

(The launcher prints that line; it is not decoration, see below.)

Two `agentmesh-naming` instances, each with its own embedded Postgres and
card-signing key (built from `naming/`, binary at
`D:/cargo-target/debug/agentmesh-naming.exe` or your `CARGO_TARGET_DIR`).
`rehome-flow.mjs` claims + binds a handle on A, key-signs `pan-rehome-v1`,
and moves it to B — proving the custodian change preserves identity and the
old registrar refuses to re-issue.

Each instance is started with `PAN_PEERS` naming the other: A peers B, B peers
A. That is a correctness requirement of the rig, not tidiness. With `PAN_PEERS`
unset the registrar takes a loopback-only development branch that admits **any**
loopback origin as a peer — and on this rig every origin is loopback, so a
server an attacker stands up and a registrar the operator chose become
indistinguishable. §5.6 check 5 (the losing registrar must agree it released the
handle) would then be satisfiable by asking a stranger, and t13 would pass
without the allowlist existing at all.

B additionally lists `http://127.0.0.1:18089`, a reserved origin **nothing in
the rig serves**: t13 binds its own fixture there. B trusting it is deliberate.
The allowlist is the outer gate; the checks behind it (§5.6/§7.8: the referral
must be *signed* by a key the peer publishes at `/api/registrar-key`) can only
be reached by a peer whose behaviour the test controls. t13's other fixture runs
on an ephemeral port that is in nobody's list, which is how the gate itself gets
tested. Override the port with `TEST_PEER=…` if 18089 is taken.

`REGISTRAR_A`/`REGISTRAR_B` must be spelled exactly as `PAN_PEERS` spells them —
the allowlist is an exact normalized match, so `127.0.0.1` where the peer list
says `localhost` is not a peer, and the honest move stops working.

## Two peered meshes (t10)

```
bash rig/two-meshes.sh
export PEER_MESH_A_WS=ws://localhost:14461 PEER_MESH_B_WS=ws://localhost:14462
```

Two `nats-server` instances peered by a gateway (mesh A ws 14461, mesh B ws
14462). t10 runs a responder on B and a client on A; the request crosses the
gateway and the reply's envelope verifies end to end. Needs a `nats-server`
binary (the launcher looks under the session temp dir; point it at any
`nats-server.exe` if yours is elsewhere).

## Running the full board

```
bash rig/two-registrars.sh && bash rig/two-meshes.sh
export REGISTRAR_A=http://localhost:18081 REGISTRAR_B=http://localhost:18082 REGISTRAR_TEST_PEER=http://127.0.0.1:18089
export PEER_MESH_A_WS=ws://localhost:14461 PEER_MESH_B_WS=ws://localhost:14462
export MESH_CREDS_FILE=~/.agentmesh/mesh.creds
node run.mjs            # the whole board, nothing skipped, with both rigs up
```

Without the rigs, t07/t08/t11/t13 env-skip and t10 pends — reported as "not
evaluated", never a regression. `expectations.json` records the full-rig
truth (all pass); `--ci` only fails on a real pass→fail.
