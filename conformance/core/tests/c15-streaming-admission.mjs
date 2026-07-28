// c15 — the streaming request path must be gated by admission, exactly like
// the non-streaming one (EXT-6, §11).
//
// The motivating defect (assessment 7.1, 2026-07-25): the adapter registered a
// streaming `chat` handler unconditionally, and the SDK routes to it whenever
// the SENDER sets `payload.config.stream: true`. Every protection in the
// adapter — the admission roster, the per-sender rate limit, the daily model
// budget, unsealing, and the provenance frame — lived on the non-streaming
// handler only. So a sender the operator had explicitly BLOCKED reached the
// agent's real command by setting one flag, unmetered and unlogged. On the
// reference fleet that meant remote prompt control of a tool-enabled agent on a
// host holding credentials.
//
// This test exists because no unit test can see it: the bug is not in either
// handler, it is in the fact that there were two of them and only one was
// guarded. It asserts the property that matters — a blocked sender's text never
// reaches the command — rather than the shape of any particular fix.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADAPTER = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

export default {
  id: "c15",
  title: "streaming requests obey admission: a blocked sender never reaches the command",
  spec: "EXT-6, §11, adapter gate",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    if (!existsSync(ADAPTER)) throw new Error("env-skip: mesh-adapter.mjs not found (set RESOLVER_MJS)");

    const state = mkdtempSync(join(tmpdir(), "c15-stream-"));
    // NO streaming brain is configured, deliberately. Without STREAM_BRAIN the
    // adapter answers a streamed turn with its built-in word-by-word echo of
    // the sender's own prompt — which is a better probe than a scripted brain:
    // seeing your own text come back proves the adapter processed your message,
    // and it depends on nothing but the adapter itself. (A scripted brain would
    // add a bash-spawn dependency and make this test's result a statement about
    // the host's PATH rather than about admission.)
    const credsFile = join(state, "mesh.creds");
    writeFileSync(credsFile,
      `-----BEGIN NATS USER JWT-----\n${env.creds.jwt}\n------END NATS USER JWT------\n\n` +
      `-----BEGIN USER NKEY SEED-----\n${env.creds.seed}\n------END USER NKEY SEED------\n`);
    const childEnv = {
      ...process.env,
      MESH_ADAPTER_STATE: state,
      MESH_CREDS_FILE: credsFile,
      MESH_URL: env.meshWsUrl,
      PAN_REGISTRAR: env.registrar,
    };

    const child = spawn(process.execPath, [ADAPTER, "start", "--inbox", "--name", "c15-stream"], {
      env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });

    const cli = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [ADAPTER, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("close", () => resolve(out.trim()));
    });

    const fails = [];
    let nc = null;
    try {
      let agentId = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (child.exitCode !== null) break;
        if (/^listening/m.test(log)) { agentId = log.match(/\b(U[A-Z2-7]{55})\b/)?.[1] ?? null; break; }
      }
      if (!agentId) return { status: "fail", detail: `adapter never came up listening in 30s. output: ${log.slice(-400)}` };

      nc = await connect({
        servers: env.meshWsUrl,
        authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
        timeout: 15_000, maxReconnectAttempts: 0,
      });

      // Two senders: one the operator has BLOCKED, one allowed. The allowed one
      // is the control — without it, a fix that simply broke streaming for
      // everybody would pass.
      const kpBlocked = nkeys.createUser();
      const kpAllowed = nkeys.createUser();
      await cli(["contacts", "block", kpBlocked.getPublicKey(), "c15 blocked sender"]);
      await cli(["contacts", "allow", kpAllowed.getPublicKey(), "c15 allowed sender"]);

      /** Send a STREAMING request (the sender sets config.stream) and collect
       *  whatever comes back on the task stream. */
      const streamTurn = async (kp, text) => {
        const from = kp.getPublicKey();
        const taskId = `c15-${Math.random().toString(36).slice(2, 10)}`;
        const chunks = [];
        const sub = nc.subscribe(`mesh.task.${taskId}.stream`);
        (async () => {
          for await (const m of sub) {
            try { chunks.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ }
          }
        })();
        // `prompt`, not `text`: the streaming handler reads input.prompt, and
        // sending the wrong field would make an empty prompt look like a
        // successful block. (It did, the first time this test was written.)
        const envl = signEnvelope(createEnvelope({
          type: "request", from, to: agentId, task_id: taskId,
          payload: { skill: "chat", input: { prompt: text }, config: { stream: true } },
        }), kp);
        let ack = null;
        try {
          ack = JSON.parse(td.decode(
            (await nc.request(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(envl)), { timeout: 20_000 })).data));
        } catch { /* an empty stream may mean no reply at all; that is fine */ }
        await sleep(4000); // let any chunks land
        sub.unsubscribe();
        // The whole frame is searched, not just payload.data: the point is
        // whether the sender's text came back at all, however it is shaped.
        const body = chunks.map((c) => JSON.stringify(c)).join("");
        return { ack, chunks, body };
      };

      // 1. THE FINDING: a blocked sender's streamed request must not reach the
      //    command. The command leaves evidence on disk if it ran.
      const blocked = await streamTurn(kpBlocked, "c15-BLOCKED-PROMPT");
      if (/c15-BLOCKED-PROMPT/.test(blocked.body)) {
        fails.push("a roster-BLOCKED sender's streamed prompt was processed and echoed back (admission bypassed on the streaming path)");
      }

      // 2. Control: the fix must gate, not break. An allowed sender still gets
      //    a working stream, and the command does run for it.
      const allowed = await streamTurn(kpAllowed, "c15-ALLOWED-PROMPT");
      if (!/c15-ALLOWED-PROMPT/.test(allowed.body)) {
        fails.push(`an ALLOWED sender got no streamed answer (streaming is broken, not gated) — ${allowed.chunks.length} chunk(s)`);
      }

      // 3. The blocked sender must not be able to TELL it was blocked: the
      //    refusal has to look like an agent with nothing to say (c07's rule,
      //    applied to the streaming path).
      if (blocked.ack?.error && !allowed.ack?.error) {
        fails.push("the streaming refusal is distinguishable from a normal answer (block oracle)");
      }
    } finally {
      child.kill();
      await nc?.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "blocked sender's streamed turn was refused, allowed sender's was answered, and the refusal is not distinguishable from silence" };
  },
};
