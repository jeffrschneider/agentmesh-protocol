# The peering rigs

Local infrastructure that stands in for "a second instance" so the
federation tests (t07, t08, t10) run without cloud deployment. Everything is
localhost, ephemeral, and torn down by re-running the launcher.

## Two registrars (t07, t08)

```
bash rig/two-registrars.sh
export REGISTRAR_A=http://localhost:18081 REGISTRAR_B=http://localhost:18082
```

Two `agentmesh-naming` instances, each with its own embedded Postgres and
card-signing key (built from `naming/`, binary at
`D:/cargo-target/debug/agentmesh-naming.exe` or your `CARGO_TARGET_DIR`).
`rehome-flow.mjs` claims + binds a handle on A, key-signs `pan-rehome-v1`,
and moves it to B — proving the custodian change preserves identity and the
old registrar refuses to re-issue.

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
export REGISTRAR_A=http://localhost:18081 REGISTRAR_B=http://localhost:18082
export PEER_MESH_A_WS=ws://localhost:14461 PEER_MESH_B_WS=ws://localhost:14462
export MESH_CREDS_FILE=~/.agentmesh/mesh.creds
node run.mjs            # 11/11 with both rigs up
```

Without the rigs, t07/t08 env-skip and t10 pends — reported as "not
evaluated", never a regression. `expectations.json` records the full-rig
truth (all pass); `--ci` only fails on a real pass→fail.
