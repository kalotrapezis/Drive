#!/usr/bin/env bash
set -eu

cli=$1
root=$(mktemp -d)
trap 'kill "$discoverer" 2>/dev/null || true; rm -rf -- "$root"' EXIT

"$cli" wireless-discover 3 > "$root/discovery.log" 2>&1 &
discoverer=$!
sleep 0.3
"$cli" wireless-beacon wireless:cli-smoke "CLI smoke phone" 127.0.0.1:43171 >/dev/null
"$cli" wireless-beacon wireless:cli-smoke "CLI smoke phone" 127.0.0.1:43171 >/dev/null
wait "$discoverer"

test "$(grep -c 'DEVICE ONLINE identity=wireless:cli-smoke' "$root/discovery.log")" -eq 1
grep -q 'INFO wireless discovery listening port=43170' "$root/discovery.log"
grep -q 'INFO wireless discovery stopped' "$root/discovery.log"
printf 'PASS: CLI wireless discovery receives and deduplicates beacons\n'
