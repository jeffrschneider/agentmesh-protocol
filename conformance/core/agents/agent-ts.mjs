// The TypeScript conformance agent: the SDK under test, driven over the line
// protocol in ../lib/agent-under-test.mjs.
//
// Its only reason to exist is that the protocol must be proven against an SDK
// known to pass. When a Rust run goes red, this file is the control that says
// the plumbing was not the problem. Nothing test-specific belongs here: one
// fixed skill behaviour (answer `{ok: <input>}`, report a `handled` event), and
// commands are added only in lockstep with every other conformance agent.
//
// Environment (set by the harness): MESH_URL, MESH_CREDS_JWT, MESH_CREDS_SEED,
// MESH_AGENT_SEED.
import { createInterface } from "node:readline";
import { jwtAuthenticator } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const need = (v) => {
  const x = process.env[v];
  if (!x) { process.stderr.write(`${v} is not set\n`); process.exit(2); }
  return x;
};

const { AgentMesh } = sdk;
const agent = await AgentMesh.connect(need("MESH_URL"), {
  authenticator: jwtAuthenticator(need("MESH_CREDS_JWT"), te.encode(need("MESH_CREDS_SEED"))),
  nkeySeed: need("MESH_AGENT_SEED"),
});

let version = "unknown";
try { version = (await import("agentmesh/package.json", { with: { type: "json" } })).default.version; } catch { /* label only */ }
say({ ev: "ready", agent_id: agent.agentId, sdk: `agentmesh-typescript ${version}` });

const commands = {
  // Every field the harness sends reaches the SDK — `guarded` (EXT-6 §7.1) and
  // `interaction` (§8.2) included. Naming three and dropping the rest is how a
  // test comes to ask for a guarded registration, get an unguarded one, and be
  // told nothing about the difference.
  async register({ visibility = "unlisted", skills = [], ...rest }) {
    for (const s of skills) {
      agent.onRequest(s.id, async (input, ctx) => {
        say({
          ev: "handled",
          skill: s.id,
          envelope_id: ctx?.envelope?.id ?? null,
          from: ctx?.envelope?.from ?? null,
          input: input ?? null,
        });
        return { ok: input };
      });
    }
    await agent.register({ visibility, skills, ...rest });
    // What the SDK CONCLUDED, from the live SUBSCRIPTION rather than from the
    // service's answer: a second register() does not re-point an agent that is
    // already listening, so the two can legitimately disagree and only the
    // subscription decides whether mail still reaches the public inbox. Both
    // fields are `private` in the TypeScript types and plain properties at
    // runtime; the SDK publishes no accessor for either, which is a gap in the
    // SDK and not a liberty taken here (see readGuarded in ../lib).
    return { guarded: (agent.listeningOnGuarded ?? agent.guarded) === true };
  },
  async deregister() {
    await agent.deregister();
    return {};
  },
};

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  let msg;
  try { msg = JSON.parse(text); } catch (e) { process.stderr.write(`unparsable command: ${text}\n`); continue; }
  if (msg.cmd === "close") {
    say({ ev: "reply", id: msg.id, ok: true });
    break;
  }
  const fn = commands[msg.cmd];
  if (!fn) {
    // `unsupported` is the signal the harness turns into not-validated: this
    // implementation cannot exercise the behaviour, which is neither a pass
    // nor evidence that the SDK is wrong.
    say({ ev: "reply", id: msg.id, ok: false, unsupported: true, error: `unsupported command: ${msg.cmd}` });
    continue;
  }
  try {
    say({ ev: "reply", id: msg.id, ok: true, ...(await fn(msg)) });
  } catch (e) {
    say({ ev: "reply", id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
}

await agent.close().catch(() => {});
process.exit(0);
