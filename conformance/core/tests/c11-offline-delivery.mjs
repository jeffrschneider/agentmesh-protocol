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
// The receiving agent is the AGENT UNDER TEST (../lib/agent-under-test.mjs), so
// this runs against whichever SDK AGENTMESH_AGENT_SDK names. That is the point
// of converting it: the drain is the most delivery-critical thing an SDK does
// and it is invisible from outside — an implementation with no drain at all
// registers, heartbeats, looks healthy, and quietly never answers a single
// message that arrived while it was away. Nothing but a real broker and a real
// second incarnation can tell the difference, and step 3 is where each SDK has
// to work out for itself that the requester's `_INBOX.` reply subject died with
// its process and the answer belongs on the sender's own inbox instead.
//
// Everything that is NOT the agent stays on raw NATS here: the sender, the
// JetStream inspection of the mailbox's bounds and lifecycle, and the reply
// capture. Those are the mesh's obligations, and holding them fixed is what
// makes a red result a statement about the SDK.
//
// Needs an SDK with the drain (>= the offline-delivery commit): run with
// AGENTMESH_SDK pointing at a local sdk-typescript build until published.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { launchAgent, requireAgentOps } from "../lib/agent-under-test.mjs";

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
    // Declared up front so an implementation that cannot come back and answer
    // reports not-validated rather than a pass or a mystery timeout.
    requireAgentOps("register", "respond", "deregister");

    // One identity, two incarnations. The seed is minted HERE and handed to both
    // launches: a drain means nothing unless the agent that comes back is the
    // same agent that went away, and the harness owning the identity is what
    // makes that true for every implementation.
    const seedA = td.decode(nkeys.createUser().getSeed());
    const kpS = nkeys.createUser();
    const idS = kpS.getPublicKey();

    const incarnations = [];
    const boot = async () => {
      const a = await launchAgent(env, { seed: seedA });
      incarnations.push(a);
      try {
        await a.register({
          name: "c11-offline-a", visibility: "unlisted",
          skills: [{ id: "echo", name: "echo", description: "c11" }],
        });
      } catch (e) {
        await a.close().catch(() => {}); // never leave a child process behind
        throw e;
      }
      return a;
    };
    // Counted across BOTH incarnations, because "handled exactly once" has to
    // mean once on this mesh and not once per process — a message handled by the
    // first incarnation and again by the second is the exact double delivery
    // §5.5 exists to forbid, and per-process counting would call it clean.
    const handledCount = (id) =>
      incarnations.reduce((n, a) => n + a.handled.filter((h) => h.envelope_id === id).length, 0);
    // An out-of-process agent reports what it dispatched on its own channel, so
    // give that report a bounded moment to land before counting. The assertion
    // does not weaken — the count must still be EXACTLY one.
    const settle = async (id, want) => { for (let i = 0; i < 30 && handledCount(id) < want; i++) await sleep(100); };

    // Raw connection for the sender + JetStream inspection.
    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const jsm = await nc.jetstreamManager();
    const inboxS = `mesh.agent.${idS}.inbox`;
    const replies = [];
    const subS = nc.subscribe(inboxS);
    (async () => { for await (const m of subS) { try { replies.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();

    let a;
    try { a = await boot(); }
    catch (e) { await nc.close().catch(() => {}); throw e; }
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
      a = await boot();
      let drained = null;
      for (let i = 0; i < 20 && !drained; i++) {
        await sleep(500);
        drained = replies.find((r) => r.in_reply_to === reqEnv.id) ?? null;
      }
      if (!drained) fails.push(`no reply to the offline request arrived at the sender's inbox within 10s. agent output: ${a.log()}`);
      else if (drained.error) fails.push(`drained reply is an error: ${drained.error.message}`);
      // Not just a correlated envelope — the ANSWER. A reply that comes home
      // empty would satisfy in_reply_to and deliver nothing.
      else if (drained.payload?.output?.ok?.n !== 1) fails.push(`drained reply carries no answer: ${JSON.stringify(drained.payload)?.slice(0, 160)}`);
      await settle(reqEnv.id, 1);
      if (handledCount(reqEnv.id) !== 1) fails.push(`offline request handled ${handledCount(reqEnv.id)} times, want 1`);

      // (4) dedup: a live request is handled exactly once despite two delivery paths
      const liveEnv = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 2, note: "sent while live" } },
      }), kpS);
      let liveResp = null;
      try {
        liveResp = JSON.parse(td.decode(
          (await nc.request(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(liveEnv)), { timeout: 10_000 })).data));
      } catch (e) {
        // A live request to a registered, listening agent that is never answered
        // on its reply subject is the §6.4 defect this test exists to see, so it
        // gets a verdict with a diagnosis rather than escaping as an unexplained
        // TIMEOUT. The two delivery paths answer DIFFERENT subjects — live on the
        // requester's reply subject, drained on the sender's own inbox (§16.4) —
        // and the mailbox captures the very subject the live message arrived on,
        // so whichever path dispatches first also decides where the answer goes
        // and §5.5 dedup silences the other. Which one it was is observable, not a
        // guess: the sender's inbox is already being collected above.
        await sleep(2500);
        const elsewhere = replies.find((r) => r.in_reply_to === liveEnv.id);
        fails.push(elsewhere
          ? "a LIVE request was answered on the sender's INBOX instead of on its reply subject: the §16.4 mailbox " +
            "drain dispatched it before the live subscription did, so every ordinary requester of this agent waits " +
            "out its timeout while the answer arrives somewhere it is not listening"
          : `a live request to a registered, listening agent was never answered at all (${String(e?.message ?? e)}). agent output: ${a.log()}`);
      }
      if (liveResp?.error) fails.push(`live request errored: ${liveResp.error.message}`);
      await sleep(2500); // give the buffer consumer time to double-deliver, if it wrongly would
      if (handledCount(liveEnv.id) !== 1) fails.push(`live request handled ${handledCount(liveEnv.id)} times, want exactly 1`);

      // (5) deregistration deletes the mailbox
      await a.deregister();
      await sleep(1500);
      let gone = false;
      try { await jsm.streams.info(stream); } catch { gone = true; }
      if (!gone) fails.push("mailbox stream survived deregistration");
    } finally {
      for (const inc of incarnations) await inc.close().catch(() => {});
      try { await jsm.streams.delete(stream); } catch { /* already gone */ }
      await nc.close().catch(() => {});
    }

    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "held while offline, drained on return, replied to sender's inbox, deduped live, mailbox lifecycle clean" };
  },
};
