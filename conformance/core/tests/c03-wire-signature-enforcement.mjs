// c03 — wire-level signature enforcement (§4.5, §5.3): the unit tests prove
// the verify FUNCTIONS work; this proves the LIVE paths use them. An
// unsigned request and a tampered request sent to a real responder are
// refused without the handler ever running; the registry refuses a
// registration whose node vouch is forged, over the wire.
//
// The responder here is the AGENT UNDER TEST (../lib/agent-under-test.mjs), so
// this test runs against whichever SDK AGENTMESH_AGENT_SDK names — TypeScript
// in this process by default, or another implementation as a child process.
// That matters most for exactly this property: refusing an unsigned, tampered
// or mis-attributed envelope before the handler is a security invariant each
// SDK implements for itself from the spec, and it is precisely what a second
// implementation is most likely to get wrong. The forging is all done here on
// raw NATS, and the registry half is not agent-side at all, so both stay put.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { launchAgent, requireAgentOps } from "../lib/agent-under-test.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c03",
  title: "unsigned and tampered envelopes die at the wire, not in handlers",
  spec: "§4.5, §5.3, §4.4",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    // Declared up front: an implementation that cannot register and answer a
    // skill reports not-validated rather than a pass or a mystery timeout.
    requireAgentOps("register", "respond");

    // The responder, in whichever SDK this run selected. `a.handled` is what it
    // reports having dispatched — one entry per handler execution.
    const a = await launchAgent(env);
    try {
      await a.register({ name: "c03-target", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c03" }] });
    } catch (e) {
      await a.close(); // never leave a child process behind on a boot failure
      throw e;
    }
    const handled = () => a.handled.length;
    // An out-of-process agent reports what it dispatched on its own channel, so
    // give that report a bounded moment to land before counting. It does not
    // weaken the assertion — the count must still be EXACTLY one — it only
    // stops a pipe that is a millisecond behind a cross-continent NATS reply
    // from reading as "the handler never ran".
    const settle = async (want) => { for (let i = 0; i < 30 && handled() < want; i++) await sleep(100); };
    const idA = a.agentId;

    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    const kpS = nkeys.createUser();
    const idS = kpS.getPublicKey();
    const ask = async (bytes) => {
      try {
        const m = await nc.request(`mesh.agent.${idA}.inbox`, bytes, { timeout: 4000 });
        return JSON.parse(td.decode(m.data));
      } catch { return null; } // silence is also a refusal
    };
    try {
      // Control: a properly signed request lands.
      const good = signEnvelope(createEnvelope({ type: "request", from: idS, to: idA, payload: { skill: "echo", input: { n: 1 } } }), kpS);
      const goodReply = await ask(te.encode(JSON.stringify(good)));
      if (goodReply?.error || goodReply?.payload?.output?.ok?.n !== 1) fails.push(`control request failed: ${JSON.stringify(goodReply)?.slice(0, 120)}`);
      await settle(1);
      if (handled() !== 1) fails.push(`control: handler ran ${handled()} times, want 1`);

      // Unsigned: same envelope, sig stripped.
      const unsigned = { ...signEnvelope(createEnvelope({ type: "request", from: idS, to: idA, payload: { skill: "echo", input: { n: 2 } } }), kpS) };
      delete unsigned.sig;
      const r1 = await ask(te.encode(JSON.stringify(unsigned)));
      if (r1 && !r1.error) fails.push("unsigned request was ANSWERED without error");

      // Tampered: signed, then payload altered after signing.
      const tampered = signEnvelope(createEnvelope({ type: "request", from: idS, to: idA, payload: { skill: "echo", input: { n: 3 } } }), kpS);
      tampered.payload.input.n = 999;
      const r2 = await ask(te.encode(JSON.stringify(tampered)));
      if (r2 && !r2.error) fails.push("tampered request was ANSWERED without error");

      // Mis-attributed: signed by S but claiming to be from another key.
      const stolen = createEnvelope({ type: "request", from: nkeys.createUser().getPublicKey(), to: idA, payload: { skill: "echo", input: { n: 4 } } });
      signEnvelope(stolen, kpS); // sig verifies against S, not against `from`
      const r3 = await ask(te.encode(JSON.stringify(stolen)));
      if (r3 && !r3.error) fails.push("mis-attributed request was ANSWERED without error");

      await sleep(1000);
      if (handled() !== 1) fails.push(`handler ran ${handled()} times total, want exactly 1 (the control)`);

      // Registry, over the wire: a manifest whose node vouch is forged.
      const kpM = nkeys.createUser();
      const idM = kpM.getPublicKey();
      const manifest = {
        id: idM, name: "c03-forged", description: "", version: "0.1.0", endpoint: `mesh.agent.${idM}.inbox`,
        node: { id: idM, attestation: { node: idM, agent: idM, expires_at: new Date(Date.now() + 3600_000).toISOString(), sig: "Zm9yZ2VkLXNpZ25hdHVyZQ" } },
        capabilities: [], skills: [],
      };
      const regEnv = signEnvelope(createEnvelope({ type: "register", from: idM, payload: manifest }), kpM);
      let regReply = null;
      try {
        const m = await nc.request("mesh.registry.register", te.encode(JSON.stringify(regEnv)), { timeout: 5000 });
        regReply = JSON.parse(td.decode(m.data));
      } catch { /* silence counts as refusal */ }
      if (regReply && !regReply.error) fails.push("registry ACCEPTED a manifest with a forged node vouch");
    } finally {
      await a.deregister().catch(() => {});
      await a.close().catch(() => {});
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "control landed; unsigned, tampered, and mis-attributed all refused before the handler; forged vouch refused by the live registry" };
  },
};
