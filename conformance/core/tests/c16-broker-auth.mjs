// c16 — the broker's front door (§4.6, §18.2): a connection presenting NO
// credential must be refused with an authorization violation. This is the
// exact fault that ran undetected for three days in July 2026 — enforcement
// was off and the broker accepted anonymous connections — and nothing on the
// board would have gone red. Now something does.
//
// The trap this test exists to avoid: a NATS denial can arrive as an ASYNC
// STATUS EVENT rather than a thrown error or a closed connection (see t03),
// so a probe that only checks isClosed() reads every denial as "allowed".
// Refusal here is evidenced either by connect() rejecting with an
// authorization violation, or by a violation arriving on the status stream —
// and the absence of both, on a live connection that flushes traffic, is a
// loud FAIL, not a shrug.
import { connect } from "../../peering/lib/mesh.mjs";

const te = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAuthViolation = (s) => /authorization|authentication/i.test(s);

export default {
  id: "c16",
  title: "broker auth: an unauthenticated connection is refused",
  spec: "§4.6, §18.2",
  async run(env) {
    // No env.creds gate, deliberately: this test's whole point is connecting
    // WITHOUT any credential, so it runs even on an uncredentialed machine.
    let nc;
    try {
      nc = await connect({ servers: env.meshWsUrl, timeout: 15_000, maxReconnectAttempts: 0 });
    } catch (e) {
      const msg = String(e?.code ?? "") + " " + String(e?.message ?? e);
      if (isAuthViolation(msg)) {
        return { status: "pass", detail: "anonymous connect refused at the handshake (authorization violation)" };
      }
      // Not an auth refusal — the broker was unreachable, which is a broken
      // environment, not evidence about enforcement either way.
      throw new Error(`could not probe the broker: ${msg.trim()}`);
    }

    // The dangerous branch: connect() resolved. Either enforcement is off, or
    // the server accepted the socket and is delivering its refusal
    // asynchronously. Watch the status stream and push traffic to find out.
    const violations = [];
    (async () => {
      for await (const s of nc.status()) {
        if (isAuthViolation(String(s.data ?? ""))) violations.push(String(s.data));
        if (s.type === "error" && isAuthViolation(String(s.error ?? ""))) violations.push(String(s.error));
      }
    })().catch(() => {});

    let flushed = false;
    try {
      nc.publish("mesh.event.conformance.c16", te.encode("{}"));
      await nc.flush().then(() => { flushed = true; }).catch(() => {});
      await sleep(2_500);

      if (violations.length && nc.isClosed()) {
        return { status: "pass", detail: `anonymous connect refused post-accept (async): ${violations[0]}` };
      }
      // Anything else — a live anonymous connection, with or without
      // per-subject grumbling — is the July 2026 fault, present tense.
      return {
        status: "fail",
        detail: `broker ACCEPTED an unauthenticated connection${flushed ? " and flushed traffic on it" : ""}` +
          `${violations.length ? ` (only per-operation denials arrived: ${violations[0]})` : " with no violation at all"}` +
          " — auth enforcement is OFF, the exact fault of July 2026",
      };
    } finally {
      await nc.close().catch(() => {});
    }
  },
};
