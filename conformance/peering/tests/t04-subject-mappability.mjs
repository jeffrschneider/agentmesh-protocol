// §21 constraint 3 / §14: every protocol subject must be mechanically
// rewritable across an instance boundary. Reads the §14.1 table straight out
// of SPEC.md — the spec is the fixture, so the test cannot drift from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SPEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "SPEC.md");

const rewrite = (subject, instance) => `mesh.peer.${instance}.${subject}`;
const unrewrite = (subject, instance) => {
  const prefix = `mesh.peer.${instance}.`;
  return subject.startsWith(prefix) ? subject.slice(prefix.length) : null;
};

export default {
  id: "t04",
  title: "subject mappability: the §14.1 table rewrites mechanically",
  spec: "SPEC.md §21.3, §14.1",
  async run() {
    const spec = readFileSync(SPEC, "utf8");
    const table = spec.split("### 14.1")[1]?.split("### 14.2")[0];
    if (!table) return { status: "error", detail: "could not locate §14.1 in SPEC.md" };

    const subjects = [...table.matchAll(/^\|\s*`([^`]+)`/gm)].map((m) => m[1]).filter((s) => s !== "Pattern");
    if (subjects.length < 10) return { status: "error", detail: `only ${subjects.length} subjects parsed from §14.1` };

    const problems = [];
    for (const s of subjects) {
      if (!s.startsWith("mesh.")) problems.push(`${s}: outside the mesh. prefix — unrewritable`);
      if (s.startsWith("mesh.peer.") && s !== "mesh.peer.{instance}.>") problems.push(`${s}: squats the reserved relay prefix`);
      const there = rewrite(s, "acme");
      const back = unrewrite(there, "acme");
      if (back !== s) problems.push(`${s}: rewrite round-trip failed (${there} → ${back})`);
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: `${subjects.length} subjects from §14.1 all rewrite and round-trip under mesh.peer.{instance}.` };
  },
};
