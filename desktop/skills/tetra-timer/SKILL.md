---
name: tetra-timer
description: Read, start, pause, resume or stop the user's timers, alarms and stopwatch in Tetra — each is a small JSON file in ~/Tetra/.System/Timer/Shared that syncs to their phone and tablet, where it counts down, rings or counts up. Use whenever the user asks to set a timer, start a countdown, remind them in N minutes, set, list, switch off or delete an alarm (wake me at 7, every weekday at 7:30), start, pause, read or reset the stopwatch, see what timers are running or how long is left, or pause, resume, stop or delete a timer.
---

# Tetra's timers, alarms and stopwatch

The user's timers are **files**: Tetra (their own app, on Android and the PC) counts each one down, rings it at the
end, and syncs the folder to their phone and tablet within seconds. You manage them by writing the files.

```
~/Tetra/.System/Timer/Shared/   (/sdcard/Tetra/.System/Timer/Shared on a phone)
  k3f9a2.24091RPADG.json               one file per timer per device: <id>.<device>.json
  k3f9a2.theologos-82xm.json           the same timer, changed on the computer
```

Tetra keeps it in its hidden system folder since 29 Oct 2026 (it was `~/Tetra/Files/Timer` before; `tetra_timer.py` still
finds that one on a computer whose Tetra has not moved it yet, so prefer the helper over hard-coded paths).

## Use the helper first

`tetra_timer.py` beside this file (standard library only) writes the file for you; you only give it the length, the
label or the timer. It prints the timers after every change. Run it with `python3`:

```bash
T=~/.claude/skills/tetra-timer/tetra_timer.py
python3 $T list                          # what is running, paused or pinned, and the time left
python3 $T start 10m --label Pasta       # 10m, 1h30m, 90s or 600; --pin keeps the card when it ends
python3 $T pause Pasta                   # by label or id; also: resume, stop, delete, again (a pinned one anew)
python3 $T alarms                        # the alarms, their days, and when each rings next
python3 $T alarm 07:30 --label Σχολείο --days MO,TU   # --days daily | weekdays | MO,WE,FR; none: once (the next 07:30, or --date)
python3 $T alarm-off 07:30               # by time, label or id; also: alarm-on, alarm-delete
python3 $T stopwatch start               # show (default), start, pause, lap, reset
```

Two timers with the same label: it lists their ids; use the id. Below is the format, for anything the helper does not
do.

A file:

```json
{"id":"k3f9a2","seconds":300,"label":"Tea","state":"running","ends":"2026-10-19T16:05:00Z","left":0,"rev":1,"by":"claude","pinned":false}
```

- `seconds`: the timer's length. `label`: its name on the card (may be empty).
- `state`: `running` (rings at `ends`, an ISO instant in UTC) · `paused` (`left` seconds remain, `ends` null) · `stopped`.
- `rev`: goes up by one at every change. **All the files with the same `id` are one timer; the one with the highest
  `rev` is it** (equal: stopped beats paused beats running).
- `pinned`: the card stays when the timer is stopped or done, ready to start again.
- Any number of timers (the limit of nine went on 30 Oct 2026; an older desktop Tetra still shows nine).

## Rules

- **Write only your own file**: `<id>.claude.json` with `"by":"claude"`. Never edit or delete another device's file;
  a higher `rev` in yours overrides it.
- Write beside, then rename, so a sync never reads half a file:
  `printf '%s\n' "$JSON" > ~/Tetra/.System/Timer/Shared/.k3f9a2.claude.json.part && mv ~/Tetra/.System/Timer/Shared/.k3f9a2.claude.json.part ~/Tetra/.System/Timer/Shared/k3f9a2.claude.json`
- Times in `ends` are UTC with a `Z`: `date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ`. Never work them out by hand.

## Doing things by hand

**What is running**: read every `*.json`, group by `id`, keep the highest `rev`. Time left of a running one =
`ends` − now; a paused one has `left` seconds. A `running` timer more than 10 minutes past `ends` is over.

```bash
python3 - <<'EOF'
import json, glob, os, datetime as d
now = d.datetime.now(d.timezone.utc); best = {}
for f in glob.glob(os.path.expanduser('~/Tetra/.System/Timer/Shared/*.json')):
    try: t = json.load(open(f))
    except Exception: continue
    t.setdefault('id', os.path.basename(f).split('.')[0])
    o = ['running', 'paused', 'stopped']
    if t['id'] not in best or (t.get('rev', 0), o.index(t.get('state', 'running'))) > (best[t['id']].get('rev', 0), o.index(best[t['id']].get('state', 'running'))): best[t['id']] = t
for t in best.values():
    left = (d.datetime.fromisoformat(t['ends'].replace('Z', '+00:00')) - now).total_seconds() if t.get('ends') else t.get('left', 0)
    print(t['id'], t.get('label', ''), t['state'], f"{t['seconds']} s long", f"{max(left, 0):.0f} s left", 'rev', t.get('rev', 0), 'pinned' if t.get('pinned') else '')
EOF
```

**Start one** (10 minutes, "Pasta"): a new 6-letter id (`head -c3 /dev/urandom | xxd -p`), `rev` 1:

```json
{"id":"a1b2c3","seconds":600,"label":"Pasta","state":"running","ends":"<now + 600 s, UTC>","left":0,"rev":1,"by":"claude","pinned":false}
```

**Change one**: take the winning record, change it, set `rev` to the highest `rev` among its files + 1, `"by":"claude"`,
and write `<id>.claude.json`:
- Pause: `"state":"paused"`, `"left":` the seconds left now, `"ends":null`.
- Resume: `"state":"running"`, `"ends":` now + `left`, `"left":0`.
- Stop (also "OK" on a ringing one): `"state":"stopped"`, `"ends":null`, `"left":0`.
- Delete the card: as Stop, and `"pinned":false`.
- Start a pinned one again: `"state":"running"`, `"ends":` now + `seconds`.

Every device picks up the change within seconds (or at its next 30-second look). After writing, read the folder again
with the listing above and tell the user what is running now.

## Alarms and the stopwatch

They live in the same folder by the same rules (one file per item per device, `<id>.claude.json` for yours, the highest
`rev` wins, write beside then rename). A `kind` tells them from timers, and their `state` words are not a timer's, so
older readers skip them.

An alarm, `alarm-<6 hex>.<device>.json`:

```json
{"kind":"alarm","id":"alarm-k3f9a2","time":"07:30","days":["MO","TU"],"date":null,"label":"Σχολείο","state":"on","answered":"2026-10-29T20:00:00Z","snooze":null,"rev":1,"by":"claude"}
```

- `time`: local `HH:MM`; each device rings it in its own time zone.
- `days`: the weekdays it repeats on (`MO TU WE TH FR SA SU`, as iCalendar's). Empty: **once**, on `date` (local
  `YYYY-MM-DD`; null: the next `time` to come). A single alarm turns `off` once it has rung and been answered.
- `state`: `on` · `off` · `deleted` (equal `rev`: deleted beats off beats on). A deleted alarm's file is used for the
  next new one (its `rev` + 1).
- `answered`: the instant of the last ring stopped — Dismiss, Snooze or Skip, on any device. A ring at or before it does
  not sound; a new or switched-on alarm sets it to now, so nothing from before rings. `snooze`: one more ring at that
  instant (Snooze: the ring answered, `snooze` = now + 10 min).
- **Skip next** (a repeating alarm): `answered` = the next ring's instant, so it is later than now; the ones after ring
  as ever. Undo: switch it on again (`answered` = now). **Snooze before it rings** (the phone's notice 30 minutes
  ahead): `answered` = the next ring, `snooze` = that ring + 10 min.
- A ring nobody answers sounds for 10 minutes, then stops.
- Every device rings it; Dismiss on one stops it on all (as a timer's OK).

The stopwatch, one for all the devices, `stopwatch.<device>.json`:

```json
{"kind":"stopwatch","id":"stopwatch","state":"counting","started":"2026-10-29T16:00:00Z","elapsed":0,"laps":[62.4],"rev":3,"by":"claude"}
```

- `state`: `counting` (time = now − `started`, the moment it would have started had it never paused) · `held` (`elapsed`
  seconds) · `reset` (zero, no laps). Equal `rev`: reset beats held beats counting.
- Start from held: `started` = now − `elapsed`. Pause: `elapsed` = now − `started`, `started` null. Lap: the time now
  appended to `laps` (seconds since the start, not the split).

