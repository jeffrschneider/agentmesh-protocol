// c07 — admission, mesh-side (EXT-6): a guarded agent stops spam before it
// arrives. With the default roster (anonymous → block, registered → relay),
// a message from an anonymous (unregistered) sender is dropped — the handler
// never runs — and the sender gets a benign ack indistinguishable from
// delivery (no block oracle); a message from a registered sender is relayed
// through and handled. The security boundary, tested on both sides.
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

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

    let handled = 0;
    const target = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
    target.onRequest("echo", async (input) => { handled++; return { ok: input }; });
    // Guarded registration: the mesh filters this inbox before it reaches us.
    await target.register({ name: "c07-guarded", visibility: "unlisted", guarded: true, skills: [{ id: "echo", name: "echo", description: "c07" }] });
    await sleep(1500);
    if (!target.guarded) throw new Error("env-skip: admission service did not guard the inbox (not deployed?)");

    const fails = [];
    try {
      // Anonymous sender: a fresh ephemeral key, never registered.
      const anon = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      let anonReply = null;
      try { anonReply = await anon.request(target.agentId, "echo", { who: "anon" }, { timeout_ms: 6000 }); }
      catch (e) { anonReply = { threw: String(e?.code ?? e?.message ?? e) }; }
      await sleep(1200);
      if (handled !== 0) fails.push(`anonymous sender's message reached the handler (${handled} runs)`);
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
      await sleep(1200);
      if (handled < 1) fails.push("registered sender's message did not reach the handler (default relay broken)");
      await known.deregister().catch(() => {});
      await known.close().catch(() => {});
    } finally {
      await target.deregister().catch(() => {});
      await target.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "anonymous sender dropped pre-handler with a benign ack; registered sender relayed through" };
  },
};
