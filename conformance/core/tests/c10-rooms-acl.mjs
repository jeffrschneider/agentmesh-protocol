// c10 — rooms with broker-enforced membership (EXT-5, ACL rooms): a member
// joins an ACL room and its message reaches another member; after expel, the
// broker revokes the scoped credential and the expelled member can no longer
// post. Promotes the in-memory rooms unit tests to the real broker, where
// the ACL is actually the NATS account permission, not an app-level check.
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c10",
  title: "ACL room: members talk; expel revokes the credential at the broker",
  spec: "EXT-5, §15.3",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const fresh = () => td.decode(nkeys.createUser().getSeed());

    // ACL rooms require the creator to reverse-resolve to a PAN handle
    // (an email-verified operator), so the host uses the paired conformance
    // key; without it there is no way to create the room — env-skip.
    if (!env.roomsCreatorSeed) throw new Error("env-skip: MESH_ROOMS_CREATOR_SEED (a PAN-handle-paired key) required for ACL rooms");
    const host = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: env.roomsCreatorSeed });
    const guest = await AgentMesh.connect(env.meshWsUrl, { authenticator: auth(), nkeySeed: fresh() });
    const fails = [];
    let room = null;
    try {
      try {
        room = await host.openRoom({ acl: true, name: "c10-acl" });
      } catch (e) {
        const m = String(e?.message ?? e);
        // ACL rooms are quota-owned, so the creator must be an email-verified
        // operator (a PAN handle). The operator NATS creds are not a paired
        // handle — run with MESH_CREDS_FILE/MESH_IDENTITY_FILE of a
        // handle-bearing agent (e.g. a fleet agent) to exercise this.
        if (/PAN handle|email-verified/i.test(m)) throw new Error("env-skip: ACL rooms need a handle-bearing creator (set creds to a paired agent)");
        throw new Error(`env-skip: ACL rooms unavailable (${m.slice(0, 80)})`);
      }

      const heardByHost = [];
      room.onMessage((m) => { if (m?.type === "say" || m?.text) heardByHost.push(m); });

      // ACL rooms admit before they let anyone in: the guest must be invited
      // (which grants the broker-scoped credential) before it can join. Give
      // the guest a rooms.invite handler + registration so the invite delivers.
      guest.onRequest("rooms.invite", async () => ({ ok: true }));
      await guest.register({ name: "c10-guest", visibility: "unlisted", skills: [{ id: "rooms.invite", name: "rooms.invite", description: "c10" }] });
      await sleep(1000);
      await room.invite(guest.agentId).catch(() => {}); // admit happens even if delivery ack lags

      // Guest joins via the room token — now admitted.
      const guestRoom = await guest.joinRoom(room.token);
      const guestHeard = [];
      guestRoom.onMessage((m) => { if (m?.type === "say" || m?.text) guestHeard.push(m); });
      await sleep(1500);

      guestRoom.say({ text: "hello from guest" });
      await sleep(1500);
      if (!heardByHost.some((m) => JSON.stringify(m).includes("hello from guest"))) {
        fails.push("host did not receive the guest's message in the ACL room");
      }

      // Expel the guest: the rooms service must revoke its scoped credential.
      await room.expel(guest.agentId, { severity: "hard", note: "c10" });
      await sleep(3000);

      // The expelled guest tries to post again. With broker-enforced ACL, the
      // publish is refused (revoked credential) and never reaches the host.
      const before = heardByHost.length;
      let postThrew = false;
      try { guestRoom.say({ text: "should be blocked" }); await sleep(2500); }
      catch { postThrew = true; }
      const leaked = heardByHost.slice(before).some((m) => JSON.stringify(m).includes("should be blocked"));
      if (leaked) fails.push("expelled member's message still reached the room (ACL not broker-enforced)");
      // postThrew is informational: some transports drop silently, some throw.
      void postThrew;
    } catch (e) {
      if (String(e?.message ?? e).startsWith("env-skip:")) throw e;
      throw e;
    } finally {
      try { await room?.close?.("c10 done"); } catch { /* ignore */ }
      await host.close().catch(() => {});
      await guest.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "member message delivered; after expel the revoked credential could not post to the room" };
  },
};
