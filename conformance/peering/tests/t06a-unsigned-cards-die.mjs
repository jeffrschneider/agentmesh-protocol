// SPEC-NAMING §5.3: an unsigned card is invalid — the reference resolver
// must discard it. This HOLDS today; this test exists so it can never
// silently stop holding. (Separate from t06b so a regression here is a
// status change CI can see, not a detail lost inside an expected-red test.)
//
// Both authorities are covered. The anchor-domain half is the one that bit:
// §5.5 lets a domain outrank the registrar, so "the domain said so" is exactly
// the excuse a resolver might use to skip verification — and for a while the
// adapter's room-invite path did skip it, reading the card straight off an
// unverified fetch. Being authoritative about WHERE a card lives is not
// permission to serve an unsigned one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve, runResolver } from "../lib/resolver.mjs";

const HANDLE = "Fake.someone@example.com";

const RESOLVER_SRC = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

const unsignedCard = () => JSON.stringify({
  ok: true,
  card: { handle: HANDLE, operator: { name: "Nobody" }, binding: "agent-key", endpoints: [] },
});

const refused = (out) =>
  /unsigned|discarding|did not resolve|signature/i.test(out) && !/✓ Fake/.test(out);

export default {
  id: "t06a",
  title: "unsigned cards die: resolver discards a card without a signature",
  spec: "SPEC-NAMING §5.3",
  async run() {
    const problems = [];

    // (a) the registrar of record serves an unsigned card
    const badRegistrar = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(unsignedCard());
    });
    try {
      const out = await runResolver(["diag", "resolve", HANDLE], {
        PAN_REGISTRAR: `http://127.0.0.1:${badRegistrar.address().port}`,
      });
      if (!refused(out)) {
        problems.push(`the registrar's unsigned card was accepted — §5.3 REGRESSION (resolver said: ${out.trim().split("\n").pop()})`);
      }
    } finally {
      badRegistrar.close();
    }

    // (b) the ANCHOR DOMAIN serves an unsigned card. It outranks the registrar
    // on WHERE the card lives; it does not outrank §5.3.
    const badDomain = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/.well-known/webfinger")) {
        return res.end(JSON.stringify({
          subject: `acct:${HANDLE}`,
          links: [{ rel: "urn:pan:card", href: `http://127.0.0.1:${badDomain.address().port}/card` }],
        }));
      }
      res.end(unsignedCard());
    });
    try {
      const out = await runResolver(
        ["diag", "resolve", HANDLE, "--anchor-webfinger", `http://127.0.0.1:${badDomain.address().port}`],
        // No registrar to fall back to: the only card on offer is the domain's
        // unsigned one, so accepting it is the only way to "resolve" at all.
        { PAN_REGISTRAR: "http://127.0.0.1:1" },
      );
      if (!refused(out)) {
        problems.push(`the anchor domain's unsigned card was accepted — §5.3 REGRESSION (resolver said: ${out.trim().split("\n").pop()})`);
      }
    } finally {
      badDomain.close();
    }

    // (c) STRUCTURAL, not behavioral. The paths above run through `diag
    // resolve`, which has always verified. The place §5.3 actually lapsed was
    // the daemon's room-invite/expel resolver, which read the card off an
    // unverified fetch — and driving that needs a live daemon and a mesh, so
    // no cheap test covers it. What is checkable here is the shape that made
    // the lapse possible: two ways to resolve, one of them unverified. The
    // adapter now has exactly one unverified fetch and exactly one caller for
    // it (resolveCard, which verifies). A second call site is the regression.
    try {
      const src = readFileSync(RESOLVER_SRC, "utf8");
      const sites = (src.match(/fetchResolveDoc\(/g) ?? []).length;
      const body = src.slice(src.indexOf("async function resolveCard("));
      const guarded = body.slice(0, body.indexOf("\n}")).includes("fetchResolveDoc(");
      if (sites !== 2 || !guarded) {
        problems.push(
          `the unverified resolve fetch is not funnelled through resolveCard (${sites} reference${sites === 1 ? "" : "s"} to fetchResolveDoc, ` +
          `${guarded ? "one inside resolveCard" : "none inside resolveCard"}) — a caller reading a card off an unverified fetch is how §5.3 lapsed on the room-invite path`,
        );
      }
    } catch (e) {
      problems.push(`could not read the resolver source to check its shape: ${e.message}`);
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "unsigned cards discarded from both the registrar and the anchor domain; one verified resolver, no second door" };
  },
};
