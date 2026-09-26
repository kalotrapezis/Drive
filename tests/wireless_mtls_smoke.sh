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
server_fingerprint=$(openssl x509 -in "$root/server.crt" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')

$cli wireless-profile-export "$root/server-profile.json" localhost 43271 "$root/server.crt" "$server_fingerprint" > "$root/profile-export.log" 2>&1
python3 - "$root/server-profile.json" "$root/client.crt" "$fingerprint" "$root/android-pairing.json" <<'PY'
import json
import sys

profile = json.load(open(sys.argv[1]))
assert profile["protocol"] == 1
assert profile["serverFingerprint"]
certificate = open(sys.argv[2]).read()
json.dump({
    "protocol": 1,
    "deviceId": "wireless:test-phone",
    "deviceName": "Test phone",
    "clientCertificatePem": certificate,
    "clientFingerprint": sys.argv[3].lower(),
}, open(sys.argv[4], "w"))
PY
$cli wireless-profile-accept "$root/android-pairing.json" "$root/imported-client.crt" > "$root/profile-accept.log" 2>&1
imported_fingerprint=$(openssl x509 -in "$root/imported-client.crt" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')
test "$imported_fingerprint" = "$fingerprint"

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

wrong_fingerprint=$(printf '%064d' 0)
$cli --catalog-file "$root/rejected-catalog.sqlite" wireless-receive "$root/destination" "$root/server.crt" "$root/server.key" "$root/client.crt" "$wrong_fingerprint" 43270 > "$root/rejected-receiver.log" 2>&1 &
receiver=$!
for attempt in $(seq 1 40); do
    grep -q 'listening port=43270' "$root/rejected-receiver.log" && break
    sleep 0.1
done
set +e
$cli wireless-send "$root/source/photo.txt" localhost 43270 "$root/client.crt" "$root/client.key" "$root/server.crt" wireless:test-phone 'Test phone' > "$root/rejected-sender.log" 2>&1
sender_status=$?
set -e
test "$sender_status" -ne 0
kill "$receiver" 2>/dev/null || true
wait "$receiver" 2>/dev/null || true
! grep -q 'RECEIPT wireless path=' "$root/rejected-receiver.log"

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

printf '%s\n' 'wireless photos root payload ελληνικά' > "$root/source/video.mp4"
$cli --catalog-file "$catalog" wireless-receive "$root/destination" "$root/server.crt" "$root/server.key" "$root/client.crt" "$fingerprint" 43274 > "$root/receiver-photos.log" 2>&1 &
receiver=$!
for attempt in $(seq 1 40); do
    grep -q 'listening port=43274' "$root/receiver-photos.log" && break
    sleep 0.1
done
$cli wireless-send "$root/source/video.mp4" localhost 43274 "$root/client.crt" "$root/client.key" "$root/server.crt" wireless:test-phone 'Test phone' Photos/video.mp4 > "$root/sender-photos.log" 2>&1
wait "$receiver"
cmp "$root/source/video.mp4" "$root/destination/Photos/video.mp4"
grep -q 'RECEIPT wireless path=Photos/video.mp4' "$root/receiver-photos.log"

printf 'PASS: mutual-TLS wireless sender/receiver, receipt, and catalog verification\n'
