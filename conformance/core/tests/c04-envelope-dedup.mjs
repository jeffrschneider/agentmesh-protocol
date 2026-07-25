// c04 — dedup by envelope id (§5.5): the same request envelope delivered
// twice (a sender retry, or live+buffer double-delivery) executes the
// handler exactly once. Claimed by the spec, load-bearing for federation
// double-hearing and for offline drain overlap; never tested before this.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c04",
  title: "envelope dedup: a retried request executes once",
  spec: "§5.5, §18.8",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    const counts = new Map(); // envelope id -> executions
    const a = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: td.decode(nkeys.createUser().getSeed()) });
    a.onRequest("echo", async (input, ctx) => {
      const id = ctx?.envelope?.id ?? "?";
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return { ok: input };
    });
    await a.register({ name: "c04-target", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c04" }] });
    const idA = a.agentId;

    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    try {
      const kpS = nkeys.createUser();
      const envR = signEnvelope(createEnvelope({
        type: "request", from: kpS.getPublicKey(), to: idA,
        payload: { skill: "echo", input: { n: 1 } },
        meta: { idempotency_key: "c04-once" },
      }), kpS);
      const bytes = te.encode(JSON.stringify(envR));

      // First delivery: normal request-reply, must answer.
      const first = JSON.parse(td.decode((await nc.request(`mesh.agent.${idA}.inbox`, bytes, { timeout: 8000 })).data));
      if (first.error) fails.push(`first delivery errored: ${first.error.message}`);

      // Retries: the SAME bytes, three more times (a nervous sender).
      for (let i = 0; i < 3; i++) { nc.publish(`mesh.agent.${idA}.inbox`, bytes); }
      await nc.flush();
      await sleep(1500);

      const ran = counts.get(envR.id) ?? 0;
      if (ran !== 1) fails.push(`handler executed ${ran} times for one envelope id, want exactly 1`);

      // A DIFFERENT envelope with the same content still executes (dedup is
      // by id, not by content — §5.5).
      const envR2 = signEnvelope(createEnvelope({
        type: "request", from: kpS.getPublicKey(), to: idA,
        payload: { skill: "echo", input: { n: 1 } },
      }), kpS);
      const second = JSON.parse(td.decode((await nc.request(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(envR2)), { timeout: 8000 })).data));
      if (second.error) fails.push(`fresh envelope errored: ${second.error.message}`);
      if ((counts.get(envR2.id) ?? 0) !== 1) fails.push("fresh envelope with same content did not execute");
    } finally {
      await a.deregister().catch(() => {});
      await a.close().catch(() => {});
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "one envelope retried 4x executed once; a fresh envelope with identical content executed normally" };
  },
};
