// The re-homing flow exercised end to end against the two-registrar rig,
// shared by t07 (re-homing) and t08 (migration-out). Returns a structured
// result the tests assert on. Deterministic handle per run via a passed nonce.
import nkeys from "nkeys.js";

const A = process.env.REGISTRAR_A ?? "http://localhost:18081";
const B = process.env.REGISTRAR_B ?? "http://localhost:18082";

const jpost = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-delegate-secret": "testsecret" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jget = async (url, headers = {}) => {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** Drive the full A→B move. `opts.name` overrides the handle's name part —
 *  t11 passes a DOTTED name, which is where the anchor used to be parsed
 *  wrong (a name may contain dots; the anchor starts after the LAST one). */
export async function runRehome(nonce, opts = {}) {
  const kp = nkeys.createUser();
  const agentId = kp.getPublicKey();
  const name = opts.name ?? `rehome${nonce}`;
  const handle = `${name}.tester@example.com`;

  // 1. claim + bind on A via the delegated flow (partner attests key control)
  const sess = await jpost(`${A}/api/handles/session-delegated`, { email: "tester@example.com" });
  const token = sess.body?.token;
  if (!token) throw new Error(`session-delegated failed: ${JSON.stringify(sess)}`);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const claim = await fetch(`${A}/api/handles/claim`, { method: "POST", headers: auth, body: JSON.stringify({ name, operator_name: "Rehome Tester" }) }).then((r) => r.json());
  if (!claim.ok) throw new Error(`claim failed: ${JSON.stringify(claim)}`);
  const bind = await fetch(`${A}/api/pair/delegated`, { method: "POST", headers: auth, body: JSON.stringify({ handle, agent_id: agentId }) }).then((r) => r.json());
  if (!bind.ok) throw new Error(`pair/delegated failed: ${JSON.stringify(bind)}`);

  // baseline: A resolves to a card with our key
  const beforeA = await jget(`${A}/api/resolve?handle=${encodeURIComponent(handle)}`);
  const cardKeyBefore = (beforeA.body?.card?.endpoints ?? []).find((e) => e.protocol === "agentmesh")?.agent_id;

  // 2. the KEY signs pan-rehome-v1:<handle>:<new-registrar>:<ts>
  // Signed NOW: the statement is a bearer authorization, so registrars accept
  // it only inside a short freshness window and only once. A fixed timestamp
  // (this used to be a hardcoded string) is a statement that would still be
  // good tomorrow, which is exactly what the window exists to prevent.
  const timestamp = new Date().toISOString();
  const msg = `pan-rehome-v1:${handle}:${B}:${timestamp}`;
  const signature = Buffer.from(kp.sign(new TextEncoder().encode(msg))).toString("base64");

  // 3. submit to BOTH: out to A (departure), in to B (arrival)
  const out = await jpost(`${A}/api/handles/rehome-out`, { handle, agent_id: agentId, timestamp, signature, new_registrar: B });
  const inn = await jpost(`${B}/api/handles/rehome-in`, { handle, agent_id: agentId, timestamp, signature, new_registrar: B, old_registrar: A });

  // 4. observe the new world
  const afterA = await jget(`${A}/api/resolve?handle=${encodeURIComponent(handle)}`);       // expect referral
  const afterB = await jget(`${B}/api/resolve?handle=${encodeURIComponent(handle)}`);       // expect card
  const cardKeyAfter = (afterB.body?.card?.endpoints ?? []).find((e) => e.protocol === "agentmesh")?.agent_id;

  // 5. A must refuse to re-issue the departed name
  const sess2 = await jpost(`${A}/api/handles/session-delegated`, { email: "tester@example.com" });
  const reclaim = await fetch(`${A}/api/handles/claim`, { method: "POST", headers: { authorization: `Bearer ${sess2.body?.token}`, "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

  return {
    handle, agentId,
    // The exact statement that was spent, so a caller can try to spend it
    // again (t11) — replaying a used statement must be refused.
    statement: { handle, agent_id: agentId, timestamp, signature, new_registrar: B, old_registrar: A },
    registrars: { A, B },
    out, inn,
    cardKeyBefore, cardKeyAfter,
    referral: afterA.body?.referral ?? null,
    bCardClaimedVia: afterB.body?.card?.claimed_via ?? null,
    reclaimRefused: reclaim.ok === false,
    reclaimError: reclaim.error ?? null,
    keyUnchanged: !!cardKeyBefore && cardKeyBefore === cardKeyAfter,
  };
}
