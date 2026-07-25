// The §21 acceptance run against the two-mesh rig (rig/two-meshes.sh peers
// mesh A ws 14461 and mesh B ws 14462 by a gateway). A responder lives on B; a
// client on A reaches it ACROSS the boundary: the envelope verifies end to end
// regardless of which mesh carried it, and the pre-admission read crosses.
// When the rig is absent the test pends on a peer — never a regression
// (run.mjs treats pending as not-evaluated).
//
// WHAT THIS DOES NOT PROVE — read before quoting it as "federation works":
//
//  * No AgentMesh component is under test. The responder, its describe answer
//    and its hops check are all written in this file. What is proven is that
//    a gateway carries the traffic and that the ENVELOPE FORMAT survives the
//    trip — carrier independence (§21.1), not a working peer implementation.
//  * The rig runs with NO auth and no accounts, while production runs the
//    operator→account→user JWT model with `mesh.peer.>` denied (t03). Two
//    deployments under different operators need explicit account import/export
//    for a gateway to carry anything, and none of that is exercised here.
//  * JetStream does not cross a gateway. The registry KV, task streams and
//    rooms are all JetStream, so nothing built on them federates through the
//    link this test uses. Core request/reply is what crosses.
//  * The hops guard is enforced at the RECIPIENT, because no relay
//    implementation exists to enforce it in transit. Nothing in the rig
//    increments `hops`; the loop-kill case proves a recipient refuses a
//    marked envelope, which is the weaker half of §21.2.
//  * The attestation case does not cross anything — the issuer key is created
//    in this process. What it proves is that verification consults no mesh
//    and no registry, which is the portability claim (§9.7); "foreign" here
//    means "issued by an operator this node has never seen", not "arrived
//    from mesh B".
//
// Standing up a real second instance is gated on the account-topology
// decision, not on this test going green.
import { connect } from "nats.ws";
import nkeys from "nkeys.js";
import { createEnvelope, signEnvelope, verifyEnvelopeSig, createTrustAttestation, verifyTrustAttestation } from "../lib/sdk.mjs";

const te = new TextEncoder(), td = new TextDecoder();

function signedRequest(kp, from, to, skill, meta) {
  return signEnvelope(createEnvelope({ type: "request", from, to, payload: { skill, input: null }, ...(meta ? { meta } : {}) }), kp);
}

export default {
  id: "t10",
  title: "peered pair: request and describe cross a gateway with the envelope intact",
  spec: "SPEC.md §21 (acceptance), §10.14, §9.7",
  async run(env) {
    if (!env.meshAWs || !env.meshBWs) {
      return { status: "pending-peer", detail: "requires the two-mesh rig (run rig/two-meshes.sh; sets PEER_MESH_A_WS / PEER_MESH_B_WS)" };
    }
    const problems = [];
    let ncB, ncA;
    try {
      // Responder lives on mesh B: its own key, answering describe/echo with
      // signed envelopes, honoring the §21.2 hops guard.
      const respKp = nkeys.createUser();
      const respId = respKp.getPublicKey();
      const respPublic = { description: "peer responder on mesh B", skills: ["echo"] };
      ncB = await connect({ servers: env.meshBWs, timeout: 8000 });
      const subj = `mesh.agent.${respId}.inbox`;
      const sub = ncB.subscribe(subj);
      (async () => {
        for await (const m of sub) {
          let env2; try { env2 = JSON.parse(td.decode(m.data)); } catch { continue; }
          if (!verifyEnvelopeSig(env2)) continue;                        // reject unsigned/forged
          const hops = env2.meta?.hops;
          if (typeof hops === "number" && hops > 3) continue;            // §21.2 loop kill
          const skill = env2.payload?.skill;
          const out = skill === "describe" ? { agent_id: respId, public: respPublic } : { echo: true, at: env2.id };
          const reply = signEnvelope(createEnvelope({ type: "respond", from: respId, to: env2.from, in_reply_to: env2.id, payload: { output: out } }), respKp);
          if (m.reply) ncB.publish(m.reply, te.encode(JSON.stringify(reply)));
        }
      })().catch(() => {});
      await ncB.flush();

      // Client lives on mesh A: everything below crosses the gateway to B.
      const cliKp = nkeys.createUser();
      const cliId = cliKp.getPublicKey();
      ncA = await connect({ servers: env.meshAWs, timeout: 8000 });

      const ask = async (skill, meta) => {
        try {
          const msg = await ncA.request(subj, te.encode(JSON.stringify(signedRequest(cliKp, cliId, respId, skill, meta))), { timeout: 6000 });
          return JSON.parse(td.decode(msg.data));
        } catch { return null; }
      };

      // (3) request/respond across the boundary, envelope verifies end to end
      const echo = await ask("echo");
      if (!echo) problems.push("cross-instance request got no reply — the gateway did not route it");
      else if (!verifyEnvelopeSig(echo)) problems.push("cross-instance reply envelope failed signature verification (carrier independence broken)");
      else if (echo.from !== respId) problems.push("reply came from the wrong key");

      // (2) describe across the boundary (§10.14)
      const desc = await ask("describe");
      if (!desc || desc.payload?.output?.public?.description !== respPublic.description) {
        problems.push("describe did not cross the boundary intact");
      }

      // (5) an envelope marked over the hop bound is refused. NOTE: refused
      // BY THE RECIPIENT — no relay exists to drop it in transit, so this is
      // the weaker half of §21.2 (see the header).
      const looped = await ask("echo", { hops: 99 });
      if (looped !== null) problems.push("an envelope with meta.hops=99 was answered across the boundary — the relay guard did not hold");

      // (4) an attestation from an operator this process has never seen
      // verifies with no mesh and no registry consulted (§9.7). It does not
      // cross the boundary; portability is the claim, not transit.
      const foreignOp = nkeys.createAccount();
      const att = createTrustAttestation(foreignOp, respId, { trust_tier: "standard" });
      if (!verifyTrustAttestation(att, respId)) problems.push("an unknown operator's attestation did not verify offline");
    } catch (e) {
      return { status: "fail", detail: `rig error: ${String(e.message ?? e)}` };
    } finally {
      try { await ncA?.close(); } catch { /* */ }
      try { await ncB?.close(); } catch { /* */ }
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "request + describe crossed A→B with the envelope verifying end to end; an over-bound envelope was refused at the recipient; an unknown operator's attestation verified offline" };
  },
};
