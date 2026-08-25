#!/usr/bin/env bash
set -eu

cli=$1
root=$(mktemp -d)
mkdir -p "$root/source" "$root/destination"
trap 'kill "$receiver" 2>/dev/null || true' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/server.key" -out "$root/server.crt" -subj /CN=localhost -days 1 >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/client.key" -out "$root/client.crt" -subj /CN=local-drive-client -days 1 >/dev/null 2>&1
printf '%s\n' 'wireless mTLS payload ελληνικά' > "$root/source/photo.txt"
fingerprint=$(openssl x509 -in "$root/client.crt" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')

catalog="$root/catalog.sqlite"
$cli --catalog-file "$catalog" wireless-receive "$root/destination" "$root/server.crt" "$root/server.key" "$root/client.crt" "$fingerprint" 43271 > "$root/receiver.log" 2>&1 &
receiver=$!
for attempt in $(seq 1 40); do
    grep -q 'listening port=43271' "$root/receiver.log" && break
    sleep 0.1
done

$cli wireless-send "$root/source/photo.txt" localhost 43271 "$root/client.crt" "$root/client.key" "$root/server.crt" wireless:test-phone 'Test phone' > "$root/sender.log" 2>&1
wait "$receiver"
cmp "$root/source/photo.txt" "$root/destination/photo.txt"
grep -q 'RECEIPT wireless path=photo.txt' "$root/receiver.log"
grep -q 'INFO wireless send completed path=photo.txt' "$root/sender.log"

$cli --catalog-file "$catalog" wireless-receive "$root/destination" "$root/server.crt" "$root/server.key" "$root/client.crt" "$fingerprint" 43272 > "$root/receiver-repeat.log" 2>&1 &
receiver=$!
for attempt in $(seq 1 40); do
    grep -q 'listening port=43272' "$root/receiver-repeat.log" && break
    sleep 0.1
done
$cli wireless-send "$root/source/photo.txt" localhost 43272 "$root/client.crt" "$root/client.key" "$root/server.crt" wireless:test-phone 'Test phone' > "$root/sender-repeat.log" 2>&1
wait "$receiver"
cmp "$root/source/photo.txt" "$root/destination/photo.txt"
python3 - "$catalog" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
assert db.execute("select count(*) from locations where state='verified'").fetchone()[0] == 1
assert db.execute("select count(*) from history where event='verified'").fetchone()[0] == 2
assert db.execute("select source_sha256=destination_sha256 from locations where state='verified'").fetchone()[0] == 1
PY

printf 'PASS: mutual-TLS wireless sender/receiver, receipt, and catalog verification\n'
