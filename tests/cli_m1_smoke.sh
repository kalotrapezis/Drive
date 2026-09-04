#!/usr/bin/env bash
set -eu

cli=$1
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/source" "$root/destination"
printf 'MTP verified ελληνικά\n' > "$root/source/Ελληνικά.txt"

catalog="$root/catalog.sqlite"
source_url="file://$root/source/Ελληνικά.txt"
first=$($cli --catalog-file "$catalog" verified-import "$source_url" "$root/destination" 2>&1)
grep -q 'INFO verified MTP import completed' <<<"$first"
grep -q 'PROGRESS bytes=' <<<"$first"
cmp "$root/source/Ελληνικά.txt" "$root/destination/Ελληνικά.txt"

mkdir -p "$root/export-phone"
exported=$($cli --catalog-file "$root/export.sqlite" verified-export "$root/source/Ελληνικά.txt" "file://$root/export-phone/from-laptop.txt" 2>&1)
grep -q 'RECEIPT verified MTP export path=from-laptop.txt' <<<"$exported"
cmp "$root/source/Ελληνικά.txt" "$root/export-phone/from-laptop.txt"
reexported=$($cli --catalog-file "$root/export.sqlite" verified-export "$root/source/Ελληνικά.txt" "file://$root/export-phone/from-laptop.txt" 2>&1)
grep -q 'RECEIPT verified MTP export path=from-laptop.txt' <<<"$reexported"
python3 - "$root/export.sqlite" <<'PY'
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("select count(*) from storage where kind='mtp'").fetchone()[0] == 1
assert db.execute("select count(*) from locations where state='verified'").fetchone()[0] == 1
assert db.execute("select count(*) from history where event='verified'").fetchone()[0] == 1
PY
printf 'different\n' > "$root/source/different.txt"
set +e
export_conflict=$($cli --catalog-file "$root/export-conflict.sqlite" verified-export "$root/source/different.txt" "file://$root/export-phone/from-laptop.txt" 2>&1)
status=$?
set -e
[[ $status -eq 2 ]]
grep -q 'ERROR Destination differs' <<<"$export_conflict"
cmp "$root/source/Ελληνικά.txt" "$root/export-phone/from-laptop.txt"

mkdir -p "$root/wireless-destination"
beacon=$($cli wireless-beacon "wireless:sim-phone" "Simulated phone" "127.0.0.1:43171" 2>&1)
grep -q 'INFO wireless beacon sent' <<<"$beacon"
wireless=$($cli --catalog-file "$root/wireless.sqlite" wireless-simulate "$source_url" "$root/wireless-destination" 2>&1)
grep -q 'INFO verified wireless simulation import completed' <<<"$wireless"
grep -q 'PROGRESS bytes=' <<<"$wireless"
cmp "$root/source/Ελληνικά.txt" "$root/wireless-destination/Ελληνικά.txt"
python3 - "$root/wireless.sqlite" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
assert db.execute("select count(*) from devices where is_local=0").fetchone()[0] == 1
assert db.execute("select count(*) from device_aliases where transport='wireless'").fetchone()[0] == 1
assert db.execute("select count(*) from locations where state='verified'").fetchone()[0] == 1
PY

second=$($cli --catalog-file "$catalog" verified-import "$source_url" "$root/destination" 2>&1)
grep -q 'INFO verified MTP import completed' <<<"$second"
cmp "$root/source/Ελληνικά.txt" "$root/destination/Ελληνικά.txt"

python3 - "$catalog" "$source_url" <<'PY'
import sqlite3
import sys

catalog, source_url = sys.argv[1:]
db = sqlite3.connect(catalog)
assert db.execute("select count(*) from jobs").fetchone()[0] == 1
assert db.execute("select count(*) from job_items where state='Complete'").fetchone()[0] == 1
assert db.execute("select count(*) from locations where state='verified'").fetchone()[0] == 1
assert db.execute("select count(*) from history where event='verified'").fetchone()[0] == 1
assert db.execute("select count(*) from storage where kind='mtp'").fetchone()[0] == 1
assert db.execute("select source_path from job_items").fetchone()[0] == source_url
PY

mkdir -p "$root/conflict-source" "$root/conflict-destination"
printf 'new\n' > "$root/conflict-source/file.txt"
printf 'old\n' > "$root/conflict-destination/file.txt"
set +e
conflict=$($cli --catalog-file "$root/conflict.sqlite" verified-import "file://$root/conflict-source/file.txt" "$root/conflict-destination" 2>&1)
status=$?
set -e
[[ $status -eq 2 ]]
grep -q 'ERROR Destination differs' <<<"$conflict"
grep -q '^old$' "$root/conflict-destination/file.txt"

mkdir -p "$root/batch-source/Ελληνικά/φωτο" "$root/batch-destination"
printf 'one\n' > "$root/batch-source/Ελληνικά/a.txt"
printf 'two\n' > "$root/batch-source/Ελληνικά/φωτο/b.txt"
batch=$($cli --catalog-file "$root/batch.sqlite" --scan-max-items 10 --scan-max-bytes 1000 verified-import-dir "file://$root/batch-source" "$root/batch-destination" 2>&1)
grep -q 'PREVIEW verified-import-dir files=2 bytes=8' <<<"$batch"
grep -q 'INFO verified MTP directory import completed files=2 bytes=8' <<<"$batch"
cmp "$root/batch-source/Ελληνικά/a.txt" "$root/batch-destination/Ελληνικά/a.txt"
cmp "$root/batch-source/Ελληνικά/φωτο/b.txt" "$root/batch-destination/Ελληνικά/φωτο/b.txt"
python3 - "$root/batch.sqlite" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
assert db.execute("select count(*) from jobs").fetchone()[0] == 2
assert db.execute("select count(*) from job_items where state='Complete'").fetchone()[0] == 2
assert db.execute("select count(*) from locations where state='verified'").fetchone()[0] == 2
assert db.execute("select count(*) from devices where is_local=0").fetchone()[0] == 1
assert db.execute("select count(*) from storage where kind='mtp'").fetchone()[0] == 1
PY

mkdir -p "$root/bounded-destination"
set +e
bounded=$($cli --catalog-file "$root/bounded.sqlite" --scan-max-items 1 --scan-max-bytes 1000 verified-import-dir "file://$root/batch-source" "$root/bounded-destination" 2>&1)
status=$?
set -e
[[ $status -eq 2 ]]
grep -q 'ERROR scan bounds exceeded' <<<"$bounded"
[[ -z "$(find "$root/bounded-destination" -type f -print -quit)" ]]

mkdir -p "$root/staging" "$root/drained"
staged=$($cli --catalog-file "$root/staging.sqlite" --scan-max-items 10 --scan-max-bytes 1000 --staging-max-bytes 8 verified-stage-dir "file://$root/batch-source" "$root/staging" 2>&1)
grep -q 'PREVIEW verified-stage-dir files=2 bytes=8' <<<"$staged"
grep -q 'INFO staging occupancy used=0 incoming=8 cap=8' <<<"$staged"
grep -q 'INFO verified MTP staging completed files=2 bytes=8' <<<"$staged"
cmp "$root/batch-source/Ελληνικά/a.txt" "$root/staging/Ελληνικά/a.txt"
cmp "$root/batch-source/Ελληνικά/φωτο/b.txt" "$root/staging/Ελληνικά/φωτο/b.txt"

repeat=$($cli --catalog-file "$root/staging.sqlite" --scan-max-items 10 --scan-max-bytes 1000 --staging-max-bytes 8 verified-stage-dir "file://$root/batch-source" "$root/staging" 2>&1)
grep -q 'INFO staging occupancy used=8 incoming=0 cap=8' <<<"$repeat"

drain=$($cli --catalog-file "$root/drain.sqlite" verified-copy "$root/staging" "$root/drained" 2>&1)
grep -q 'INFO verified copy completed' <<<"$drain"
cmp "$root/staging/Ελληνικά/a.txt" "$root/drained/Ελληνικά/a.txt"
cmp "$root/staging/Ελληνικά/φωτο/b.txt" "$root/drained/Ελληνικά/φωτο/b.txt"

mkdir -p "$root/tiny-staging"
set +e
tiny=$($cli --catalog-file "$root/tiny.sqlite" --scan-max-items 10 --scan-max-bytes 1000 --staging-max-bytes 7 verified-stage-dir "file://$root/batch-source" "$root/tiny-staging" 2>&1)
status=$?
set -e
[[ $status -eq 2 ]]
grep -q 'ERROR Staging capacity reached' <<<"$tiny"
[[ -z "$(find "$root/tiny-staging" -type f -print -quit)" ]]

printf 'PASS: M1 verified MTP import, SQLite receipt/idempotence, Unicode and conflict safety\n'
