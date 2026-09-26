#!/usr/bin/env bash
set -eu

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

src="$root/source"
dst="$root/destination"
mkdir -p "$src" "$dst"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
hash() { sha256sum -- "$1" | awk '{print $1}'; }

check_conflicts() {
    local source_path relative destination_path
    while IFS= read -r -d '' source_path; do
        relative=${source_path#"$src"/}
        destination_path="$dst/$relative"
        if [[ -e "$destination_path" || -L "$destination_path" ]]; then
            [[ -f "$destination_path" ]] || return 1
            [[ $(hash "$source_path") == $(hash "$destination_path") ]] || return 1
        fi
    done < <(find "$src" -type f -print0)
}

printf 'rsync: %s\n' "$(rsync --version | head -n 1)"

printf 'ordinary copy and hash verification... '
printf 'hello from Drive\n' > "$src/ordinary.txt"
printf 'Ελληνικά — φωτογραφίες\n' > "$src/Ελληνικά όνομα.txt"
: > "$src/empty file.txt"
rsync --archive --protect-args "$src/" "$dst/"
while IFS= read -r -d '' source_path; do
    relative=${source_path#"$src"/}
    destination_path="$dst/$relative"
    [[ -f "$destination_path" ]] || fail "missing copied file: $relative"
    [[ $(hash "$source_path") == $(hash "$destination_path") ]] || fail "hash mismatch: $relative"
done < <(find "$src" -type f -print0)
[[ -f "$src/ordinary.txt" ]] || fail 'source was removed'
printf 'PASS\n'

printf 'identical rerun is idempotent... '
rerun=$(rsync --archive --protect-args --itemize-changes "$src/" "$dst/")
[[ -z "$rerun" ]] || fail "rerun changed files: $rerun"
printf 'PASS\n'

printf 'conflict is detected before transfer... '
conflict_src="$root/conflict-source"
conflict_dst="$root/conflict-destination"
mkdir -p "$conflict_src" "$conflict_dst"
printf 'new content\n' > "$conflict_src/same.txt"
printf 'old content\n' > "$conflict_dst/same.txt"
old_hash=$(hash "$conflict_dst/same.txt")
if (src="$conflict_src" dst="$conflict_dst"; check_conflicts); then
    fail 'different-content conflict was not detected'
fi
[[ $(hash "$conflict_dst/same.txt") == "$old_hash" ]] || fail 'conflict file changed'
printf 'PASS\n'

printf 'interrupted transfer keeps source and publishes no final file... '
interrupt_src="$root/interrupt-source"
interrupt_dst="$root/interrupt-destination"
mkdir -p "$interrupt_src" "$interrupt_dst"
dd if=/dev/zero of="$interrupt_src/large.bin" bs=1M count=5 status=none
source_hash=$(hash "$interrupt_src/large.bin")
if timeout 1s rsync --archive --partial --partial-dir=.rsync-partial --bwlimit=10 \
    "$interrupt_src/" "$interrupt_dst/"; then
    fail 'large transfer unexpectedly completed'
fi
[[ $(hash "$interrupt_src/large.bin") == "$source_hash" ]] || fail 'source changed after interruption'
[[ ! -e "$interrupt_dst/large.bin" ]] || fail 'final file was published after interruption'
printf 'PASS\n'

printf 'PASS: copy, Unicode/empty files, idempotence, conflict safety, interruption safety\n'
