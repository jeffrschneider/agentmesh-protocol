// SPEC-NAMING §5.6: moving custodians is not an identity event. Against the
// two-registrar rig (rig/two-registrars.sh sets REGISTRAR_A/B): claim+bind on
// A, key-sign pan-rehome-v1, move to B, and assert the identity-preserving
// properties — B serves the card with rehomed provenance, A referrals, and the
// agent key is byte-identical across the move so a consumer's pin never alarms.
import { runRehome } from "../rig/rehome-flow.mjs";

export default {
  id: "t07",
  title: "re-homing: custodian moves, key unchanged, pins stay silent",
  spec: "SPEC-NAMING §5.6",
  async run(env) {
    if (!env.registrarA || !env.registrarB) {
      return { status: "env-skip", detail: "set REGISTRAR_A and REGISTRAR_B (run rig/two-registrars.sh)" };
    }
    const r = await runRehome((env.rehomeNonce ?? Date.now().toString()).slice(-6));
    const problems = [];
    if (r.out.status !== 200) problems.push(`rehome-out failed: ${JSON.stringify(r.out.body)}`);
    if (r.inn.status !== 200) problems.push(`rehome-in failed: ${JSON.stringify(r.inn.body)}`);
    if (!r.referral || r.referral.registrar !== env.registrarB) problems.push(`A did not referral to B (got ${JSON.stringify(r.referral)})`);
    if (r.bCardClaimedVia !== `rehomed:${env.registrarA}`) problems.push(`B card provenance wrong: ${r.bCardClaimedVia}`);
    if (!r.keyUnchanged) problems.push(`agent key changed across the move (${r.cardKeyBefore} → ${r.cardKeyAfter}) — a pin WOULD alarm; re-homing must not touch identity`);
    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "handle moved A→B; B serves it with rehomed:<A> provenance; key identical, so pins stay silent" };
  },
};
