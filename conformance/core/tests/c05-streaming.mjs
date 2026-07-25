// c05 — streaming end to end (§10.5, §11): a streamed request delivers its
// chunks in order over the task stream subject and terminates cleanly. With
// sign_chunks enabled (§11.6), a forged chunk injected onto the stream
// subject by a third connection must NOT surface in the requester's output.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();

export default {
  id: "c05",
  title: "streaming: ordered chunks, clean end, forged chunks don't surface",
  spec: "§10.5, §11.2, §11.6",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const seed = () => td.decode(nkeys.createUser().getSeed());

    const responder = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: seed() });
    responder.onStreamRequest("count", async (input, _ctx, writer) => {
      for (const w of ["one", "two", "three"]) {
        writer.write(w);
        await new Promise((r) => setTimeout(r, 60));
      }
      writer.end();
    });
    await responder.register({ name: "c05-streamer", visibility: "unlisted", skills: [{ id: "count", name: "count", description: "c05" }] });

    const requester = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: seed() });
    const intruder = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    try {
      const { chunks, task_id } = await requester.requestStream(responder.agentId, "count", { go: 1 }, { sign_chunks: true, timeout_ms: 20_000 });
      // Inject a forged chunk mid-stream from a third connection: unsigned,
      // wrong identity, claiming to be part of this task's stream.
      if (task_id) {
        intruder.publish(`mesh.task.${task_id}.stream`, te.encode(JSON.stringify({
          id: "forged", v: "0.1.0", type: "respond", from: nkeys.createUser().getPublicKey(),
          task_id, ts: new Date().toISOString(),
          payload: { chunk: "FORGED", chunk_index: 1 },
        })));
      }
      const received = [];
      for await (const c of chunks) {
        const text = typeof c === "string" ? c : (c?.data ?? c?.chunk ?? "");
        if (text) received.push(String(text));
      }
      const joined = received.join("");
      if (!joined.includes("one") || !joined.includes("three")) fails.push(`stream incomplete: [${received.join("|")}]`);
      if (joined.indexOf("one") > joined.indexOf("three")) fails.push("chunks out of order");
      if (joined.includes("FORGED")) fails.push("a forged, unsigned chunk surfaced in the requester's stream");
    } finally {
      await responder.deregister().catch(() => {});
      await responder.close().catch(() => {});
      await requester.close().catch(() => {});
      await intruder.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "three chunks in order, clean termination, forged chunk rejected" };
  },
};
