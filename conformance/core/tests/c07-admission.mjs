// c07 — admission, mesh-side (EXT-6): a guarded agent stops spam before it
// arrives. With the default roster (anonymous → block, registered → relay),
// a message from an anonymous (unregistered) sender is dropped — the handler
// never runs — and the sender gets a benign ack indistinguishable from
// delivery (no block oracle); a message from a registered sender is relayed
// through and handled. The security boundary, tested on both sides — and then
// re-registered, because guard state lives on the mesh and a second registration
// must leave it exactly where it was (safety item 4.4).
//
// The GUARDED agent is the AGENT UNDER TEST (../lib/agent-under-test.mjs), so
// this runs against whichever SDK AGENTMESH_AGENT_SDK names. The guard handshake
// is the reason: it is the one place where getting it wrong in the strict
// direction is silent and total — a guarded agent listens ONLY on the private
// `.guarded` subject, so an SDK that believes a guard it did not get registers,
// heartbeats, looks healthy and never receives another message — and every
// implementation writes that judgement for itself from EXT-6 §7.1.
//
// The two SENDERS stay on the reference SDK. They are the mesh's side of the
// boundary rather than the subject of this test, and holding them fixed is what
// makes a red result a statement about the agent under test.
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";
import { launchAgent, requireAgentOps } from "../lib/agent-under-test.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c07",
  title: "admission: anonymous senders dropped before the handler, registered relayed",
  spec: "EXT-6 §9.x",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const fresh = () => td.decode(nkeys.createUser().getSeed());
    // The second op is the one that matters: an implementation that accepts
    // `guarded` but cannot say which subject it ended up on reports
    // not-validated, because a harness that assumed the ask succeeded would
    // watch a subject nothing relays to and read the resulting silence as a
    // clean block.
    requireAgentOps("register", "respond", "register:guarded");

    // Whether the admission service is deployed on this mesh AT ALL, asked with
    // the reference SDK. Only ever called when the agent under test came back
    // unguarded, because that outcome has two completely different causes that
    // look identical from here: no admission service (a missing prerequisite,
    // env-skip) or an SDK that asked for a guard this mesh was willing to give
    // and did not end up with one (a defect, fail). Paying for the distinction
    // only on the failure path keeps a guard slot and a registration off the
    // happy path.
    const referenceGetsGuarded = async () => {
      const probe = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      try {
        probe.onRequest("noop", async () => ({}));
        await probe.register({ name: "c07-guard-probe", visibility: "unlisted", guarded: true, skills: [{ id: "noop", name: "noop", description: "c07" }] });
        await sleep(1500);
        return (probe.listeningOnGuarded ?? probe.guarded) === true;
      } finally {
        await probe.deregister().catch(() => {});
        await probe.close().catch(() => {});
      }
    };

    const target = await launchAgent(env);
    // What the handler actually saw, by sender rather than by count. The agent
    // reports the input it was given, so "the anonymous message never arrived"
    // can be asserted about that message and not about a total that any other
    // traffic could move.
    const sawFrom = (who) => target.handled.filter((h) => h.input?.who === who).length;
    const settle = async (who) => { for (let i = 0; i < 40 && sawFrom(who) < 1; i++) await sleep(100); };

    const fails = [];
    try {
      // Guarded registration: the mesh filters this inbox before it reaches us.
      const reg = await target.register({
        name: "c07-guarded", visibility: "unlisted", guarded: true,
        skills: [{ id: "echo", name: "echo", description: "c07" }],
      });
      await sleep(1500);
      if (!reg.guarded) {
        if (!(await referenceGetsGuarded())) {
          throw new Error("env-skip: admission service did not guard the inbox (not deployed?)");
        }
        return {
          status: "fail",
          detail:
            "the agent under test asked to be guarded and stayed on its public inbox, while a reference " +
            "agent asking the same thing on the same mesh in the same run WAS guarded — the guard " +
            `handshake is at fault, not the mesh. agent output: ${target.log()}`,
        };
      }

      // Anonymous sender: a fresh ephemeral key, never registered.
      const anon = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      let anonReply = null;
      try { anonReply = await anon.request(target.agentId, "echo", { who: "anon" }, { timeout_ms: 6000 }); }
      catch (e) { anonReply = { threw: String(e?.code ?? e?.message ?? e) }; }
      await sleep(1200);
      if (sawFrom("anon")) fails.push(`anonymous sender's message reached the handler (${sawFrom("anon")} runs)`);
      // Benign ack, not an error the sender could read as "blocked".
      if (anonReply?.payload?.error || (anonReply?.threw && /UNAVAILABLE|PERMISSION/i.test(anonReply.threw))) {
        fails.push("anonymous sender got a distinguishable refusal (block oracle) instead of a benign ack");
      }
      await anon.close().catch(() => {});

      // Registered sender: same message, but the sender has a manifest, so it
      // is 'registered' tier → default relay → the handler runs.
      const known = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      known.onRequest("noop", async () => ({}));
      await known.register({ name: "c07-known-sender", visibility: "unlisted", skills: [{ id: "noop", name: "noop", description: "c07" }] });
      await sleep(1000);
      try { await known.request(target.agentId, "echo", { who: "known" }, { timeout_ms: 8000 }); }
      catch { /* the point is whether the handler ran */ }
      await settle("known");
      if (!sawFrom("known")) fails.push(`registered sender's message did not reach the handler (default relay broken). agent output: ${target.log()}`);

      // Re-registration must not move the guard (safety item 4.4). Guard state is
      // mesh-side and was write-only: nothing revoked an entry and nothing
      // reconciled one against the agent's real subscription, so an agent guarded
      // on one boot came back un-guarded on the next while admission still
      // believed it was filtering. The SDK now revokes a guard it does not hold —
      // which must NOT fire when the guard WAS granted, because a guarded agent
      // keeps its live `.guarded` subscription across a re-registration and
      // revoking under it strands the agent on a subject nobody relays to. Both
      // halves checked here: still guarded, and still reachable.
      const again = await target.register({
        name: "c07-guarded", visibility: "unlisted", guarded: true,
        skills: [{ id: "echo", name: "echo", description: "c07" }],
      });
      await sleep(1500);
      if (!again.guarded) fails.push("re-registering dropped the guard: the agent fell back to its public inbox");
      try { await known.request(target.agentId, "echo", { who: "known-again" }, { timeout_ms: 8000 }); }
      catch { /* the point is whether the handler ran */ }
      await settle("known-again");
      // Two known ways to arrive here, and the assertion deliberately does not
      // pick one, because it can see the effect and not the cause:
      //   - the guard was revoked out from under a live `.guarded` subscription,
      //     so nothing relays to the subject this agent is listening on; or
      //   - an EARLIER relayed message was never answered on the reply subject
      //     admission relays with, so admission is still blocked awaiting it —
      //     its per-agent relay loop is sequential with a 35s timeout, and one
      //     unanswered relay stalls this agent's whole guarded inbox for that
      //     long. The §16.4 mailbox drain is one way to produce that, because a
      //     guarded agent's mailbox captures `.guarded`, so the drain races the
      //     live subscription for every relayed message and answers a DIFFERENT
      //     subject (the sender's inbox) when it wins.
      if (!sawFrom("known-again")) fails.push("after re-registering guarded, a registered sender's message no longer reached the handler — either the guard was revoked out from under a live .guarded subscription, or the mesh's relay is still blocked awaiting a reply to an earlier relayed message that this SDK answered somewhere else");

      // The negative, re-checked at the end: by now the mesh has relayed two
      // later messages down the same path, so an anonymous message that was
      // merely SLOW rather than dropped has had every chance to arrive.
      if (sawFrom("anon")) fails.push("the anonymous sender's message reached the handler eventually — dropped is not the same as delayed");

      await known.deregister().catch(() => {});
      await known.close().catch(() => {});
    } finally {
      await target.deregister().catch(() => {});
      await target.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "anonymous sender dropped pre-handler with a benign ack; registered sender relayed through; re-registration kept the guard and the delivery path" };
  },
};
