// SPEC-NAMING §5.6 — what a re-home statement is NOT.
//
// t07 and t08 prove the honest move works. This proves the dishonest ones do
// not, because the statement is a bearer authorization with an unusual shape:
// it is self-signed by whoever holds a key, it names its own destination, and
// it is presented by an unauthenticated caller. Take any of the checks away
// and the same bytes become a way to take a name that was never yours.
//
// Each case below was a live defect in the 2026-07-24 implementation.
import nkeys from "nkeys.js";
import { runRehome } from "../rig/rehome-flow.mjs";

const jpost = async (url, body) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-delegate-secret": "testsecret" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const sign = (kp, handle, newRegistrar, timestamp) =>
  Buffer.from(kp.sign(new TextEncoder().encode(`pan-rehome-v1:${handle}:${newRegistrar}:${timestamp}`))).toString("base64");

/** Claim + key-bind a handle at a registrar through the delegated flow. */
async function holdHandleAt(registrar, name, email, kp) {
  const sess = await jpost(`${registrar}/api/handles/session-delegated`, { email });
  const token = sess.body?.token;
  if (!token) throw new Error(`session-delegated failed at ${registrar}: ${JSON.stringify(sess)}`);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const claim = await fetch(`${registrar}/api/handles/claim`, {
    method: "POST", headers: auth, body: JSON.stringify({ name, operator_name: "Rehome Tester" }),
  }).then((r) => r.json());
  if (!claim.ok) throw new Error(`claim failed at ${registrar}: ${JSON.stringify(claim)}`);
  const handle = `${name}.${email}`;
  const bind = await fetch(`${registrar}/api/pair/delegated`, {
    method: "POST", headers: auth, body: JSON.stringify({ handle, agent_id: kp.getPublicKey() }),
  }).then((r) => r.json());
  if (!bind.ok) throw new Error(`pair/delegated failed at ${registrar}: ${JSON.stringify(bind)}`);
  return handle;
}

export default {
  id: "t11",
  title: "re-home statements are not custody: hijack, forgery, replay and staleness refused",
  spec: "SPEC-NAMING §5.6, §7.8",
  async run(env) {
    if (!env.registrarA || !env.registrarB) {
      return { status: "env-skip", detail: "set REGISTRAR_A and REGISTRAR_B (run rig/two-registrars.sh)" };
    }
    const A = env.registrarA, B = env.registrarB;
    const nonce = (env.rehomeNonce ?? Date.now().toString()).slice(-6);
    const problems = [];
    const accepted = (r) => r.status === 200 && r.body?.ok === true;

    // (1) HIJACK. A handle already held at B by one key. An attacker signs a
    // perfectly valid statement for that handle with their OWN key: the
    // signature proves they control THEIR key, and nothing more. B must not
    // rebind somebody else's name to it.
    const victimKp = nkeys.createUser();
    const victimHandle = await holdHandleAt(B, `victim${nonce}`, "victim@example.com", victimKp);
    const attackerKp = nkeys.createUser();
    const ts = new Date().toISOString();
    const hijack = await jpost(`${B}/api/handles/rehome-in`, {
      handle: victimHandle,
      agent_id: attackerKp.getPublicKey(),
      timestamp: ts,
      signature: sign(attackerKp, victimHandle, B, ts),
      new_registrar: B,
      old_registrar: A,
    });
    if (accepted(hijack)) {
      problems.push("HIJACK: a stranger's key rebound a handle already held here — a re-home signature proves key control, never ownership of an existing name");
    }

    // (2) UNCORROBORATED MINT. A statement for a name no registrar ever
    // issued, claiming to come from A. A never held it and says so; without
    // asking A, B would create the handle — squatting any name, at any
    // registrar, including names anchored to other people's email.
    const squatKp = nkeys.createUser();
    const squatHandle = `squat${nonce}.stranger@example.com`;
    const mint = await jpost(`${B}/api/handles/rehome-in`, {
      handle: squatHandle,
      agent_id: squatKp.getPublicKey(),
      timestamp: ts,
      signature: sign(squatKp, squatHandle, B, ts),
      new_registrar: B,
      old_registrar: A,
    });
    if (accepted(mint)) {
      problems.push("MINT: a self-signed statement created a handle the old registrar never held — custody needs the losing registrar to agree it let go");
    }

    // (3) WRONG DESTINATION. A statement that names A submitted to B. It
    // verifies against the key and it is fresh; it simply is not addressed to
    // B. Accepting it lets any statement be replayed at every registrar.
    const elsewhereKp = nkeys.createUser();
    const elsewhereHandle = `elsewhere${nonce}.stranger@example.com`;
    const misdirected = await jpost(`${B}/api/handles/rehome-in`, {
      handle: elsewhereHandle,
      agent_id: elsewhereKp.getPublicKey(),
      timestamp: ts,
      signature: sign(elsewhereKp, elsewhereHandle, A, ts),
      new_registrar: A,
      old_registrar: A,
    });
    if (accepted(misdirected)) {
      problems.push("MISDIRECTED: a statement naming another registrar as its destination was accepted here");
    }

    // (4) STALE. Signed two hours ago. A captured statement must not stay
    // spendable indefinitely.
    const staleKp = nkeys.createUser();
    const staleHandle = `stale${nonce}.stranger@example.com`;
    const staleTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stale = await jpost(`${B}/api/handles/rehome-in`, {
      handle: staleHandle,
      agent_id: staleKp.getPublicKey(),
      timestamp: staleTs,
      signature: sign(staleKp, staleHandle, B, staleTs),
      new_registrar: B,
      old_registrar: A,
    });
    if (accepted(stale)) {
      problems.push("STALE: a two-hour-old statement was accepted — a captured statement would be good forever");
    }

    // (5) REPLAY. Run the honest move, then present the very same statement
    // again. The first spend is legitimate; the second is a recording.
    const legit = await runRehome(`r${nonce}`.slice(-6));
    if (legit.inn.status !== 200) {
      problems.push(`the honest re-home stopped working, so replay could not be tested: ${JSON.stringify(legit.inn.body)}`);
    } else {
      const replay = await jpost(`${B}/api/handles/rehome-in`, legit.statement);
      if (accepted(replay)) {
        problems.push("REPLAY: a statement that had already been spent was accepted a second time");
      }
      const replayOut = await jpost(`${A}/api/handles/rehome-out`, legit.statement);
      if (accepted(replayOut)) {
        problems.push("REPLAY: a spent statement was accepted again by the OLD registrar");
      }
    }

    // (6) DOTTED NAMES keep their anchor. `My.Agent.ann@gmail.com` is the name
    // `My.Agent` anchored to `ann@gmail.com` — the anchor begins after the
    // LAST dot, not the first. Splitting on the first dot files the handle
    // under an email address that does not exist, and the anchor is what the
    // whole trust model hangs on. Observable from the owner's side: after the
    // move, the handle must appear in the real anchor's roster at B.
    const dotted = await runRehome(`d${nonce}`.slice(-6), { name: `My.Dotted${nonce}` });
    if (dotted.inn.status !== 200) {
      problems.push(`a dotted-name handle could not re-home at all: ${JSON.stringify(dotted.inn.body)}`);
    } else {
      const sess = await jpost(`${B}/api/handles/session-delegated`, { email: "tester@example.com" });
      const mine = await fetch(`${B}/api/handles/mine`, {
        headers: { authorization: `Bearer ${sess.body?.token}` },
      }).then((r) => r.json()).catch(() => null);
      const listed = (mine?.handles ?? []).some((h) => h.handle === dotted.handle);
      if (!listed) {
        problems.push(`ANCHOR: ${dotted.handle} did not land in tester@example.com's roster — the anchor was parsed from the first dot, so the handle is filed under an email nobody owns`);
      }
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "hijack, uncorroborated mint, misdirection, staleness and replay all refused; dotted names keep their anchor; the honest move still completes" };
  },
};
