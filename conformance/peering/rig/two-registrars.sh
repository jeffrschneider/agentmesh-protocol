#!/bin/bash
# Bring up two local registrar instances (A on 18081, B on 18082), each with
# its own embedded Postgres and card-signing key — the registrar pair that
# un-env-skips t07/t08. Idempotent-ish: kills any prior instances first.
set -uo pipefail
RIG="${RIG:-$HOME/AppData/Local/Temp/claude/rig}"
BIN="D:/cargo-target/debug/agentmesh-naming.exe"
mkdir -p "$RIG"

# Loopback only (BIND_ADDR): this is a test rig on somebody's laptop, not a
# deployment. Binding every interface would expose a registrar that runs with a
# known delegate secret and rate limiting turned off to whatever network the
# machine is on, and would make the developer approve a firewall exception for
# the privilege.

# fresh seeds only if absent, so re-runs keep the same registrar identities
if [ ! -f "$RIG/seeds.txt" ]; then
  node -e "import('nkeys.js').then(n=>{for(const l of ['A','B'])console.log(l+':'+Buffer.from(n.createAccount().getSeed()).toString())})" \
    > "$RIG/seeds.txt"
fi
SEEDA=$(grep '^A:' "$RIG/seeds.txt" | cut -d: -f2)
SEEDB=$(grep '^B:' "$RIG/seeds.txt" | cut -d: -f2)

# Who each instance will accept a migration IN from (PAN_PEERS, §5.6 check 5).
#
# This is not configuration convenience, it is what makes the rig able to tell a
# real peer from a hostile one. With PAN_PEERS unset the registrar falls back to
# a loopback-only dev branch that admits ANY loopback origin as a peer, so on
# this rig — where every origin is loopback — an attacker's server and a genuine
# peer are indistinguishable, and a test that stands one up would pass whether
# or not the allowlist exists. Set it, and membership is the whole test.
PEER_A="${PEER_A:-http://localhost:18081}"
PEER_B="${PEER_B:-http://localhost:18082}"

# A reserved loopback origin that B lists as a peer but NOTHING in the rig
# serves: t13 binds its own fixture there. B trusting it is deliberate. The
# allowlist is the outer gate, and the checks behind it (§5.6/§7.8: the referral
# must be SIGNED by a key the peer publishes at /api/registrar-key) can only be
# exercised by a server this registrar is configured to believe. t13's other
# fixture runs on an ephemeral port that is in nobody's list, which is how the
# gate itself gets tested.
TEST_PEER="${TEST_PEER:-http://127.0.0.1:18089}"

# Stop any prior rig registrars. taskkill wants the WINDOWS pid (`ps -W`
# column 4), not the Cygwin one in column 1 — passing column 1 silently kills
# nothing, the old binary keeps the port and the exe file locked, and the next
# `cargo build` fails with "Access is denied" while the rig serves stale code.
for pid in $(ps -W 2>/dev/null | grep -i agentmesh-naming | awk '{print $4}'); do taskkill //F //PID "$pid" >/dev/null 2>&1; done
sleep 1

BIND_ADDR=127.0.0.1 PORT=18081 CATALOG_DATA_DIR="$RIG/rA" PAN_CARD_SEED="$SEEDA" \
  PAN_DELEGATE_SECRET=testsecret PAN_DELEGATE_PARTNER=testpartner PAN_REHOME_MAX_PER_HOUR=100000 PAN_SELF_URL="$PEER_A" \
  PAN_PEERS="$PEER_B" \
  "$BIN" > "$RIG/rA.log" 2>&1 &
echo "registrar A (18081) pid $!  peers: $PEER_B"
BIND_ADDR=127.0.0.1 PORT=18082 CATALOG_DATA_DIR="$RIG/rB" PAN_CARD_SEED="$SEEDB" \
  PAN_DELEGATE_SECRET=testsecret PAN_DELEGATE_PARTNER=testpartner PAN_REHOME_MAX_PER_HOUR=100000 PAN_SELF_URL="$PEER_B" \
  PAN_PEERS="$PEER_A,$TEST_PEER" \
  "$BIN" > "$RIG/rB.log" 2>&1 &
echo "registrar B (18082) pid $!  peers: $PEER_A,$TEST_PEER"

for url in "$PEER_A/healthz" "$PEER_B/healthz"; do
  for i in $(seq 1 60); do curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && { echo "up: $url"; break; }; sleep 2; done
done

# The suite reads these three. REGISTRAR_A/B must be spelled exactly as
# PAN_PEERS spells them (the allowlist is an exact normalized match, so
# 127.0.0.1 where the peer list says localhost is not a peer).
cat <<EOF

export REGISTRAR_A=$PEER_A REGISTRAR_B=$PEER_B REGISTRAR_TEST_PEER=$TEST_PEER
EOF
