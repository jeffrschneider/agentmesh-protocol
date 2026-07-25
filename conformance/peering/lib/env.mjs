// Environment contract for the peering conformance suite.
//
// Tests declare what they need; missing pieces produce env-skip (with the
// exact variable named), never a false pass or a mysterious crash. All
// defaults point at the public reference deployment, so a fully-credentialed
// operator machine runs everything runnable with zero configuration.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function credsFrom(path) {
  const content = readFileSync(path, "utf8");
  const jwt = content.match(/-----BEGIN NATS USER JWT-----\r?\n([\s\S]*?)\r?\n------END NATS USER JWT------/)?.[1]?.trim();
  const seed = content.match(/-----BEGIN USER NKEY SEED-----\r?\n([\s\S]*?)\r?\n------END USER NKEY SEED------/)?.[1]?.trim();
  if (!jwt || !seed) throw new Error(`creds file malformed: ${path}`);
  return { jwt, seed };
}

export function loadEnv() {
  const env = {
    meshWsUrl: process.env.MESH_WS_URL ?? "wss://mesh.agentmesh.ai",
    registrar: process.env.REGISTRAR ?? "https://naming.agentmesh.ai",
    // A live fleet agent whose daemon answers echo; describe (t05) also lands here.
    echoTarget: process.env.ECHO_TARGET ?? "codex.test@agentmesh.ai",
    // Where HTTPS storefronts are expected to serve (§10.14): the home mesh API.
    storefrontBase: process.env.STOREFRONT_BASE ?? "https://api.agentmesh.ai",
    // Second instance (Phase 3). Unset => pending-peer.
    peerMeshUrl: process.env.PEER_MESH_URL ?? null,
    // The two peered meshes of the local rig (rig/two-meshes.sh). When both are
    // set, t10 runs the cross-instance flow; otherwise it pends on a peer.
    meshAWs: process.env.PEER_MESH_A_WS ?? null,
    meshBWs: process.env.PEER_MESH_B_WS ?? null,
    // Second registrar (Phase 2, for re-homing tests). Unset => env-skip.
    registrarA: process.env.REGISTRAR_A ?? null,
    registrarB: process.env.REGISTRAR_B ?? null,
    creds: null,
    identity: null,
    // An agent key paired to a PAN handle, for tests that need a handle-bearing
    // creator (c10: durable/ACL rooms require the creator to reverse-resolve to
    // an email-verified operator). Just the seed; the connection still uses the
    // operator NATS creds above.
    roomsCreatorSeed: null,
  };

  const credsPath = process.env.MESH_CREDS_FILE ?? join(homedir(), ".agentmesh", "mesh.creds");
  try { env.creds = credsFrom(credsPath); } catch { /* env-skip in tests that need it */ }

  const identityPath = process.env.MESH_IDENTITY_FILE ?? join(homedir(), ".agentmesh", "adapter", "identity.json");
  try { env.identity = JSON.parse(readFileSync(identityPath, "utf8")); } catch { /* same */ }

  const creatorSeedPath = process.env.MESH_ROOMS_CREATOR_SEED ?? join(homedir(), ".agentmesh", "conformance-creator.seed");
  try { env.roomsCreatorSeed = readFileSync(creatorSeedPath, "utf8").trim() || null; } catch { /* env-skip c10 */ }

  return env;
}

/** Resolve a handle to its agent_id via the registrar HTTP API (no auth). */
export async function resolveAgentId(registrar, handle) {
  const res = await fetch(`${registrar}/api/resolve?handle=${encodeURIComponent(handle)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`resolve ${handle}: HTTP ${res.status}`);
  const body = await res.json();
  const card = body.card ?? body;
  const ep = (card.endpoints ?? []).find((e) => e.protocol === "agentmesh");
  if (!ep?.agent_id) throw new Error(`resolve ${handle}: no agentmesh endpoint on card`);
  return ep.agent_id;
}
