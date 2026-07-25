// c01 — emit/subscribe round-trip: two of the six primitives (§6.6, §6.7)
// had no tests of any kind before this. A subscriber receives a matching
// emit with an intact, verifying envelope; a non-matching emit does not
// deliver; wildcard patterns match per §14.2.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, verifyEnvelopeSig } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c01",
  title: "emit/subscribe: matching events deliver signed, non-matching don't",
  spec: "§6.6, §6.7, §14.2",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const seed = (kp) => td.decode(kp.getSeed());

    const a = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: seed(nkeys.createUser()) });
    const b = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: seed(nkeys.createUser()) });
    const fails = [];
    try {
      const domain = `c01x${Date.now().toString(36)}`; // unique: no cross-run bleed
      const got = [];         // exact-topic subscription
      const gotWild = [];     // wildcard subscription
      a.subscribe(`${domain}.built`, (payload, envelope) => got.push({ payload, envelope }));
      a.subscribe(`${domain}.*`, (payload) => gotWild.push(payload));
      await sleep(600); // subscription interest propagation

      b.emit(`${domain}.built`, { n: 1 });
      b.emit(`${domain}.ignored`, { n: 2 });
      await sleep(1500);

      if (got.length !== 1) fails.push(`exact subscriber got ${got.length} events, want 1`);
      if (got[0]) {
        const { payload, envelope } = got[0];
        if (payload?.data?.n !== 1) fails.push(`payload.data=${JSON.stringify(payload?.data)}, want {n:1}`);
        if (payload?.domain !== domain) fails.push(`domain=${payload?.domain}`);
        if (envelope?.from !== b.agentId) fails.push("event's from is not the emitter");
        if (!verifyEnvelopeSig(envelope)) fails.push("event envelope signature does not verify");
      }
      if (gotWild.length !== 2) fails.push(`wildcard subscriber got ${gotWild.length} events, want 2`);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "matching event delivered signed and intact; non-matching filtered; wildcard matched both" };
  },
};
