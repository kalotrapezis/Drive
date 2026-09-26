#!/usr/bin/env bash
set -eu

controller=$1
sender=$2
root=$(mktemp -d)
mkdir -p "$root/destination" "$root/source"
trap 'kill "$receiver" 2>/dev/null || true' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/server.key" -out "$root/server.crt" -subj /CN=localhost -days 1 >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/client.key" -out "$root/client.crt" -subj /CN=local-drive-client -days 1 >/dev/null 2>&1
printf '%s\n' 'desktop controller wireless payload ελληνικά' > "$root/source/controller.txt"
fingerprint=$(openssl x509 -in "$root/client.crt" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')

$controller "$root/catalog.sqlite" "$root/destination" "$root/server.crt" "$root/server.key" "$root/client.crt" "$fingerprint" > "$root/controller.log" 2>&1 &
receiver=$!
for attempt in $(seq 1 60); do
    grep -q 'LISTENING port=43273' "$root/controller.log" && break
    sleep 0.1
done
grep -q 'LISTENING port=43273' "$root/controller.log"
$sender wireless-send "$root/source/controller.txt" localhost 43273 "$root/client.crt" "$root/client.key" "$root/server.crt" wireless:controller-phone 'Controller phone' Drive/controller.txt > "$root/sender.log" 2>&1
wait "$receiver"
cmp "$root/source/controller.txt" "$root/destination/Drive/controller.txt"
grep -q 'RECEIPT Drive/controller.txt' "$root/controller.log"
printf 'PASS: desktop wireless receiver controller and VerifiedCopy finalization\n'
