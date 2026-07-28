// SPEC-NAMING §5.5: resolution authority flows from the name's owner — the
// anchor domain, where it serves WebFinger for the anchor, OUTRANKS the
// registrar of record. Both authorities are stood up here serving valid,
// correctly signed cards that name DIFFERENT agent keys, so the test can only
// pass if the resolver honors the precedence. Probing the domain is not the
// property; preferring its answer is. (The earlier version asserted only that
// the probe fired, which a resolver that ignored the answer would also pass.)
//
// The suite stands in as the anchor domain through the documented seam
// `--anchor-webfinger <base>` — a flag, not an env var, because whatever
// answers this probe decides which key a name resolves to.
import nkeys from "nkeys.js";
import { canonicalJSON } from "../lib/sdk.mjs";
import { serve, runResolver, jsonFrom } from "../lib/resolver.mjs";

const HANDLE = "Agent.someone@example.com";

function signedCardDoc(signer, agentId) {
  const card = {
    handle: HANDLE,
    binding: "agent-key",
    endpoints: [{ protocol: "agentmesh", agent_id: agentId }],
  };
  return JSON.stringify({
    ok: true,
    card,
    registrar_key: signer.getPublicKey(),
    registrar_sig: Buffer.from(signer.sign(new TextEncoder().encode(canonicalJSON(card)))).toString("base64"),
  });
}

export default {
  id: "t06b",
  title: "the anchor domain outranks: its card wins over the registrar's",
  spec: "SPEC-NAMING §5.5, §5.2",
  async run() {
    const domainKey = nkeys.createAccount();
    const registrarKey = nkeys.createAccount();
    const domainAgent = nkeys.createUser().getPublicKey();
    const registrarAgent = nkeys.createUser().getPublicKey();

    let webfingerHits = 0;
    const domain = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/.well-known/webfinger")) {
        webfingerHits++;
        return res.end(JSON.stringify({
          subject: `acct:${HANDLE}`,
          links: [{ rel: "urn:pan:card", href: `http://127.0.0.1:${domain.address().port}/card` }],
        }));
      }
      if (req.url === "/card") return res.end(signedCardDoc(domainKey, domainAgent));
      // The signing key, published OUT OF BAND (SPEC-NAMING §5.3): a verifier
      // must not bootstrap trust from the same response it is verifying, so a
      // card whose only claimed key is inside itself proves nothing. This
      // stand-in used to 404 here, which made it a registrar that cannot be
      // verified at all rather than a legitimate anchor domain.
      if (req.url === "/api/registrar-key") {
        return res.end(JSON.stringify({ ok: true, keys: [domainKey.getPublicKey()] }));
      }
      res.statusCode = 404;
      res.end();
    });
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/registrar-key") {
        return res.end(JSON.stringify({ ok: true, keys: [registrarKey.getPublicKey()] }));
      }
      res.end(signedCardDoc(registrarKey, registrarAgent));
    });

    try {
      const out = await runResolver(
        ["diag", "resolve", HANDLE, "--json", "--anchor-webfinger", `http://127.0.0.1:${domain.address().port}`],
        { PAN_REGISTRAR: `http://127.0.0.1:${registrar.address().port}` },
      );
      const r = jsonFrom(out);
      if (!webfingerHits) {
        return { status: "fail", detail: "resolver never consulted the anchor domain's WebFinger — the §5.5 authority chain is not implemented" };
      }
      if (!r?.resolved) {
        return { status: "fail", detail: `resolver did not resolve the handle at all: ${out.trim().split("\n").pop()}` };
      }
      if (r.agentId === registrarAgent) {
        return { status: "fail", detail: "the REGISTRAR's card won — §5.5 precedence is inverted: the anchor domain must outrank the registrar of record" };
      }
      if (r.agentId !== domainAgent) {
        return { status: "fail", detail: `resolved to an unexpected key ${r.agentId} (the domain served ${domainAgent})` };
      }
      return { status: "pass", detail: `anchor domain consulted (${webfingerHits} hit${webfingerHits > 1 ? "s" : ""}) and its card outranked the registrar's` };
    } finally {
      domain.close();
      registrar.close();
    }
  },
};
