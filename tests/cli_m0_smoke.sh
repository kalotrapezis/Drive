#!/usr/bin/env bash
set -eu

cli=$1
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/source/Ελληνικά" "$root/destination"
printf 'verified\n' > "$root/source/Ελληνικά/file.txt"
: > "$root/source/empty"

catalog="$root/catalog.sqlite"
log="$root/transfer.log"

scan=$($cli --scan-max-items 10 --scan-max-bytes 1000 mtp-scan "file://$root/source" 2>&1)
grep -q 'SCAN completed files=2' <<<"$scan"

set +e
bounded=$($cli --catalog-file "$catalog" --staging-max-bytes 8 verified-preview "$root/source" "$root/destination" 2>&1)
bounded_status=$?
set -e
[[ $bounded_status -eq 1 ]]
grep -q 'Staging limit reached' <<<"$bounded"

preview=$($cli --catalog-file "$catalog" --log-file "$log" verified-preview "$root/source" "$root/destination" 2>&1)
grep -q 'PREVIEW ok=1 files=2' <<<"$preview"

copy=$($cli --catalog-file "$catalog" --log-file "$log" verified-copy "$root/source" "$root/destination" 2>&1)
grep -q 'INFO verified copy completed' <<<"$copy"
cmp "$root/source/Ελληνικά/file.txt" "$root/destination/Ελληνικά/file.txt"
cmp "$root/source/empty" "$root/destination/empty"

retry=$($cli --catalog-file "$catalog" --log-file "$log" verified-copy "$root/source" "$root/destination" 2>&1)
grep -q 'PREVIEW ok=1 files=2.*to_copy=0.*identical=2' <<<"$retry"
grep -q 'INFO verified copy completed' "$log"

printf 'PASS: CLI M0 preview, verified copy, Unicode/empty files, receipt retry\n'
