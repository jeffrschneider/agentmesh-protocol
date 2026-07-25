// c13 — the adapter's INBOX mode, the attended path (mesh-adapter --inbox):
// messages QUEUE locally and a live session drains and answers them. This is
// the mode where mesh traffic reaches a human's working session, which is why
// a caller wants to know about it (the `kind: interactive-session` signal).
//
// Proves the inbox contract against a real adapter daemon and a real broker:
// the sender gets an immediate "queued" acknowledgement rather than an answer,
// the message is retrievable through the session API, a reply sent from the
// session reaches the original sender, and acked messages leave the queue.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADAPTER = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

export default {
  id: "c13",
  title: "adapter inbox mode: messages queue, a session drains and replies",
  spec: "adapter inbox contract, §6.4, §16.4",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    if (!existsSync(ADAPTER)) throw new Error("env-skip: mesh-adapter.mjs not found (set RESOLVER_MJS)");

    const state = mkdtempSync(join(tmpdir(), "c13-inbox-"));
    const credsFile = join(state, "mesh.creds");
    writeFileSync(credsFile,
      `-----BEGIN NATS USER JWT-----\n${env.creds.jwt}\n------END NATS USER JWT------\n\n` +
      `-----BEGIN USER NKEY SEED-----\n${env.creds.seed}\n------END USER NKEY SEED------\n`);
    const childEnv = { ...process.env, MESH_ADAPTER_STATE: state, MESH_CREDS_FILE: credsFile, MESH_URL: env.meshWsUrl, PAN_REGISTRAR: env.registrar };

    const child = spawn(process.execPath, [ADAPTER, "start", "--inbox", "--name", "c13-inbox"], {
      env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });

    /** Run an adapter CLI command against the same state (the live session's side). */
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
      if (!/mode\s+inbox/.test(log)) fails.push("adapter did not report inbox mode");

      nc = await connect({ servers: env.meshWsUrl, authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)), timeout: 15_000, maxReconnectAttempts: 0 });
      const kpS = nkeys.createUser();
      const senderId = kpS.getPublicKey();
      await cli(["contacts", "allow", senderId, "c13 test sender"]);

      // The sender's own inbox, to catch the session's reply.
      const replies = [];
      const subS = nc.subscribe(`mesh.agent.${senderId}.inbox`);
      (async () => { for await (const m of subS) { try { replies.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();

      // 1. A request gets an immediate QUEUED acknowledgement, not an answer.
      const reqEnv = signEnvelope(createEnvelope({
        type: "request", from: senderId, to: agentId,
        payload: { skill: "chat", input: { text: "c13-queued-message" } },
      }), kpS);
      const ack = JSON.parse(td.decode(
        (await nc.request(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(reqEnv)), { timeout: 20_000 })).data));
      const out = ack?.payload?.output ?? {};
      if (ack?.error) fails.push(`inbox-mode ack errored: ${ack.error.message}`);
      if (out.queued !== true) fails.push(`inbox mode did not acknowledge with queued:true (got ${JSON.stringify(out).slice(0, 120)})`);
      const inboxId = out.inbox_id;
      if (!inboxId) fails.push("queued acknowledgement carried no inbox_id");

      // 2. The message is visible to the live session.
      const listed = await cli(["inbox", "--json"]);
      let queued = [];
      try { queued = JSON.parse(listed.slice(listed.indexOf("["), listed.lastIndexOf("]") + 1)); } catch { /* handled below */ }
      const mine = queued.find((e) => /c13-queued-message/.test(String(e.text ?? "")));
      if (!mine) fails.push(`session could not see the queued message (inbox: ${listed.slice(0, 200)})`);

      // 3. A reply from the session reaches the original sender — and a second
      //    turn that lands WHILE that reply is still in flight must survive.
      //    The /reply route holds its inbox snapshot across the delivery await
      //    (up to 30s here, because this sender never acks the reply); a
      //    regression saved that stale snapshot after the await and ERASED any
      //    message filed meanwhile: the sender got "queued" and turn 2 of every
      //    fast-moving conversation silently vanished.
      if (inboxId) {
        const replyStarted = Date.now();
        const replying = cli(["reply", inboxId, "c13-session-answer"]);
        await sleep(2000); // let the route load its snapshot and start delivery
        const req2 = signEnvelope(createEnvelope({
          type: "request", from: senderId, to: agentId,
          payload: { skill: "chat", input: { text: "c13-second-turn" } },
        }), kpS);
        const ack2 = JSON.parse(td.decode(
          (await nc.request(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(req2)), { timeout: 20_000 })).data));
        if ((ack2?.payload?.output ?? {}).queued !== true) {
          fails.push(`second turn was not acknowledged as queued (got ${JSON.stringify(ack2?.payload?.output ?? {}).slice(0, 120)})`);
        }
        let got = null;
        for (let i = 0; i < 20 && !got; i++) {
          await sleep(500);
          got = replies.find((r) => /c13-session-answer/.test(JSON.stringify(r?.payload ?? {}))) ?? null;
        }
        if (!got) fails.push("the session's reply never reached the sender's inbox");
        await replying;
        // The stale save (when the bug is present) fires when the 30s delivery
        // timeout expires; don't declare survival before that moment has passed.
        const remaining = 32_000 - (Date.now() - replyStarted);
        if (remaining > 0) await sleep(remaining);
        const after2 = await cli(["inbox", "--json"]);
        if (!/c13-second-turn/.test(after2)) {
          fails.push("a message that arrived while a reply was in flight vanished from the inbox (lost-update race)");
        }
      }

      // 4. Acking clears it from the queue.
      if (inboxId) {
        await cli(["ack", inboxId]);
        const after = await cli(["inbox", "--json"]);
        if (new RegExp("c13-queued-message").test(after) && !/"status":\s*"acked"/.test(after)) {
          fails.push("acked message still shows as pending in the inbox");
        }
      }

      // 5. Inbox mode must NOT have spawned any command: no pipe involved.
      if (/mode\s+pipe/.test(log)) fails.push("inbox-mode adapter reported pipe mode");
      subS.unsubscribe();
    } finally {
      child.kill();
      await nc?.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "sender got queued ack, session saw the message, its reply reached the sender, a second turn sent mid-reply survived, ack cleared the queue" };
  },
};
