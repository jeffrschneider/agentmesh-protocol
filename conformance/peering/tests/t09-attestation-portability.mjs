// §9.7 / §21: a trust attestation is a portable signed object — it verifies
// OFFLINE against its own named issuer, with no mesh and no registry consulted.
// That is the property federation needs: reputation that survives crossing a
// boundary (the signature travels; whether to TRUST the issuer stays local).
// A pure-crypto test, like t01 — no infrastructure, always evaluable.
//
// The verification below is deliberately done TWICE: once with the SDK's own
// verifier, and once with nothing but raw Ed25519 and a base32 decoder. The
// first is self-consistency — an SDK checking its own signatures proves the
// two halves agree, and would keep passing if both drifted together. The
// second is the actual claim: "any party, on any mesh, can verify this",
// which means a party holding no AgentMesh code at all.
import nkeys from "nkeys.js";
import nacl from "tweetnacl";
import { createTrustAttestation, verifyTrustAttestation, canonicalJSON } from "../lib/sdk.mjs";

/** Decode an nkey public string to its raw 32-byte Ed25519 key: base32
 *  (RFC 4648, unpadded) of [prefix byte][32 key bytes][2 CRC bytes]. Written
 *  out here on purpose — a foreign implementation has to do exactly this,
 *  with no library of ours, to check one of our attestations. */
function rawPublicKey(nkeyPublic) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of nkeyPublic.trim().toUpperCase()) {
    const idx = A.indexOf(ch);
    if (idx < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // strip the 1-byte prefix and the trailing 2-byte CRC16
  return Uint8Array.from(out.slice(1, out.length - 2));
}

const fromB64Url = (s) =>
  Uint8Array.from(Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"));

export default {
  id: "t09",
  title: "attestations are portable: trust claims verify offline, with or without our code",
  spec: "SPEC.md §9.7, §21",
  async run() {
    const operator = nkeys.createAccount();      // the issuing operator
    const node = nkeys.createUser();             // the subject node
    const subject = node.getPublicKey();

    const att = createTrustAttestation(operator, subject, { trust_tier: "verified", role: "participant" });

    // (a) self-contained: names its own type, issuer, subject, claims, expiry, sig
    for (const k of ["type", "issuer", "subject", "claims", "issued_at", "expires_at", "sig"]) {
      if (!(k in att)) return { status: "fail", detail: `attestation missing '${k}' — not self-contained` };
    }

    // (b) verifies offline against the issuer it names — no mesh in the loop
    if (!verifyTrustAttestation(att, subject)) {
      return { status: "fail", detail: "a freshly minted attestation does not verify offline" };
    }

    // (c) INDEPENDENT verification: raw Ed25519 over the canonical JSON of the
    // object minus its signature. No SDK verifier, no registry, no network —
    // this is what "portable" has to mean, and it is the assertion the SDK
    // verifying its own output cannot make.
    const { sig, ...signed } = att;
    const independent = nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalJSON(signed)),
      fromB64Url(sig),
      rawPublicKey(att.issuer),
    );
    if (!independent) {
      return { status: "fail", detail: "the attestation did not verify under plain Ed25519 over its canonical JSON — it is only checkable by our own code, which is not portability" };
    }

    // (d) tampering with the claim breaks it, under BOTH verifiers
    const tampered = { ...att, claims: { trust_tier: "verified", role: "service" } };
    if (verifyTrustAttestation(tampered, subject)) {
      return { status: "fail", detail: "claim tampering not detected — the attestation is not integrity-protected" };
    }
    const { sig: tsig, ...tsigned } = tampered;
    if (nacl.sign.detached.verify(new TextEncoder().encode(canonicalJSON(tsigned)), fromB64Url(tsig), rawPublicKey(att.issuer))) {
      return { status: "fail", detail: "claim tampering not detected by independent verification" };
    }

    // (e) a different operator cannot forge the same issuer's word
    const impostor = nkeys.createAccount();
    const forged = createTrustAttestation(impostor, subject, { trust_tier: "verified" });
    forged.issuer = att.issuer; // claim to be the real operator
    if (verifyTrustAttestation(forged, subject)) {
      return { status: "fail", detail: "an attestation signed by one key but claiming another issuer verified — forgeable" };
    }

    // (f) an expired claim is refused. There is no revocation for a travelled
    // claim (§9.7), so expiry is the only control there is, and a verifier
    // that treats it as advisory has no control at all.
    const stale = createTrustAttestation(operator, subject, { trust_tier: "verified" }, 1000, new Date(Date.now() - 60_000));
    if (verifyTrustAttestation(stale, subject)) {
      return { status: "fail", detail: "an expired attestation verified — expiry is the only withdrawal mechanism a portable claim has" };
    }

    return {
      status: "pass",
      detail: "portable attestation verifies offline against its issuer under raw Ed25519 (no SDK verifier in the loop); tampering, issuer-forgery and expiry all rejected",
    };
  },
};
