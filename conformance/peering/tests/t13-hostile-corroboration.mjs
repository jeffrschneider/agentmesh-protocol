// SPEC-NAMING §5.6 (check 5), §7.8 — corroboration is worth exactly what the
// party giving it is worth.
//
// Migration IN is the only path in the registrar that CREATES a handle anchored
// to an email the caller never proved control of. What it rests on is a
// statement self-signed by whoever holds a key, naming its own destination,
// presented by an unauthenticated caller. The one thing that turns that into
// custody is the LOSING registrar agreeing it let the name go — §5.6 check 5.
//
// The defect this test exists to catch (security assessment 2026-07-25, finding
// 5.1, CRITICAL): `old_registrar` arrived on that unauthenticated request and
// was simply believed. Stand up a server that answers
// `{"ok":true,"referral":{"registrar":"<them>"}}`, sign
// `pan-rehome-v1:<handle>:<them>:<now>` with your own key, POST
// /api/handles/rehome-in — and the registrar inserted the handle with the
// victim's email as its anchor, `verified_at = now()`, and served a signed card
// for it afterwards. Any name, anchored to anybody, from anyone.
// t11 cannot see this: every case there passes a COOPERATING real registrar as
// `old_registrar`, so corroboration is never exercised against a hostile source.
// Finding 5.2 (HIGH) is the other half — referrals went out unsigned, so even a
// correct allowlist would have had nothing to verify: bare JSON off a socket is
// not a second party to the story, it is whatever answered.
//
// So the fixture below is deliberately NOT a broken server. It is a fully
// cooperative registrar: its own signing key, its own /api/registrar-key, and a
// properly signed referral naming the target as destination and itself as
// issuer. Every check §5.6 asks of a referral passes on its face. The only thing
// it lacks is having been chosen by the target's operator. Case 1 proves the
// fixture really is corroborable by running it against a registrar that DOES
// list it; cases 2 and 3 then mean something, because the difference is not
// competence, it is standing.
import nkeys from "nkeys.js";
import { createServer } from "node:http";
import { runRehome } from "../rig/rehome-flow.mjs";

const jpost = async (url, body) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-delegate-secret": "testsecret" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jget = async (url, headers = {}) => {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const accepted = (r) => r.status === 200 && r.body?.ok === true;
const said = (r) => String(r.body?.error ?? JSON.stringify(r.body ?? null)).slice(0, 300);

/** The exact bytes a registrar signs (naming/src/registrar.rs `canonical_json`):
 *  compact JSON, object keys sorted lexicographically, nulls kept. Every value
 *  in a referral is a string, so there is no number-formatting divergence
 *  between this and serde's. */
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
};

// The fixture's signing key is FIXED, not generated per run. A registrar caches
// the keys a peer publishes at /api/registrar-key for ten minutes per origin
// (PEER_KEY_TTL_SECS), so a fresh key each run would be checked against the
// previous run's cached copy and case 1 would fail for a reason that has nothing
// to do with the property under test. A throwaway account key, used only by a
// loopback fixture in this file.
const FIXTURE_SEED = "SAAJ4CG7I4PNGYI5UX35JJRPCPZIOALHKDKMKSHJ3GSIM2NWDOVUOKKENQ";

/** A registrar that is correct in every respect except whose it is. Serves
 *  §5.3's key endpoint and a §5.6 referral handing any handle asked about to
 *  `destination`. `signed` off reproduces the 5.2 world (referral served with no
 *  signature). `hits` records what the registrar under test actually fetched. */
async function hostileRegistrar({ port, destination }) {
  const kp = nkeys.fromSeed(Buffer.from(FIXTURE_SEED));
  const pub = kp.getPublicKey();
  const state = { signed: true, hits: [], origin: null };
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.hits.push(url.pathname);
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/registrar-key") {
      return json(200, {
        ok: true,
        keys: [pub],
        key_set: [{ kid: "fixture", key: pub, status: "current", use: "pan-card-signing" }],
      });
    }
    if (url.pathname === "/api/resolve") {
      const now = Date.now();
      const referral = {
        handle: url.searchParams.get("handle") ?? "",
        registrar: destination,
        from: state.origin,
        operator: "Hostile Fixture",
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 600_000).toISOString(),
      };
      const body = { ok: true, referral };
      if (state.signed) {
        body.registrar_key = pub;
        body.registrar_kid = "fixture";
        body.registrar_sig = Buffer.from(
          kp.sign(new TextEncoder().encode(canonical(referral))),
        ).toString("base64");
      }
      return json(200, body);
    }
    return json(404, { ok: false, error: "not found" });
  });
  await new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", resolve);
  });
  state.origin = `http://127.0.0.1:${srv.address().port}`;
  return {
    state,
    get origin() {
      return state.origin;
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

/** Sign and submit a re-home statement that is valid in every way t11 already
 *  covers — fresh, addressed to `target`, signed by the key it names — and
 *  differs only in where `target` is told to corroborate it. */
async function attemptTakeover({ target, oldRegistrar, handle }) {
  const kp = nkeys.createUser();
  const timestamp = new Date().toISOString();
  const signature = Buffer.from(
    kp.sign(new TextEncoder().encode(`pan-rehome-v1:${handle}:${target}:${timestamp}`)),
  ).toString("base64");
  return jpost(`${target}/api/handles/rehome-in`, {
    handle,
    agent_id: kp.getPublicKey(),
    timestamp,
    signature,
    new_registrar: target,
    old_registrar: oldRegistrar,
  });
}

/** Is the handle now real at this registrar? Two independent views: public
 *  resolution, and the anchor owner's own roster. This — not the status code —
 *  is the assertion that matters: a mint reported to the caller as an error is
 *  still a stolen name, and §5.1 makes the anchor email the whole basis of the
 *  trust model. Failure to CHECK is reported as a problem too, never as absence. */
async function existsAt(registrar, handle, anchor) {
  const problems = [];
  const resolved = await jget(`${registrar}/api/resolve?handle=${encodeURIComponent(handle)}`);
  if (resolved.status !== 404) {
    problems.push(
      `${handle} resolves at ${registrar} (HTTP ${resolved.status}) — the handle was CREATED: ${said(resolved)}`,
    );
  }
  const sess = await jpost(`${registrar}/api/handles/session-delegated`, { email: anchor });
  const token = sess.body?.token;
  if (!token) {
    problems.push(`could not open a delegated session for ${anchor} at ${registrar}, so the roster could not be checked: ${said(sess)}`);
    return problems;
  }
  const mine = await jget(`${registrar}/api/handles/mine`, { authorization: `Bearer ${token}` });
  if (mine.status !== 200 || !Array.isArray(mine.body?.handles)) {
    problems.push(`could not read ${anchor}'s roster at ${registrar}, so "no handle was created" is unverified: ${said(mine)}`);
    return problems;
  }
  if (mine.body.handles.some((h) => String(h.handle).toLowerCase() === handle.toLowerCase())) {
    problems.push(`${handle} is listed in ${anchor}'s roster at ${registrar} — a name anchored to an email nobody proved control of`);
  }
  return problems;
}

export default {
  id: "t13",
  title: "migration IN believes a configured peer, and only its signed word",
  spec: "SPEC-NAMING §5.6, §7.8",
  async run(env) {
    if (!env.registrarA || !env.registrarB) {
      return { status: "env-skip", detail: "set REGISTRAR_A and REGISTRAR_B (run rig/two-registrars.sh)" };
    }
    // An origin registrar B lists as a peer (PAN_PEERS) and that nothing in the
    // rig serves — this test binds its own fixture there. Cases 1 and 3 need a
    // peer whose behaviour the test controls; there is no other way to reach the
    // checks that sit BEHIND the allowlist.
    const listedOrigin = process.env.REGISTRAR_TEST_PEER ?? null;
    if (!listedOrigin) {
      return {
        status: "env-skip",
        detail: "set REGISTRAR_TEST_PEER to the loopback origin listed in registrar B's PAN_PEERS — rig/two-registrars.sh prints the export line",
      };
    }
    const listedPort = Number(new URL(listedOrigin).port);
    if (!listedPort) {
      return { status: "env-skip", detail: `REGISTRAR_TEST_PEER (${listedOrigin}) has no port, so the fixture cannot bind where B expects its peer` };
    }

    const B = env.registrarB;
    const nonce = (env.rehomeNonce ?? Date.now().toString()).slice(-6);
    const problems = [];
    const notes = [];

    // (0) THE CONTROL THAT COMES FIRST. Re-homing must still work with the
    // allowlist in force. Without this the whole test would pass against a
    // build that closed migration IN by breaking it, which is not the property
    // anyone wants.
    let honest;
    try {
      honest = await runRehome(`h${nonce}`.slice(-6));
    } catch (e) {
      return {
        status: "fail",
        detail: `the honest A→B move could not even be attempted, so nothing below is interpretable: ${String(e?.message ?? e)}`,
      };
    }
    if (honest.inn.status !== 200) {
      return {
        status: "fail",
        detail:
          `the honest A→B re-home was REFUSED with the peer allowlist in force: ${said(honest.inn)}\n` +
          `A must be in B's PAN_PEERS, spelled exactly as REGISTRAR_A is (${env.registrarA}) — the allowlist is an exact normalized match. ` +
          "Refusing every migration is not the property under test; it is re-homing being broken.",
      };
    }
    notes.push("the honest A→B move still completes with the allowlist in force");

    let listed, unlisted;
    try {
      listed = await hostileRegistrar({ port: listedPort, destination: B });
    } catch (e) {
      return {
        status: "env-skip",
        detail: `could not bind the fixture on ${listedOrigin} (${String(e?.code ?? e?.message ?? e)}) — that port must be free for this test and listed in B's PAN_PEERS`,
      };
    }
    try {
      unlisted = await hostileRegistrar({ port: 0, destination: B });

      // (1) THE FIXTURE IS A WORKING REGISTRAR. Same code, same key, same
      // signed referral — presented from the origin B's operator listed. B must
      // take the handle. This is the experiment's control: it is what makes the
      // two refusals below evidence about TRUST rather than evidence that the
      // fixture is malformed. It also states the finding exactly: a signed
      // referral from a listed peer is custody, and the fixture produces one.
      const listedHandle = `peered${nonce}.peered@example.com`;
      const viable = await attemptTakeover({ target: B, oldRegistrar: listed.origin, handle: listedHandle });
      if (!accepted(viable)) {
        if (/configured peer/i.test(said(viable))) {
          return {
            status: "env-skip",
            detail: `registrar B does not list REGISTRAR_TEST_PEER (${listedOrigin}) in its PAN_PEERS, so the checks behind the allowlist cannot be reached — restart rig/two-registrars.sh, which sets it. B said: ${said(viable)}`,
          };
        }
        return {
          status: "fail",
          detail:
            `the fixture registrar is listed as a peer of B and serves a correctly signed §5.6 referral, and B still refused: ${said(viable)}\n` +
            "Decide which this is before touching the test: either the fixture no longer matches what a referral must contain (a signing or canonicalization change), or the registrar now refuses corroboration for a further reason. Until it is decided, the two refusals this test checks are not evidence — a refusal from a broken fixture proves nothing.",
        };
      }
      notes.push("the fixture's signed referral IS corroboration when the fixture is a listed peer (positive control)");

      // (2) FINDING 5.1. The identical fixture, on a port nobody listed. The
      // referral is correctly signed by a key the server publishes, names B as
      // destination and itself as issuer, is fresh, is about this handle — every
      // §5.6 check passes on its own terms. It must still be refused, because
      // being well-formed is not standing: `old_registrar` came from the
      // attacker, so a document from it is the attacker's own word twice.
      const stolen = `stolen${nonce}.victim@example.com`;
      const steal = await attemptTakeover({ target: B, oldRegistrar: unlisted.origin, handle: stolen });
      if (accepted(steal)) {
        problems.push(
          `MINT FROM A STRANGER: ${stolen} was created at ${B} on the word of ${unlisted.origin}, a server the attacker runs. ` +
            "This is the only path that creates a handle anchored to an email the caller never proved control of (assessment 5.1).",
        );
      }
      problems.push(...(await existsAt(B, stolen, "victim@example.com")));
      // Whether B even fetched from the stranger is diagnostic, not a pass
      // condition — refusing before the fetch (as the allowlist does) and
      // refusing after it are both refusals — but it says which check spoke.
      notes.push(
        `an unlisted registrar's correctly signed referral was refused (${steal.status}: ${said(steal)}), and B ` +
          (unlisted.state.hits.length ? `fetched ${unlisted.state.hits.join(", ")} from it` : "never fetched from it"),
      );

      // (3) FINDING 5.2. Now the standing is real — same fixture, listed
      // origin, the exact referral case 1 got accepted — with the signature
      // removed. Unsigned, it is not the peer's word, it is whatever answered
      // that socket: a cache, a hijacked DNS answer, anything on the path. §5.6
      // and §7.8 both call for a SIGNED referral, and 5.1 cannot be closed
      // without it, because the allowlist only tells you who you MEANT to ask.
      listed.state.signed = false;
      const unsignedHandle = `unsigned${nonce}.victim@example.com`;
      const unsignedTry = await attemptTakeover({ target: B, oldRegistrar: listed.origin, handle: unsignedHandle });
      if (accepted(unsignedTry)) {
        problems.push(
          `UNSIGNED REFERRAL ACCEPTED: ${unsignedHandle} was created at ${B} from a referral carrying no signature (assessment 5.2) — corroboration with nothing to verify is not corroboration`,
        );
      }
      problems.push(...(await existsAt(B, unsignedHandle, "victim@example.com")));
      notes.push(`a listed peer's UNSIGNED referral was refused (${unsignedTry.status}: ${said(unsignedTry)})`);
    } finally {
      await listed?.close();
      await unlisted?.close();
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: notes.join("\n") };
  },
};
