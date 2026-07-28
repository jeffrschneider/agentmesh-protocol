// Environment contract for the peering conformance suite.
//
// Tests declare what they need; missing pieces produce env-skip (with the
// exact variable named), never a false pass or a mysterious crash. All
// defaults point at the public reference deployment, so a fully-credentialed
// operator machine runs everything runnable with zero configuration.
//
// Two hazards of that convenience, both handled here:
//
//   1. The defaults name OUR deployment. A third-party operator who forgets
//      one export would silently test agentmesh.ai and read the green board
//      as evidence about their own install. So any value that falls back to
//      an agentmesh.ai default is announced in a banner at the start of the
//      run (loadEnv prints it — both suites load through here, so neither
//      runner can forget to).
//
//   2. A credential file that was CONFIGURED but unreadable/empty/malformed
//      must not collapse into "not configured": that would env-skip exactly
//      the tests that would have caught the broken secret, and the board
//      would still look green. Such failures are recorded in
//      env.credentialProblems (variable name → what went wrong) and the
//      runners report the affected tests as not-validated, not env-skip.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function credsFrom(path) {
  const content = readFileSync(path, "utf8");
  const jwt = content.match(/-----BEGIN NATS USER JWT-----\r?\n([\s\S]*?)\r?\n------END NATS USER JWT------/)?.[1]?.trim();
  const seed = content.match(/-----BEGIN USER NKEY SEED-----\r?\n([\s\S]*?)\r?\n------END USER NKEY SEED------/)?.[1]?.trim();
  if (!jwt || !seed) throw new Error(`creds file malformed: ${path}`);
  return { jwt, seed };
}

// The agentmesh.ai fallbacks, kept in one place so the banner below cannot
// drift from what loadEnv actually uses.
const REFERENCE_DEFAULTS = [
  ["MESH_WS_URL", "wss://mesh.agentmesh.ai"],
  ["REGISTRAR", "https://naming.agentmesh.ai"],
  ["ECHO_TARGET", "codex.test@agentmesh.ai"],
  ["STOREFRONT_BASE", "https://api.agentmesh.ai"],
];

export function loadEnv() {
  const dflt = Object.fromEntries(REFERENCE_DEFAULTS);
  const env = {
    meshWsUrl: process.env.MESH_WS_URL ?? dflt.MESH_WS_URL,
    registrar: process.env.REGISTRAR ?? dflt.REGISTRAR,
    // A live fleet agent whose daemon answers echo; describe (t05) also lands here.
    echoTarget: process.env.ECHO_TARGET ?? dflt.ECHO_TARGET,
    // Where HTTPS storefronts are expected to serve (§10.14): the home mesh API.
    storefrontBase: process.env.STOREFRONT_BASE ?? dflt.STOREFRONT_BASE,
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
    // Variable name → what went wrong reading a credential file that WAS
    // configured (explicit env var, or the default path exists). The runners
    // upgrade env-skips that name these variables to not-validated: the
    // operator asked for credentials and did not get them, which is a
    // failure of the run, not an absent prerequisite.
    credentialProblems: {},
  };

  // A credential source is "configured" if the operator pointed at it
  // explicitly or the default file is present on disk. Only a default path
  // that simply does not exist counts as not-configured (a genuine skip).
  const loadCredential = (varName, defaultPath, read, assign) => {
    const path = process.env[varName] ?? defaultPath;
    const configured = Boolean(process.env[varName]) || existsSync(path);
    try { assign(read(path)); }
    catch (e) {
      if (configured) env.credentialProblems[varName] = `${path}: ${String(e?.message ?? e)}`;
      // else: not configured — tests that need it env-skip, as before.
    }
  };

  loadCredential("MESH_CREDS_FILE", join(homedir(), ".agentmesh", "mesh.creds"),
    credsFrom, (v) => { env.creds = v; });
  loadCredential("MESH_IDENTITY_FILE", join(homedir(), ".agentmesh", "adapter", "identity.json"),
    (p) => JSON.parse(readFileSync(p, "utf8")), (v) => { env.identity = v; });
  loadCredential("MESH_ROOMS_CREATOR_SEED", join(homedir(), ".agentmesh", "conformance-creator.seed"),
    (p) => {
      const seed = readFileSync(p, "utf8").trim();
      if (!seed) throw new Error("file is empty");
      return seed;
    }, (v) => { env.roomsCreatorSeed = v; });

  // Name every value that fell back to the reference deployment. Without
  // this, a third-party operator who forgets one export silently tests OUR
  // mesh and walks away with a green board for THEIR install.
  const fellBack = REFERENCE_DEFAULTS.filter(([name]) => !process.env[name]);
  if (fellBack.length) {
    const w = Math.max(...fellBack.map(([name]) => name.length));
    console.error([
      "",
      "############################################################################",
      "##  DEFAULT ENDPOINTS IN USE — THIS RUN TESTS agentmesh.ai               ##",
      "##                                                                        ##",
      "##  The following were not set and fell back to the reference             ##",
      "##  deployment (the AgentMesh project's own production instance):         ##",
      ...fellBack.map(([name, value]) => `##    ${name.padEnd(w)} → ${value}`),
      "##                                                                        ##",
      "##  If you operate your own mesh, this board is NOT evidence about it.    ##",
      "##  Export the variables above to point the suite at your install.        ##",
      "############################################################################",
      "",
    ].join("\n"));
  }

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
