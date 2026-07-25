// §10.14: the pre-admission read. Two doors, one document:
//   (a) mesh-native: a request with skill "describe" answered with
//       {agent_id, card?, public} — fast, because nothing thinks.
//   (b) HTTPS: the same document at <home-mesh>/a/<agent-id>, readable by
//       anything that speaks the web.
import { meshConnect, signedRequest, inboxRequest } from "../lib/mesh.mjs";
import { resolveAgentId } from "../lib/env.mjs";

export default {
  id: "t05",
  title: "describe: pre-admission storefront over mesh and HTTPS",
  spec: "SPEC.md §10.14, §8.7",
  async run(env) {
    const agentId = await resolveAgentId(env.registrar, env.echoTarget);
    const problems = [];

    // (a) mesh-native describe
    const nc = await meshConnect(env);
    try {
      const t0 = Date.now();
      const reply = await inboxRequest(nc, agentId, signedRequest(env, { to: agentId, skill: "describe" }), 10_000);
      const ms = Date.now() - t0;
      const payload = reply?.payload?.output ?? reply?.payload;
      if (!reply) {
        problems.push("mesh describe: no reply at all");
      } else if (!payload || typeof payload !== "object" || !("public" in payload) || !("agent_id" in payload)) {
        problems.push(`mesh describe: reply is not the §10.14 response shape (got: ${JSON.stringify(payload).slice(0, 120)})`);
      } else if (ms > 3_000) {
        problems.push(`mesh describe: took ${ms}ms — a declared document should answer in well under a second; this smells like a model call`);
      }
    } finally {
      await nc.close().catch(() => {});
    }

    // (b) HTTPS storefront at the RECOMMENDED convention
    try {
      const res = await fetch(`${env.storefrontBase}/a/${agentId}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        problems.push(`HTTPS storefront: GET ${env.storefrontBase}/a/<agent-id> returned ${res.status}`);
      } else {
        const body = await res.json().catch(() => null);
        if (!body || !("public" in body)) problems.push("HTTPS storefront: 200 but no public block in the body");
      }
    } catch (e) {
      problems.push(`HTTPS storefront: ${String(e.message ?? e)}`);
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "describe answers pre-admission on both doors with the §10.14 shape" };
  },
};
