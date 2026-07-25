// c02 — the task lifecycle driven over the wire (§7): a responder walks a
// task submitted → working → input_required → working → completed by
// publishing signed updates to mesh.task.{id}.update; the requester observes
// every transition live; the task manager's KV state (mesh.task.get.{id})
// agrees; and a post-terminal update is REFUSED — state stays completed and
// the manager emits task.invalid_transition (§7.3).
//
// The state table was unit-tested; this proves the live service enforces it.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c02",
  title: "task lifecycle on the wire: transitions observed, terminal enforced",
  spec: "§7.2, §7.3, §14.1",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const nc = await connect({
      servers: env.meshWsUrl,
      authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
      timeout: 15_000, maxReconnectAttempts: 0,
    });
    const fails = [];
    try {
      const kpR = nkeys.createUser(); // the responder driving the task
      const idR = kpR.getPublicKey();
      const kpQ = nkeys.createUser(); // the requester observing it
      const idQ = kpQ.getPublicKey();
      const taskId = `c02-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

      // The requester's view: live updates on the task subject.
      const seen = [];
      const updSub = nc.subscribe(`mesh.task.${taskId}.update`);
      (async () => {
        for await (const m of updSub) {
          try { seen.push(JSON.parse(td.decode(m.data)).payload?.status); } catch { /* skip */ }
        }
      })();
      // Invalid-transition observability (§7.3).
      const invalids = [];
      const invSub = nc.subscribe("mesh.event.task.invalid_transition");
      (async () => {
        for await (const m of invSub) {
          try { const e = JSON.parse(td.decode(m.data)); if (e.payload?.data?.task_id === taskId) invalids.push(e.payload.data); } catch { /* skip */ }
        }
      })();

      const update = (status) => {
        const envU = signEnvelope(createEnvelope({
          type: "respond", from: idR, to: idQ, task_id: taskId,
          payload: { status, message: `c02 ${status}` },
        }), kpR);
        nc.publish(`mesh.task.${taskId}.update`, te.encode(JSON.stringify(envU)));
      };
      const getState = async () => {
        const q = signEnvelope(createEnvelope({ type: "request", from: idQ, to: "mesh.service.task-manager", payload: {} }), kpQ);
        try {
          const m = await nc.request(`mesh.task.get.${taskId}`, te.encode(JSON.stringify(q)), { timeout: 5000 });
          return JSON.parse(td.decode(m.data)).payload?.task?.state ?? JSON.parse(td.decode(m.data)).payload?.state ?? null;
        } catch { return null; }
      };

      // Walk the lifecycle with the §7.2 states, checking KV agreement at the joints.
      const walk = ["submitted", "working", "input_required", "working", "completed"];
      for (const s of walk) { update(s); await sleep(700); }
      const finalState = await getState();
      if (finalState !== "completed") fails.push(`task manager state=${finalState}, want completed`);
      // The requester saw every transition, in order.
      const seenStr = seen.join(",");
      if (seenStr !== walk.join(",")) fails.push(`requester observed [${seenStr}], want [${walk.join(",")}]`);

      // Post-terminal update must be refused: state unchanged, violation emitted.
      update("working");
      await sleep(1500);
      const afterState = await getState();
      if (afterState !== "completed") fails.push(`post-terminal update changed state to ${afterState}`);
      if (invalids.length !== 1) fails.push(`invalid_transition events for this task: ${invalids.length}, want 1`);

      updSub.unsubscribe(); invSub.unsubscribe();
    } finally {
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "five transitions observed in order, KV agrees, terminal state immutable, violation event emitted" };
  },
};
