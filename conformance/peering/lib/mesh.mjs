// Thin mesh access for tests: a raw NATS connection with the operator's
// durable creds, plus signed-envelope request helpers. Raw on purpose — the
// suite tests the wire contract, not the SDK's conveniences.
import { connect, jwtAuthenticator } from "nats.ws";
import nkeys from "nkeys.js";
import { createEnvelope, signEnvelope } from "./sdk.mjs";

// Re-exported for sibling suites (conformance/core) that share this lib —
// bare "nats.ws"/"nkeys.js" specifiers resolve only from THIS directory's
// node_modules.
export { connect, jwtAuthenticator, nkeys };

const te = new TextEncoder();
const td = new TextDecoder();

export async function meshConnect(env) {
  if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
  return connect({
    servers: env.meshWsUrl,
    authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
    timeout: 15_000,
    maxReconnectAttempts: 0,
  });
}

export function identityKeypair(env) {
  if (!env.identity?.seed) throw new Error("env-skip: MESH_IDENTITY_FILE (adapter identity) required");
  return nkeys.fromSeed(te.encode(env.identity.seed));
}

/** Build and sign a request envelope from this machine's durable identity. */
export function signedRequest(env, { to, skill, input = null, meta = undefined }) {
  const kp = identityKeypair(env);
  const from = env.identity.public_key;
  const envelope = createEnvelope({
    type: "request",
    from,
    to,
    payload: { skill, input },
    ...(meta !== undefined ? { meta } : {}),
  });
  return signEnvelope(envelope, kp);
}

/** NATS request/reply to an agent inbox; returns the parsed reply envelope or null on timeout. */
export async function inboxRequest(nc, agentId, envelope, timeoutMs = 10_000) {
  try {
    const msg = await nc.request(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(envelope)), {
      timeout: timeoutMs,
    });
    return JSON.parse(td.decode(msg.data));
  } catch (e) {
    if (String(e.message ?? e).includes("TIMEOUT") || e.code === "TIMEOUT" || e.code === "503") return null;
    throw e;
  }
}
