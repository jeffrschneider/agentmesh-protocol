// Shared harness for resolver-under-test runs: local mock servers plus an
// async spawn of the reference resolver (mesh-adapter). Async on purpose —
// the mocks live in THIS process, so a sync spawn would deadlock the child
// against our own blocked event loop.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ADAPTER = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

export function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** Pull the JSON object out of a resolver run's output. The adapter prints
 *  human-facing warnings (pin alarms, unsigned-card refusals) alongside the
 *  `--json` result, so take the first brace through the last. */
export function jsonFrom(out) {
  const a = out.indexOf("{"), b = out.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(out.slice(a, b + 1)); } catch { return null; }
}

export function runResolver(args, extraEnv, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      // Every run gets its own state directory. The resolver PINS what it
      // resolves (handle -> key, and the registrar's signing key), so a suite
      // sharing the developer's real state would both pollute it and inherit
      // pins from previous runs — the tests would stop being about the code.
      env: {
        ...process.env,
        MESH_ADAPTER_STATE: mkdtempSync(join(tmpdir(), "mesh-conformance-")),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", () => { clearTimeout(t); resolve(out); });
  });
}
