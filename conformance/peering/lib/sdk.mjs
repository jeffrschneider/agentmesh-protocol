// Which AgentMesh SDK is under test.
//
// By default the suite runs against the PUBLISHED tarball pinned in
// package.json — that is the artifact real consumers install, and it is the
// right thing to hold to the spec. But it also means the suite cannot see a
// fix until it ships, which is backwards for a suite whose job is to decide
// whether something is fit to ship.
//
// So: set AGENTMESH_SDK to a build directory (or a file) to test a release
// candidate instead. run.mjs prints which one answered, every run — a green
// board that does not say what it tested is not evidence of anything.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

function resolveTarget() {
  const override = process.env.AGENTMESH_SDK?.trim();
  if (!override) return { specifier: "agentmesh", label: null };
  const isFile = /\.(mjs|cjs|js)$/i.test(override);
  const entry = isFile ? override : join(override, "dist", "index.js");
  let version = "unknown";
  if (!isFile) {
    try {
      version = JSON.parse(readFileSync(join(override, "package.json"), "utf8")).version ?? "unknown";
    } catch { /* label degrades, the test does not */ }
  }
  return { specifier: pathToFileURL(entry).href, label: `${override} (${version})` };
}

const target = resolveTarget();

/** What answered, for the runner's header. */
export function sdkUnderTest() {
  if (target.label) return `local build: ${target.label}`;
  try {
    const p = JSON.parse(readFileSync(
      new URL("../node_modules/agentmesh/package.json", import.meta.url), "utf8"));
    return `published tarball: agentmesh ${p.version}`;
  } catch {
    return "published tarball: agentmesh (version unknown)";
  }
}

const sdk = await import(target.specifier);

/** The whole SDK namespace, for suites (conformance/core) that drive the
 *  full client — AgentMesh.connect, register, request — not just envelopes. */
export const sdkModule = sdk;

export const {
  createEnvelope,
  signEnvelope,
  verifyEnvelopeSig,
  createTrustAttestation,
  verifyTrustAttestation,
  canonicalJSON,
} = sdk;
