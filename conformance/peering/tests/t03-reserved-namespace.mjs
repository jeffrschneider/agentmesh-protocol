// §14.1: mesh.peer.> is reserved — ordinary node credentials must be denied
// both publish and subscribe under it, today, so that reserving it later
// costs nobody a permission migration.
import { meshConnect } from "../lib/mesh.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "t03",
  title: "reserved namespace: mesh.peer.> denied to ordinary credentials",
  spec: "SPEC.md §14.1",
  async run(env) {
    const nc = await meshConnect(env);
    const violations = [];
    (async () => {
      for await (const s of nc.status()) {
        if (String(s.data ?? "").toLowerCase().includes("permission")) violations.push(String(s.data));
        if (s.type === "error" && String(s.error ?? "").toLowerCase().includes("permission")) violations.push(String(s.error));
      }
    })().catch(() => {});

    try {
      nc.publish("mesh.peer.conformance.probe", new TextEncoder().encode("{}"));
      const sub = nc.subscribe("mesh.peer.conformance.probe2", { max: 1 });
      (async () => { for await (const _ of sub) { /* drain */ } })().catch(() => {});
      await nc.flush().catch(() => {});
      await wait(2_500);

      if (violations.length >= 2) {
        return { status: "pass", detail: "publish and subscribe under mesh.peer.> both denied" };
      }
      if (violations.length === 1) {
        return { status: "fail", detail: `only one of publish/subscribe denied (${violations[0]}); §14.1 requires both` };
      }
      return {
        status: "fail",
        detail: "publish and subscribe under mesh.peer.> were silently accepted — the prefix is not reserved in node permissions yet",
      };
    } finally {
      await nc.close().catch(() => {});
    }
  },
};
