#!/bin/bash
# Two NATS meshes (instances) peered by a gateway — the concrete "second
# instance" the §21 acceptance criterion demands. Mesh A: ws 14461. Mesh B:
# ws 14462. A gateway link routes cross-instance interest, so a request
# published on A to an agent whose interest lives on B crosses the boundary and
# the reply routes back. No auth on the rig (localhost only); the point under
# test is carrier-independent envelope verification across a real boundary, not
# transport auth (that is t01/t03).
set -uo pipefail
RIG="${RIG:-$HOME/AppData/Local/Temp/claude/rig}"
NS="$(find "$HOME/AppData/Local/Temp/claude/nats-restore/bin" -name nats-server.exe | head -1)"
mkdir -p "$RIG/mA" "$RIG/mB"

# Both rig servers state max_payload explicitly (1 MiB, nats-server's own
# default) for the same reason the shipped configs do: the rig should refuse the
# same sizes production refuses, so a size-related failure shows up here rather
# than only after deploy. Same value as the default, so nothing the peering tests
# send changes behaviour.
cat > "$RIG/meshA.conf" <<EOF
server_name: meshA
host: 127.0.0.1
port: 14421
max_payload: 1048576
http: 127.0.0.1:18461
websocket { listen: "127.0.0.1:14461", no_tls: true }
gateway {
  name: "A"
  listen: "127.0.0.1:17421"
  gateways: [ { name: "B", urls: ["nats://localhost:17422"] } ]
}
EOF

cat > "$RIG/meshB.conf" <<EOF
server_name: meshB
host: 127.0.0.1
port: 14422
max_payload: 1048576
http: 127.0.0.1:18462
websocket { listen: "127.0.0.1:14462", no_tls: true }
gateway {
  name: "B"
  listen: "127.0.0.1:17422"
  gateways: [ { name: "A", urls: ["nats://localhost:17421"] } ]
}
EOF

# Stop any prior rig servers. This has to match on the COMMAND LINE, not on
# `ps -W` output: ps shows the executable path, the nats-server binary lives
# outside $RIG (under nats-restore/), and only its -c argument names the rig
# config. Matching ps output against "$RIG" therefore never matched anything,
# and stale servers accumulated across sessions — still bound, still holding
# the ports, invisible to this script. (Found 2026-07-24: a leftover server was
# still listening on all interfaces while the current one was loopback-only.)
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='nats-server.exe'\" | Where-Object { \$_.CommandLine -like '*rig/mesh*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
sleep 2
"$NS" -c "$RIG/meshA.conf" > "$RIG/meshA.log" 2>&1 & echo "mesh A (ws 14461) pid $!"
"$NS" -c "$RIG/meshB.conf" > "$RIG/meshB.log" 2>&1 & echo "mesh B (ws 14462) pid $!"
sleep 3
# confirm the gateway link formed (each server reports the other as an outbound gateway)
for s in 18461 18462; do
  n=$(curl -s "http://localhost:$s/gatewayz" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(Object.keys(j.outbound_gateways||{}).length)}catch{console.log('0')}})")
  echo "server $s outbound gateways: $n"
done
