// SPEC-NAMING §5.6: a re-homed handle resolves THROUGH the referral.
//
// t07 proves the two registrars agree about a move: A serves a referral, B
// serves the card. That is the move as the registrars see it. This is the move
// as everyone else sees it — a resolver that knows only the old registrar must
// still land on the right key, because that is the entire point of a referral.
//
// It was not true when re-homing shipped: the registrars agreed, and every
// consumer (SDK, adapter, storefront) read "no card in response" and reported
// the agent as unresolvable. A handle that moved simply vanished.
import { runRehome } from "../rig/rehome-flow.mjs";
import { runResolver, jsonFrom } from "../lib/resolver.mjs";

export default {
  id: "t12",
  title: "referrals are followed: a re-homed handle still resolves at the old address",
  spec: "SPEC-NAMING §5.6",
  async run(env) {
    if (!env.registrarA || !env.registrarB) {
      return { status: "env-skip", detail: "set REGISTRAR_A and REGISTRAR_B (run rig/two-registrars.sh)" };
    }
    const moved = await runRehome(`f${(env.rehomeNonce ?? Date.now().toString()).slice(-5)}`);
    if (moved.inn.status !== 200) {
      return { status: "fail", detail: `the move itself failed, so referral following could not be tested: ${JSON.stringify(moved.inn.body)}` };
    }
    const problems = [];

    // The resolver is pointed at A — the OLD registrar, which no longer holds
    // the name. This is the ordinary case: consumers hold the address they
    // were configured with, and a name that moves must keep working for them.
    const out = await runResolver(["diag", "resolve", moved.handle, "--json"], {
      PAN_REGISTRAR: env.registrarA,
    });
    const r = jsonFrom(out);
    if (!r?.resolved) {
      problems.push(`a resolver pointed at the old registrar could not resolve ${moved.handle} after the move: ${r?.error ?? out.trim().split("\n").pop()}`);
    } else if (r.agentId !== moved.agentId) {
      problems.push(`resolved to the wrong key after following the referral (got ${r.agentId}, expected ${moved.agentId})`);
    }

    // And the key is unchanged across the move, so a consumer that pinned the
    // handle before the move sees no alarm after it — re-homing is a custody
    // change, not an identity event. The pin warning would be printed by the
    // resolver itself, so its absence is the assertion.
    if (/now resolves to a DIFFERENT agent key/i.test(out)) {
      problems.push("the resolver raised a rebound-key alarm for a handle that only changed custodian");
    }
    // The card now comes from B, signed with B's key rather than A's. That is
    // correct and must not read as tampering: a single global signing-key pin
    // would fire here on every correct resolution.
    if (/signing key for .* changed/i.test(out)) {
      problems.push("the resolver treated the new registrar's signing key as a changed pin — signing keys must be pinned per authority, not globally");
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: `a resolver holding only the old registrar's address followed the referral to ${moved.handle}'s new custodian and got the same key, with no false alarms` };
  },
};
