// SPEC-NAMING §7 obligation 8: the eviction papers. After a valid re-home the
// OLD registrar must serve a referral to the new custodian AND refuse to
// re-issue the departed name — the clause that makes custodians fireable. Runs
// the same flow as t07 against the rig, asserting the old-side obligations.
import { runRehome } from "../rig/rehome-flow.mjs";

export default {
  id: "t08",
  title: "migration-out: old registrar refers, and cannot re-issue",
  spec: "SPEC-NAMING §7.8, §5.6",
  async run(env) {
    if (!env.registrarA || !env.registrarB) {
      return { status: "env-skip", detail: "set REGISTRAR_A and REGISTRAR_B (run rig/two-registrars.sh)" };
    }
    const r = await runRehome((env.rehomeNonce ?? Date.now().toString()).slice(-6) + "b");
    const problems = [];
    if (!r.referral || r.referral.registrar !== env.registrarB) problems.push(`old registrar did not serve a referral to the new one (got ${JSON.stringify(r.referral)})`);
    if (!r.reclaimRefused) problems.push("old registrar RE-ISSUED a departed handle — §7.8 says a name its owner moved is not the registrar's to keep");
    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: `old registrar referrals to the new custodian and refuses re-issue ("${r.reclaimError}")` };
  },
};
