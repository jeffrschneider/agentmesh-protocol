// c11 — offline delivery: the mailbox holds, the agent drains, the reply
// comes home. Proves the plans-page promise end to end on a real mesh:
//
//   1. a registered agent gets a mailbox stream with the published bounds
//   2. a request sent while it is offline is captured (sender sees silence,
//      not loss)
//   3. on reconnect the agent drains, handles, and answers to the SENDER's
//      inbox, correlated by in_reply_to (§6.4 queued outcome)
//   4. a live request is handled exactly once (dedup across the live
//      subscription and the buffer consumer, §5.5)
//   5. deregistration deletes the mailbox (§16.4 lifecycle)
//
// Needs an SDK with the drain (>= the offline-delivery commit): run with
// AGENTMESH_SDK pointing at a local sdk-typescript build until published.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c11",
  title: "offline delivery: mailbox holds, agent drains, reply comes home",
  spec: "§6.4, §16.4, §18.3/18.6",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    if (!AgentMesh?.connect) return { status: "error", detail: "SDK under test exports no AgentMesh.connect" };

    // Fresh identities for this run: the receiving agent A and the sender S.
    const seedA = td.decode(nkeys.createUser().getSeed());
    const kpS = nkeys.createUser();
    const idS = kpS.getPublicKey();

    const handled = new Map(); // envelope id -> times handled by A
    const mkAgent = async () => {
      const a = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: seedA });
      a.onRequest("echo", async (input, ctx) => {
        const id = ctx?.envelope?.id ?? "?";
        handled.set(id, (handled.get(id) ?? 0) + 1);
        return { echoed: input, by: "c11-a" };
      });
      await a.register({ name: "c11-offline-a", description: "conformance c11", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c11" }] });
      return a;
    };

    // Raw connection for the sender + JetStream inspection.
    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const jsm = await nc.jetstreamManager();
    const inboxS = `mesh.agent.${idS}.inbox`;
    const replies = [];
    const subS = nc.subscribe(inboxS);
    (async () => { for await (const m of subS) { try { replies.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();

    let a = await mkAgent();
    const idA = a.agentId ?? nkeys.fromSeed(te.encode(seedA)).getPublicKey();
    const stream = `MESH_INBOX_${idA}`;
    const fails = [];
    try {
      // (1) mailbox exists with the published bounds
      await sleep(1500); // registry creates it fire-and-forget
      let info;
      try { info = await jsm.streams.info(stream); }
      catch { return { status: "fail", detail: `no mailbox stream ${stream} after registration — registry side not deployed?` }; }
      const cfg = info.config;
      if (cfg.max_bytes !== 25 * 1024 * 1024) fails.push(`max_bytes=${cfg.max_bytes}, want 25MB`);
      if (cfg.max_age !== 7 * 24 * 3600_000 * 1_000_000) fails.push(`max_age=${cfg.max_age}, want 7d`);
      if (cfg.discard !== "old") fails.push(`discard=${cfg.discard}, want old`);
      // Without no_ack, JetStream pub-acks race the agent's real replies on
      // LIVE request/reply — the capture must be silent.
      if (cfg.no_ack !== true) fails.push("no_ack is not set — capture answers reply subjects and races live replies");

      // (2) offline capture: stop A, send, observe silence + capture
      await a.close();
      await sleep(500);
      const reqEnv = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 1, note: "sent while offline" } },
      }), kpS);
      let liveReply = null;
      try {
        const m = await nc.request(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(reqEnv)), { timeout: 3000 });
        liveReply = JSON.parse(td.decode(m.data));
      } catch { /* timeout or no-responders: expected while offline */ }
      if (liveReply && !liveReply.error) fails.push("got a live reply from a closed agent — test rig broken");
      const captured = (await jsm.streams.info(stream)).state.messages;
      if (captured < 1) fails.push(`offline request not captured (stream has ${captured} messages)`);

      // (3) reconnect: drain, handle, reply lands in S's inbox
      a = await mkAgent();
      let drained = null;
      for (let i = 0; i < 20 && !drained; i++) {
        await sleep(500);
        drained = replies.find((r) => r.in_reply_to === reqEnv.id) ?? null;
      }
      if (!drained) fails.push("no reply to the offline request arrived at the sender's inbox within 10s");
      else if (drained.error) fails.push(`drained reply is an error: ${drained.error.message}`);
      if (handled.get(reqEnv.id) !== 1) fails.push(`offline request handled ${handled.get(reqEnv.id) ?? 0} times, want 1`);

      // (4) dedup: a live request is handled exactly once despite two delivery paths
      const liveEnv = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 2, note: "sent while live" } },
      }), kpS);
      const liveResp = JSON.parse(td.decode(
        (await nc.request(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(liveEnv)), { timeout: 10_000 })).data));
      if (liveResp.error) fails.push(`live request errored: ${liveResp.error.message}`);
      await sleep(2500); // give the buffer consumer time to double-deliver, if it wrongly would
      if (handled.get(liveEnv.id) !== 1) fails.push(`live request handled ${handled.get(liveEnv.id) ?? 0} times, want exactly 1`);

      // (5) deregistration deletes the mailbox
      await a.deregister();
      await sleep(1500);
      let gone = false;
      try { await jsm.streams.info(stream); } catch { gone = true; }
      if (!gone) fails.push("mailbox stream survived deregistration");
    } finally {
      try { await a.close(); } catch { /* already closed */ }
      try { await jsm.streams.delete(stream); } catch { /* already gone */ }
      await nc.close().catch(() => {});
    }

    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "held while offline, drained on return, replied to sender's inbox, deduped live, mailbox lifecycle clean" };
  },
};
