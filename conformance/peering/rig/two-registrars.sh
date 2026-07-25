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

# Stop any prior rig registrars. taskkill wants the WINDOWS pid (`ps -W`
# column 4), not the Cygwin one in column 1 — passing column 1 silently kills
# nothing, the old binary keeps the port and the exe file locked, and the next
# `cargo build` fails with "Access is denied" while the rig serves stale code.
for pid in $(ps -W 2>/dev/null | grep -i agentmesh-naming | awk '{print $4}'); do taskkill //F //PID "$pid" >/dev/null 2>&1; done
sleep 1

BIND_ADDR=127.0.0.1 PORT=18081 CATALOG_DATA_DIR="$RIG/rA" PAN_CARD_SEED="$SEEDA" \
  PAN_DELEGATE_SECRET=testsecret PAN_DELEGATE_PARTNER=testpartner PAN_REHOME_MAX_PER_HOUR=100000 PAN_SELF_URL="http://localhost:18081" \
  "$BIN" > "$RIG/rA.log" 2>&1 &
echo "registrar A (18081) pid $!"
BIND_ADDR=127.0.0.1 PORT=18082 CATALOG_DATA_DIR="$RIG/rB" PAN_CARD_SEED="$SEEDB" \
  PAN_DELEGATE_SECRET=testsecret PAN_DELEGATE_PARTNER=testpartner PAN_REHOME_MAX_PER_HOUR=100000 PAN_SELF_URL="http://localhost:18082" \
  "$BIN" > "$RIG/rB.log" 2>&1 &
echo "registrar B (18082) pid $!"

for url in http://localhost:18081/healthz http://localhost:18082/healthz; do
  for i in $(seq 1 60); do curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && { echo "up: $url"; break; }; sleep 2; done
done
