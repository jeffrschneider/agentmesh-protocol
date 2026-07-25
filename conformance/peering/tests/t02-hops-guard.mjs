// §21 constraint 2 / §5: an envelope whose meta.hops exceeds the bound MUST be
// dropped. Probe: send an echo request (daemon-answered, no model) carrying
// meta.hops far over the bound. A reply means the mesh relayed a loop-worn
// envelope — the guard is not implemented.
import { meshConnect, signedRequest, inboxRequest } from "../lib/mesh.mjs";
import { resolveAgentId } from "../lib/env.mjs";

export default {
  id: "t02",
  title: "relay guard: meta.hops over the bound is dropped",
  spec: "SPEC.md §21.2, §5",
  async run(env) {
    const agentId = await resolveAgentId(env.registrar, env.echoTarget);
    const nc = await meshConnect(env);
    try {
      const envelope = signedRequest(env, {
        to: agentId,
        skill: "__diag_echo__",
        input: { probe: "hops-guard" },
        meta: { hops: 99 },
      });
      const reply = await inboxRequest(nc, agentId, envelope, 8_000);
      if (reply === null) {
        return { status: "pass", detail: "hops=99 envelope was not delivered (dropped or refused)" };
      }
      return {
        status: "fail",
        detail: "echo replied to an envelope carrying meta.hops=99 — nothing enforces the relay guard yet",
      };
    } finally {
      await nc.close().catch(() => {});
    }
  },
};
