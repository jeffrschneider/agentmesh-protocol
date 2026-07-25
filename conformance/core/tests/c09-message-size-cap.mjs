// c09 — the 1 MB message cap (§18.9): an oversized request fails fast with a
// defined error, not a hang; a payload under the cap crosses fine. The
// failure mode had never been observed before this test.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();

export default {
  id: "c09",
  title: "1 MB cap: oversized fails fast and defined, under-cap crosses",
  spec: "§18.9",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    const a = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: td.decode(nkeys.createUser().getSeed()) });
    a.onRequest("echo", async (input) => ({ bytes: JSON.stringify(input).length }));
    await a.register({ name: "c09-target", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c09" }] });
    const idA = a.agentId;

    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    try {
      const kpS = nkeys.createUser();
      const mk = (n) => te.encode(JSON.stringify(signEnvelope(createEnvelope({
        type: "request", from: kpS.getPublicKey(), to: idA,
        payload: { skill: "echo", input: { blob: "x".repeat(n) } },
      }), kpS)));

      // Under the cap: 500 KB crosses and answers.
      const ok = JSON.parse(td.decode((await nc.request(`mesh.agent.${idA}.inbox`, mk(500_000), { timeout: 15_000 })).data));
      if (ok.error) fails.push(`500KB request errored: ${ok.error.message}`);

      // Over the cap: ~1.2 MB must fail FAST with a defined error, not hang.
      const t0 = Date.now();
      let outcome = "answered";
      try {
        await nc.request(`mesh.agent.${idA}.inbox`, mk(1_200_000), { timeout: 10_000 });
      } catch (e) {
        outcome = String(e?.code ?? e?.message ?? e);
      }
      const ms = Date.now() - t0;
      if (outcome === "answered") fails.push("a 1.2MB request was DELIVERED — the cap is not enforced");
      else if (/TIMEOUT/i.test(outcome)) fails.push(`oversized send HANGS to timeout (${ms}ms) instead of failing fast`);
      else if (ms > 3000) fails.push(`oversized send took ${ms}ms to fail (${outcome}) — not fast`);
      // else: fast, defined refusal (MAX_PAYLOAD_EXCEEDED or similar) — correct.
    } finally {
      await a.deregister().catch(() => {});
      await a.close().catch(() => {});
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "500KB crossed; 1.2MB refused fast with a defined client-side error" };
  },
};
