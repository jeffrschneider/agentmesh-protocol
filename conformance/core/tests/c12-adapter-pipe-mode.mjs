// c12 — the adapter's PIPE mode, the unattended path (mesh-adapter
// --cmd "<command>"). Nothing tested this before: the adapter is the
// reference node most consumers actually run, and pipe mode is how a
// headless agent answers the mesh.
//
// Proves the pipe contract end to end against a real adapter daemon and a
// real broker: an inbound mesh request spawns the command, the message
// reaches it on stdin, the command's stdout becomes the reply, and each
// message gets its OWN process (fresh per message = isolated handling,
// the property the `kind: service` claim would rest on).
//
// The command under test is a trivial script, not a coding agent, so this
// stays fast and deterministic. Latency of real agents is measured
// separately (tools/measure-agent-latency.mjs).
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADAPTER = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

export default {
  id: "c12",
  title: "adapter pipe mode: message to stdin, stdout to reply, fresh process each time",
  spec: "adapter pipe contract, §6.4",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    if (!existsSync(ADAPTER)) throw new Error("env-skip: mesh-adapter.mjs not found (set RESOLVER_MJS)");

    const state = mkdtempSync(join(tmpdir(), "c12-pipe-"));
    // The piped "agent": echoes what it read, and appends its own PID so the
    // test can prove a distinct process handled each message.
    // Reads ALL of stdin (pipe mode frames the message with a provenance
    // header, so the sender's text is inside the framed body) and reports its
    // own PID so the test can prove a distinct process per message.
    const script = join(state, "brain.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nmsg=$(cat)\nprintf 'handled by %s :: %s' \"$$\" \"$(printf '%s' \"$msg\" | tr '\\n' ' ')\"\n");
    chmodSync(script, 0o755);
    // The adapter authenticates with the same durable creds the suite uses.
    const credsFile = join(state, "mesh.creds");
    writeFileSync(credsFile,
      `-----BEGIN NATS USER JWT-----\n${env.creds.jwt}\n------END NATS USER JWT------\n\n` +
      `-----BEGIN USER NKEY SEED-----\n${env.creds.seed}\n------END USER NKEY SEED------\n`);

    const child = spawn(process.execPath, [ADAPTER, "start", "--cmd", `bash ${script}`, "--name", "c12-pipe"], {
      env: { ...process.env, MESH_ADAPTER_STATE: state, MESH_CREDS_FILE: credsFile, MESH_URL: env.meshWsUrl, PAN_REGISTRAR: env.registrar },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });

    const fails = [];
    let nc = null;
    try {
      // Wait until the daemon says it is listening — the identity line prints
      // well before the connection is up, so keying off the agent id alone
      // races the boxes that follow it.
      let agentId = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (child.exitCode !== null) break;
        if (/^listening/m.test(log)) { agentId = log.match(/\b(U[A-Z2-7]{55})\b/)?.[1] ?? null; break; }
      }
      if (!agentId) {
        return { status: "fail", detail: `adapter never came up listening in 30s. output: ${log.slice(-400)}` };
      }
      if (!/mode\s+pipe/.test(log)) fails.push(`adapter did not report pipe mode. output: ${log.slice(-200)}`);

      nc = await connect({ servers: env.meshWsUrl, authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)), timeout: 15_000, maxReconnectAttempts: 0 });
      const kpS = nkeys.createUser();

      // Admission (EXT-6) fronts pipe mode: an unknown sender defaults to
      // block/hold, so the command would never run. Allow this test's sender
      // through the adapter's own signed-roster CLI (the roster is signature
      // verified, so it cannot be hand-written).
      await new Promise((resolve) => {
        const cli = spawn(process.execPath, [ADAPTER, "contacts", "allow", kpS.getPublicKey(), "c12 test sender"], {
          env: { ...process.env, MESH_ADAPTER_STATE: state, MESH_CREDS_FILE: credsFile, MESH_URL: env.meshWsUrl, PAN_REGISTRAR: env.registrar },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        cli.stdout.on("data", (d) => { out += d; });
        cli.stderr.on("data", (d) => { out += d; });
        cli.on("close", () => { log += `\n[contacts allow] ${out.trim()}`; resolve(); });
      });
      const ask = async (text) => {
        const e = signEnvelope(createEnvelope({
          type: "request", from: kpS.getPublicKey(), to: agentId,
          payload: { skill: "chat", input: { text } },
        }), kpS);
        const m = await nc.request(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(e)), { timeout: 30_000 });
        return JSON.parse(td.decode(m.data));
      };

      // 1. The message reaches the command's stdin and its stdout is the reply.
      const r1 = await ask("c12-first-message");
      const out1 = r1?.payload?.output?.text ?? "";
      if (r1?.error) fails.push(`pipe reply errored: ${r1.error.message}`);
      if (!/c12-first-message/.test(out1)) fails.push(`command never saw the message on stdin (reply: ${JSON.stringify(out1).slice(0, 120)})`);
      if (!/handled by \d+/.test(out1)) fails.push("reply did not come from the piped command's stdout");

      // 2. A second message gets a DIFFERENT process: fresh per message.
      const r2 = await ask("c12-second-message");
      const out2 = r2?.payload?.output?.text ?? "";
      const pid1 = out1.match(/handled by (\d+)/)?.[1];
      const pid2 = out2.match(/handled by (\d+)/)?.[1];
      if (!/c12-second-message/.test(out2)) fails.push("second message did not reach the command");
      if (pid1 && pid2 && pid1 === pid2) fails.push(`both messages handled by the same process (${pid1}) — pipe mode is not spawning per message`);

      // 3. Pipe mode keeps no local inbox: the message went to the command,
      //    not to a queue waiting for a human.
      const inboxFile = join(state, "inbox.json");
      if (existsSync(inboxFile)) {
        const queued = JSON.parse(readFileSync(inboxFile, "utf8"));
        const stuck = queued.filter((e) => /c12-(first|second)-message/.test(String(e.text ?? "")) && e.status !== "held");
        if (stuck.length) fails.push(`pipe mode queued ${stuck.length} message(s) locally instead of piping them`);
      }
    } finally {
      child.kill();
      await nc?.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "message reached the command on stdin, stdout became the reply, and each message ran in its own process" };
  },
};
