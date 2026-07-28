// Core conformance harness (same discipline as ../peering/run.mjs).
//
//   node run.mjs              run everything, print the board
//   node run.mjs --only t05   run one test
//   node run.mjs --ci         compare against expectations.json: exit 1 on any
//                             REGRESSION (a test whose recorded status was
//                             "pass" that no longer passes) or any
//                             NOT-VALIDATED result. Improvements are
//                             reported with a prompt to update the baseline.
//   node run.mjs --update     rewrite expectations.json from this run
//
// The discipline (do not soften it): a red test is either a code defect or a
// spec defect, decided explicitly and in writing. Editing a test to make it
// pass without citing which of the two it was is how a constitution dies.
//
// Verdicts: pass / fail / error / env-skip (prerequisite not configured) /
// pending-peer / not-validated. The last is an env-skip that does NOT get to
// be a skip: a credential file was CONFIGURED but unreadable or empty, so the
// tests that would have exercised it could not run. "Passes and env-skips
// only" must never be satisfiable by breaking a secret, so not-validated is
// non-green and --ci exits 1 on it — the operator asked for credentials and
// did not get them.
//
// The same verdict, for the same reason, covers an SDK that cannot run a test:
// AGENTMESH_AGENT_SDK names which implementation plays the agent under test
// (see lib/agent-under-test.mjs), and if the one the operator asked for cannot
// exercise a test's agent-side behaviour, that test reports not-validated. A
// test throws `not-validated: <reason>` to say so, exactly as it throws
// `env-skip: <reason>` for an absent prerequisite.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "../peering/lib/env.mjs";
import { sdkUnderTest } from "../peering/lib/sdk.mjs";
import { agentSdkLabel } from "./lib/agent-under-test.mjs";

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
      : msg.includes("not-validated:")
        ? { status: "not-validated", detail: msg.slice(msg.indexOf("not-validated:") + "not-validated:".length).trim() }
        : { status: "error", detail: msg };
  }
  // An env-skip whose named variable had a CONFIGURED-but-unreadable
  // credential behind it is not a skip — the operator asked for that
  // credential. Upgrade it to not-validated so it cannot hide in the green.
  if (r.status === "env-skip") {
    const varName = Object.keys(env.credentialProblems ?? {}).find((v) => String(r.detail ?? "").includes(v));
    if (varName) r = { status: "not-validated", detail: `${varName} is configured but unusable (${env.credentialProblems[varName]}) — this test needed it and did not run` };
  }
  results.push({ id: mod.id, title: mod.title, spec: mod.spec, ms: Date.now() - t0, ...r });
}

// Say what was tested. A board that does not name the artifact under test
// cannot be cited as evidence about any particular artifact — and since the
// agent under test can now be a different implementation from the SDK module
// the harness itself imports, both are named.
console.log(`SDK under test — ${sdkUnderTest()}`);
console.log(`Agent under test — ${agentSdkLabel()}\n`);

const ICON = { pass: "✓", fail: "✗", "env-skip": "○", "pending-peer": "…", error: "!", "not-validated": "‼" };
for (const r of results) {
  console.log(`${ICON[r.status] ?? "?"} ${r.id}  ${r.title}  [${r.spec}]  ${r.status.toUpperCase()}${r.ms > 1500 ? ` (${(r.ms / 1000).toFixed(1)}s)` : ""}`);
  if (r.detail) console.log(`    ${String(r.detail).split("\n").join("\n    ")}`);
}
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
console.log(`\n${results.length} tests: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);

// not-validated is called out apart from skips: these tests were supposed to
// run (credentials were configured) and did not. A board with any of these
// is not green, whatever the pass count says.
const notValidated = results.filter((r) => r.status === "not-validated");
if (notValidated.length) {
  console.error(`\nNOT VALIDATED — something the operator asked for (a credential, an SDK) could not be used; these tests did not run and this run cannot vouch for what they cover:`);
  for (const r of notValidated) console.error(`  ${r.id}  ${r.detail}`);
}

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
  // regression, just an unavailable environment. "not-validated" is neither:
  // it is reported above and gates the exit code on its own.
  const NOT_EVALUATED = new Set(["env-skip", "pending-peer", "not-validated"]);
  const regressions = results.filter((r) => expected[r.id] === "pass" && r.status !== "pass" && !NOT_EVALUATED.has(r.status));
  const unevaluated = results.filter((r) => expected[r.id] === "pass" && NOT_EVALUATED.has(r.status) && r.status !== "not-validated");
  const improvements = results.filter((r) => expected[r.id] && expected[r.id] !== "pass" && r.status === "pass");
  for (const r of regressions) console.error(`REGRESSION: ${r.id} was pass, now ${r.status} — ${r.detail ?? ""}`);
  for (const r of unevaluated) console.log(`not evaluated: ${r.id} (${r.status}) — prerequisite absent; run the rig/peer to verify`);
  for (const r of improvements) console.log(`IMPROVED: ${r.id} now passes — update expectations.json (--update) to lock it in`);
  // not-validated fails CI regardless of what expectations.json records:
  // fixing it means fixing the credential file, never updating the baseline.
  process.exit(regressions.length || notValidated.length ? 1 : 0);
}
