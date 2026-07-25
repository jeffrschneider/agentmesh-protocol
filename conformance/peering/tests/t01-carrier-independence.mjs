// §21 constraint 1 / §4.5: an envelope verifies with zero transport context,
// and any tampering breaks it. This is the property that makes untrusted
// relay possible at all.
import nkeys from "nkeys.js";
import { createEnvelope, signEnvelope, verifyEnvelopeSig } from "../lib/sdk.mjs";

export default {
  id: "t01",
  title: "carrier independence: envelopes verify offline; tampering breaks them",
  spec: "SPEC.md §21.1, §4.5",
  async run() {
    const kp = nkeys.createUser();
    const from = kp.getPublicKey();
    const envelope = signEnvelope(
      createEnvelope({ type: "request", from, to: from, payload: { skill: "chat", input: "hello" } }),
      kp,
    );

    if (!verifyEnvelopeSig(envelope)) {
      return { status: "fail", detail: "freshly signed envelope does not verify offline" };
    }

    const tamperedPayload = { ...envelope, payload: { skill: "chat", input: "hell0" } };
    if (verifyEnvelopeSig(tamperedPayload)) {
      return { status: "fail", detail: "payload tampering not detected" };
    }

    const sig = envelope.sig ?? envelope.signature;
    if (!sig) return { status: "fail", detail: "signed envelope carries no sig field" };
    const flipped = sig.slice(0, -2) + (sig.slice(-2, -1) === "A" ? "B" : "A") + sig.slice(-1);
    const tamperedSig = { ...envelope, ...(envelope.sig ? { sig: flipped } : { signature: flipped }) };
    if (verifyEnvelopeSig(tamperedSig)) {
      return { status: "fail", detail: "signature tampering not detected" };
    }

    return { status: "pass", detail: "sign → verify offline; payload and signature tampering both detected" };
  },
};
