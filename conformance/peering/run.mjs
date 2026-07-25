// Peering conformance harness.
//
//   node run.mjs              run everything, print the board
//   node run.mjs --only t05   run one test
//   node run.mjs --ci         compare against expectations.json: exit 1 on any
//                             REGRESSION (a test whose recorded status was
//                             "pass" that no longer passes). Improvements are
//                             reported with a prompt to update the baseline.
//   node run.mjs --update     rewrite expectations.json from this run
//
// The discipline (do not soften it): a red test is either a code defect or a
// spec defect, decided explicitly and in writing. Editing a test to make it
// pass without citing which of the two it was is how a constitution dies.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "./lib/env.mjs";
import { sdkUnderTest } from "./lib/sdk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const ci = args.includes("--ci");
const update = args.includes("--update");

const env = loadEnv();
const files = readdirSync(join(HERE, "tests")).filter((f) => f.endsWith(".mjs")).sort();
const results = [];

for (const f of files) {
  const mod = (await import(`./tests/${f}`)).default;
  if (only && mod.id !== only) continue;
  let r;
  const t0 = Date.now();
  try {
    r = await mod.run(env);
  } catch (e) {
    const msg = String(e?.message ?? e);
    r = msg.startsWith("env-skip:")
      ? { status: "env-skip", detail: msg.slice("env-skip:".length).trim() }
      : { status: "error", detail: msg };
  }
  results.push({ id: mod.id, title: mod.title, spec: mod.spec, ms: Date.now() - t0, ...r });
}

// Say what was tested. A board that does not name the artifact under test
// cannot be cited as evidence about any particular artifact.
console.log(`SDK under test — ${sdkUnderTest()}\n`);

const ICON = { pass: "✓", fail: "✗", "env-skip": "○", "pending-peer": "…", error: "!" };
for (const r of results) {
  console.log(`${ICON[r.status] ?? "?"} ${r.id}  ${r.title}  [${r.spec}]  ${r.status.toUpperCase()}${r.ms > 1500 ? ` (${(r.ms / 1000).toFixed(1)}s)` : ""}`);
  if (r.detail) console.log(`    ${String(r.detail).split("\n").join("\n    ")}`);
}
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
console.log(`\n${results.length} tests: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);

const expectationsPath = join(HERE, "expectations.json");
if (update) {
  writeFileSync(expectationsPath, JSON.stringify(
    Object.fromEntries(results.map((r) => [r.id, r.status])), null, 2) + "\n");
  console.log("expectations.json updated from this run");
} else if (ci) {
  const expected = JSON.parse(readFileSync(expectationsPath, "utf8"));
  // A regression is a test that WAS pass and is now actually worse — fail or
  // error. "env-skip"/"pending-peer" mean the prerequisite (the registrar rig,
  // a real peer) was absent, so the test could not be evaluated; that is not a
  // regression, just an unavailable environment.
  const NOT_EVALUATED = new Set(["env-skip", "pending-peer"]);
  const regressions = results.filter((r) => expected[r.id] === "pass" && r.status !== "pass" && !NOT_EVALUATED.has(r.status));
  const unevaluated = results.filter((r) => expected[r.id] === "pass" && NOT_EVALUATED.has(r.status));
  const improvements = results.filter((r) => expected[r.id] && expected[r.id] !== "pass" && r.status === "pass");
  for (const r of regressions) console.error(`REGRESSION: ${r.id} was pass, now ${r.status} — ${r.detail ?? ""}`);
  for (const r of unevaluated) console.log(`not evaluated: ${r.id} (${r.status}) — prerequisite absent; run the rig/peer to verify`);
  for (const r of improvements) console.log(`IMPROVED: ${r.id} now passes — update expectations.json (--update) to lock it in`);
  process.exit(regressions.length ? 1 : 0);
}
