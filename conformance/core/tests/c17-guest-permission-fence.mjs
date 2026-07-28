// c17 — the guest permission template is in FORCE, not merely intended
// (§14.3, §16.4): a sandbox credential must be denied publish AND subscribe
// under $KV.mesh_sessions.> (the session KV bucket, §18.4) and mesh.peer.>
// (the reserved peering namespace, §14.1). c08 proves what the sandbox
// contract advertises; this proves the broker enforces it — and since a
// permission denial arrives as an async status event (t03's technique), the
// probes require a POSITIVE denial per operation. Absence of an error is not
// evidence of permission.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";

const te = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c17",
  title: "guest fence: $KV.mesh_sessions.> and mesh.peer.> denied to sandbox credentials",
  spec: "§14.3, §16.4, §18.4",
  async run(env) {
    // Provision from the real API, exactly as a no-signup user would (c08).
    const res = await fetch(`${env.storefrontBase}/v1/guest`, { method: "POST" }).catch(() => null);
    if (!res) throw new Error("env-skip: guest API unreachable");
    if (res.status === 429 || res.status === 503) throw new Error("env-skip: sandbox pool busy");
    const g = await res.json();

    const nc = await connect({ servers: env.meshWsUrl, authenticator: jwtAuthenticator(g.jwt, te.encode(g.seed)), timeout: 15_000, maxReconnectAttempts: 0 });
    // The status event for a violation carries only the constant
    // "PERMISSIONS_VIOLATION" — no subject — so publish denials are
    // attributed by phase: one probe at a time, each watching the count for
    // its own window. Subscription denials are cleaner: the subscription's
    // iterator rejects with the op and subject named, so those are awaited
    // directly.
    const violations = [];
    (async () => {
      for await (const s of nc.status()) {
        if (String(s.data ?? "").toLowerCase().includes("permission")) violations.push(String(s.data));
        if (s.type === "error" && String(s.error ?? "").toLowerCase().includes("permission")) violations.push(String(s.error));
      }
    })().catch(() => {});

    const pubDenied = async (subject) => {
      const before = violations.length;
      nc.publish(subject, te.encode("{}"));
      await nc.flush().catch(() => {});
      await sleep(2_000);
      return violations.length > before;
    };
    const subDenied = async (subject) => {
      const sub = nc.subscribe(subject, { max: 1 });
      const err = await Promise.race([
        (async () => { try { for await (const _ of sub) { /* drain */ } return null; } catch (e) { return String(e?.message ?? e); } })(),
        sleep(2_000).then(() => null), // an ACCEPTED sub just sits open — that is the failure case
      ]);
      sub.unsubscribe?.();
      return err !== null && /permission/i.test(err);
    };

    try {
      const accepted = [];
      if (!(await pubDenied("$KV.mesh_sessions.conformance-c17"))) accepted.push("publish $KV.mesh_sessions.>");
      if (!(await subDenied("$KV.mesh_sessions.>"))) accepted.push("subscribe $KV.mesh_sessions.>");
      if (!(await pubDenied("mesh.peer.conformance.c17"))) accepted.push("publish mesh.peer.>");
      if (!(await subDenied("mesh.peer.conformance.c17.sub"))) accepted.push("subscribe mesh.peer.>");

      if (accepted.length === 0) {
        return { status: "pass", detail: "all four probes positively denied (async permission violations observed)" };
      }
      return {
        status: "fail",
        detail: `guest credential was NOT denied: ${accepted.join(", ")}` +
          " — no violation arrived for these, so the permission template is not in force where it must be",
      };
    } finally {
      await nc.close().catch(() => {});
      // Hand the lease back. Best-effort here: the release contract itself
      // (signed accepted, unsigned refused) is c08's assertion, not ours.
      const ts = new Date().toISOString();
      const sig = Buffer.from(
        nkeys.fromSeed(te.encode(g.seed)).sign(te.encode(`guest-release-v1:${g.publicKey}:${ts}`)),
      ).toString("base64");
      await fetch(`${env.storefrontBase}/v1/guest/release`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: g.publicKey, ts, sig }),
      }).catch(() => {});
    }
  },
};
