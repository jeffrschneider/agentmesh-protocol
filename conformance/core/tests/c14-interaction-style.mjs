// c14 — interaction style (§8.2, §8.3a): an agent declares how inbound requests
// are handled, so a caller can tell whether reaching it interrupts a person
// WITHOUT parsing English out of a description.
//
// The motivating failure, from a real tester: their agent wanted to contact one
// of our fleet agents named "Codex" and had no machine-readable way to know
// whether a message would land in somebody's live coding session. It resorted to
// string-matching the description prose, which is brittle by construction.
//
// Proves: the field survives register -> registry -> discover for both values;
// callers can filter on it; and it is absent (not invented) when undeclared.
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c14",
  title: "interaction style: declared, stored, and discoverable",
  spec: "§8.2, §8.3a, §9.3",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const fresh = () => td.decode(nkeys.createUser().getSeed());

    const agents = [];
    const mk = async (interaction) => {
      const a = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      a.onRequest("echo", async (i) => ({ ok: i }));
      const opts = {
        name: `c14-${interaction ?? "undeclared"}`,
        visibility: "public",
        skills: [{ id: "echo", name: "echo", description: "c14" }],
      };
      if (interaction) opts.interaction = interaction;
      await a.register(opts);
      agents.push(a);
      return a;
    };

    const fails = [];
    try {
      const svc = await mk("service");
      const live = await mk("interactive");
      const undeclared = await mk(undefined);
      await sleep(2000);

      const observer = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
      agents.push(observer);
      const found = await observer.discover({});
      const list = found?.agents ?? found ?? [];
      const byId = new Map(list.map((m) => [m.id, m]));

      // 1. Both declared values survive the round trip.
      const s = byId.get(svc.agentId);
      const l = byId.get(live.agentId);
      if (!s) fails.push("service agent not discoverable");
      else if (s.interaction !== "service") fails.push(`service agent reads interaction=${JSON.stringify(s.interaction)}`);
      if (!l) fails.push("interactive agent not discoverable");
      else if (l.interaction !== "interactive") fails.push(`interactive agent reads interaction=${JSON.stringify(l.interaction)}`);

      // 2. Undeclared stays ABSENT — the registry must not invent a value,
      //    because "unknown" and "service" mean very different things to a caller.
      const u = byId.get(undeclared.agentId);
      if (!u) fails.push("undeclared agent not discoverable");
      else if (u.interaction !== undefined) fails.push(`undeclared agent got invented interaction=${JSON.stringify(u.interaction)}`);

      // 3. A caller can act on it: pick only agents that disturb nobody.
      const safeToCall = list.filter((m) => m.interaction === "service").map((m) => m.id);
      if (!safeToCall.includes(svc.agentId)) fails.push("filtering for service agents missed the service agent");
      if (safeToCall.includes(live.agentId)) fails.push("filtering for service agents wrongly included the interactive agent");
    } finally {
      for (const a of agents) {
        await a.deregister().catch(() => {});
        await a.close().catch(() => {});
      }
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "service and interactive both survive register->discover; undeclared stays absent; callers can filter" };
  },
};
