// The AGENT under test, as opposed to the SDK module under test.
//
// The problem this solves: `../../peering/lib/sdk.mjs` imports a TypeScript
// module, so every core test that needs a live agent has been an assertion
// about the TypeScript SDK and nothing else. The Rust crate has never been run
// against a real mesh by any test, and more SDKs are intended — each written
// natively from the spec, each with its own chance to get the wire wrong in a
// way no offline fixture can see.
//
// So the agent-side half of a test is expressed against a small driver instead
// of against an imported class. Which implementation answers is chosen by
// AGENTMESH_AGENT_SDK:
//
//   typescript             (DEFAULT) the imported TS SDK, in this process,
//                          exactly as the tests did before this file existed.
//   typescript-subprocess  the same TS SDK, driven through the line protocol
//                          below as a child process.
//   rust                   the `agentmesh` crate, via
//                          sdk-rust/examples/conformance_agent.rs.
//
// The default is `typescript` and it is in-process on purpose: a run that asks
// for nothing new must behave exactly as it did before, with no child process
// in the picture. `typescript-subprocess` exists so the line protocol itself is
// proven against an SDK that is known to pass — when a Rust run then goes red,
// the harness is not a suspect.
//
// ── The line protocol ──────────────────────────────────────────────────────
//
// stdin, one JSON object per line, harness → agent:
//
//   {"id":1,"cmd":"register","name":"...","visibility":"unlisted","guarded":false,
//    "skills":[{"id":"echo","name":"echo","description":"..."}]}
//   {"id":2,"cmd":"deregister"}
//   {"id":3,"cmd":"close"}
//
// stdout, one JSON object per line, agent → harness:
//
//   {"ev":"ready","agent_id":"U...","sdk":"agentmesh-rust 0.4.0"}
//   {"ev":"reply","id":1,"ok":true,"guarded":true}
//   {"ev":"reply","id":1,"ok":false,"error":"...","unsupported":true}
//   {"ev":"handled","skill":"echo","envelope_id":"...","from":"U...","input":{...}}
//
// The `guarded` on a register REPLY is what the SDK CONCLUDED, never what was
// asked (EXT-6 §7.1): a refused guard leaves the agent on its public inbox, and
// an agent that reported back the request would have the harness watching a
// subject nothing relays to. Both SDKs answer it from the live SUBSCRIPTION —
// Rust's `listening_on_guarded()`, TypeScript's `listeningOnGuarded` — and not
// from the service's answer, because a second register() does not re-point an
// agent that is already listening, so the answer and the subscription can
// legitimately disagree and only the subscription decides whether mail arrives.
//
// stderr is diagnostics only; the harness keeps it for failure messages.
//
// Two rules keep the agents from turning into second SDK implementations:
//
//   1. Every registered skill has ONE fixed behaviour — answer `{ok: <input>}`
//      and report a `handled` event. No test-specific logic ever goes in an
//      agent; a test that needs different behaviour needs a new *command*,
//      added to every agent at once.
//   2. Agents report, they do not judge. Signatures, ordering and payload
//      shape are verified in the harness with the reference verifier, over
//      whatever the agent says it saw.
//
// ── When an SDK cannot run a test ──────────────────────────────────────────
//
// It reports `not-validated`, the verdict the suite already uses for a
// credential that was configured and turned out to be unusable. The reasoning
// is the same: the operator ASKED for this SDK, the test did not run, and
// "passes and env-skips only" must not be satisfiable by pointing the suite at
// an implementation that cannot answer. It is not env-skip (nothing is
// unconfigured) and not fail (the SDK has not been shown to be wrong).
// `--ci` exits 1 on it. Throw `not-validated: <reason>` and run.mjs does the
// rest.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, sdkUnderTest } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SDK_RUST = join(REPO, "sdk-rust");
const AGENT_TS = join(HERE, "..", "agents", "agent-ts.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Commands every agent implementation must answer today. A test that needs
 *  more declares it with requireAgentOps() and gets not-validated on an
 *  implementation that has not caught up, instead of a mystery timeout. */
const CORE_OPS = ["register", "respond", "deregister"];

/** EXT-6 §7.1: register with `guarded` AND report back the subject the SDK
 *  actually ended up listening on. Declared apart from plain `register` because
 *  an implementation can perfectly well have the first half and not the second,
 *  and a test that assumed otherwise would read "asked, unknown" as "guarded"
 *  and then watch a subject nothing relays to. */
const GUARDED_REGISTER = "register:guarded";

const BACKENDS = {
  typescript: {
    inProcess: true,
    ops: [...CORE_OPS, GUARDED_REGISTER],
    label: () => `TypeScript, in process (${sdkUnderTest()})`,
  },
  "typescript-subprocess": {
    ops: [...CORE_OPS, GUARDED_REGISTER],
    label: () => `TypeScript, subprocess (${sdkUnderTest()})`,
    launch() {
      if (!existsSync(AGENT_TS)) {
        throw new Error(`not-validated: conformance agent missing at ${AGENT_TS}`);
      }
      return { cmd: process.execPath, args: [AGENT_TS], cwd: HERE };
    },
  },
  rust: {
    ops: [...CORE_OPS, GUARDED_REGISTER],
    label: () => `Rust crate (sdk-rust, ${rustAgentBinary() ? "prebuilt example" : "not built"})`,
    launch() {
      const bin = rustAgentBinary();
      if (!bin) {
        // Deliberately NOT `cargo run`: a cold build takes minutes and would
        // either blow the boot timeout or make the test's duration a statement
        // about the host's build cache. Build it, then run the suite.
        throw new Error(
          "not-validated: the Rust conformance agent is not built — run " +
          "`cargo build --example conformance_agent` in sdk-rust/ " +
          "(or point AGENTMESH_RUST_AGENT at the binary)",
        );
      }
      return { cmd: bin, args: [], cwd: SDK_RUST };
    },
  },
};

function rustAgentBinary() {
  const explicit = process.env.AGENTMESH_RUST_AGENT?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  // CARGO_TARGET_DIR first: a shared target directory is common (this machine
  // has one), and looking only under sdk-rust/target would report a perfectly
  // good build as missing.
  const roots = [process.env.CARGO_TARGET_DIR?.trim(), join(SDK_RUST, "target")].filter(Boolean);
  for (const root of roots) {
    for (const profile of ["release", "debug"]) {
      for (const ext of [".exe", ""]) {
        const p = join(root, profile, "examples", `conformance_agent${ext}`);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** Which agent implementation this run selected. */
export function agentSdkId() {
  const id = (process.env.AGENTMESH_AGENT_SDK ?? "typescript").trim();
  if (!BACKENDS[id]) {
    throw new Error(
      `not-validated: AGENTMESH_AGENT_SDK=${id} is not an implementation this suite knows ` +
      `(have: ${Object.keys(BACKENDS).join(", ")})`,
    );
  }
  return id;
}

/** One line for the runner's header. Never throws: an unknown value has to be
 *  reportable, and each test says not-validated on its own. */
export function agentSdkLabel() {
  try {
    const id = agentSdkId();
    return `${id} — ${BACKENDS[id].label()}`;
  } catch (e) {
    return `${(process.env.AGENTMESH_AGENT_SDK ?? "").trim() || "(unset)"} — UNKNOWN (${String(e.message ?? e).replace(/^not-validated:\s*/, "")})`;
  }
}

/** Declare the agent-side operations a test needs. Throws `not-validated:` on
 *  an implementation that does not have them all yet. */
export function requireAgentOps(...ops) {
  const id = agentSdkId();
  const have = new Set(BACKENDS[id].ops);
  const missing = ops.filter((o) => !have.has(o));
  if (missing.length) {
    throw new Error(
      `not-validated: the ${id} conformance agent does not implement ${missing.join(", ")} — ` +
      "this test's agent-side behaviour could not be exercised against it",
    );
  }
}

// ─── The in-process TypeScript backend ──────────────────────────────────────

/** Whether a TypeScript agent's LIVE inbox subscription is the private
 *  `.guarded` one (EXT-6 §7.1) — the same question Rust answers with
 *  `listening_on_guarded()`.
 *
 *  `listeningOnGuarded` and not `guarded`: the second is the service's answer to
 *  the last ask, the first is the subscription, and the SDK's own comment says
 *  only the subscription answers "can mail still reach us on the public inbox?".
 *
 *  Both are `private` in the TypeScript types and plain properties at runtime,
 *  so this reaches past the declared surface. That is a REPORTED GAP, not a
 *  liberty being taken quietly: the SDK documents that a caller must read the
 *  concluded guard rather than assume the ask succeeded, and then gives that
 *  caller no public way to read it. A published accessor would replace this. */
function readGuarded(a) {
  const v = a.listeningOnGuarded ?? a.guarded;
  return v === true;
}

async function launchInProcess(env, opts) {
  const { AgentMesh } = sdk;
  if (!AgentMesh?.connect) throw new Error("SDK under test exports no AgentMesh.connect");
  const a = await AgentMesh.connect(env.meshWsUrl, {
    authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
    nkeySeed: opts.seed,
  });
  const handled = [];
  return {
    kind: "in-process",
    agentId: a.agentId,
    sdkBanner: sdkUnderTest(),
    handled,
    log: () => "(in-process: no child output)",
    // Every field a test passes reaches the SDK. It used to forward exactly
    // name/visibility/skills, which silently dropped `guarded` — a test could
    // ask for a guarded registration, get an unguarded one, and be told nothing.
    // An option this driver does not understand is still the test's to send.
    async register({ visibility = "unlisted", skills = [], ...rest }) {
      for (const s of skills) {
        a.onRequest(s.id, async (input, ctx) => {
          handled.push({ skill: s.id, envelope_id: ctx?.envelope?.id ?? null, from: ctx?.envelope?.from ?? null, input });
          return { ok: input };
        });
      }
      await a.register({ visibility, skills, ...rest });
      return { guarded: readGuarded(a) };
    },
    async deregister() { await a.deregister(); },
    async close() { await a.close().catch(() => {}); },
  };
}

// ─── The subprocess backend (shared by every out-of-process agent) ──────────

async function launchSubprocess(env, opts, backend) {
  const { cmd, args, cwd } = backend.launch();
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MESH_URL: env.meshWsUrl,
      // The creds travel in the child's environment rather than a temp file:
      // the agent's interface is ours to define, and nothing here needs a
      // secret written to disk.
      MESH_CREDS_JWT: env.creds.jwt,
      MESH_CREDS_SEED: env.creds.seed,
      MESH_AGENT_SEED: opts.seed,
      PAN_REGISTRAR: env.registrar,
    },
  });

  let log = "";
  let exited = null;
  const keep = (d) => { log += d; if (log.length > 20_000) log = log.slice(-20_000); };
  child.stderr.on("data", keep);
  // Writing to a dead child's stdin emits 'error' on the stream; unhandled,
  // that takes the whole runner down instead of failing one test.
  child.stdin.on("error", (e) => keep(`stdin: ${e.message}\n`));
  child.on("exit", (code, signal) => { exited = `exit=${code} signal=${signal}`; });
  child.on("error", (e) => { keep(`spawn error: ${e.message}\n`); exited = `spawn-failed`; });

  const handled = [];
  const replies = new Map(); // command id -> {ok,...}
  let ready = null;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { keep(`[unparsed stdout] ${line}\n`); continue; }
      if (msg.ev === "ready") ready = msg;
      else if (msg.ev === "reply") replies.set(msg.id, msg);
      else if (msg.ev === "handled") handled.push(msg);
      else keep(`[unknown event] ${line}\n`);
    }
  });

  const tail = () => log.slice(-600).trim() || "(no output)";
  // Poll rather than race an event, the c12/c13 idiom: a child that dies
  // during boot must produce a verdict, not a hang.
  const waitFor = async (what, pred, ms) => {
    for (let i = 0; i * 250 < ms; i++) {
      const v = pred();
      if (v !== undefined && v !== null) return v;
      if (exited) throw new Error(`conformance agent ${exited} while waiting for ${what}. output: ${tail()}`);
      await sleep(250);
    }
    throw new Error(`conformance agent never produced ${what} in ${ms}ms. output: ${tail()}`);
  };

  await waitFor("its ready line", () => ready, 30_000);

  let nextId = 0;
  const call = async (cmd, body = {}, ms = 30_000) => {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ id, cmd, ...body }) + "\n");
    const r = await waitFor(`a reply to ${cmd}`, () => replies.get(id), ms);
    replies.delete(id);
    if (!r.ok) {
      // An agent that says "unsupported" has told us this implementation
      // cannot exercise the behaviour — that is not-validated, not a fail.
      throw new Error(
        `${r.unsupported ? "not-validated: " : ""}${agentSdkId()} conformance agent refused ${cmd}: ${r.error ?? "no reason given"}`,
      );
    }
    return r;
  };

  return {
    kind: "subprocess",
    agentId: ready.agent_id,
    sdkBanner: ready.sdk ?? null,
    handled,
    log: tail,
    // The reply is normalised to the same shape the in-process backend returns,
    // so a test reads one answer and not one per backend. Absent `guarded` is
    // false: an agent that does not say it ended up on the private subject has
    // not said it did.
    async register(opts2) {
      const r = await call("register", { visibility: "unlisted", skills: [], ...opts2 }, 45_000);
      return { guarded: r.guarded === true };
    },
    deregister: () => call("deregister", {}, 20_000),
    async close() {
      try { await call("close", {}, 5_000); } catch { /* killing next */ }
      for (let i = 0; i < 12 && !exited; i++) await sleep(250);
      child.kill();
    },
  };
}

/**
 * Boot the agent under test. Returns a handle whose surface is the same for
 * every implementation:
 *
 *   agentId              its public nkey
 *   handled              live array of {skill, envelope_id, from, input}
 *   register({name, visibility, skills, guarded, ...}) -> {guarded}
 *                        every field reaches the SDK; the returned `guarded` is
 *                        what the SDK CONCLUDED (EXT-6 §7.1), not what was asked
 *   deregister()
 *   close()              always call this in a finally
 *   log()                child output, for failure detail
 *
 * `opts.seed` fixes the identity; omitted, a fresh one is minted here so the
 * harness (not the agent) owns the identity in every implementation.
 */
export async function launchAgent(env, opts = {}) {
  if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
  const id = agentSdkId();
  const backend = BACKENDS[id];
  const seed = opts.seed ?? td.decode(nkeys.createUser().getSeed());
  return backend.inProcess
    ? launchInProcess(env, { ...opts, seed })
    : launchSubprocess(env, { ...opts, seed }, backend);
}
