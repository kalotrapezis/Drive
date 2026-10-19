---
name: tetra-timer
description: Read, start, pause, resume or stop the user's timers in Tetra — each timer is a small JSON file in ~/Tetra/Files/Timer that syncs to their phone and tablet, where it counts down and rings. Use whenever the user asks to set a timer, start a countdown, remind them in N minutes, see what timers are running or how long is left, or pause, resume, stop or delete a timer.
---

# Tetra's timers

The user's timers are **files**: Tetra (their own app, on Android and the PC) counts each one down, rings it at the
end, and syncs the folder to their phone and tablet within seconds. You manage them by writing the files.

```
~/Tetra/Files/Timer/                   (/sdcard/Tetra/Timer on a phone)
  k3f9a2.24091RPADG.json               one file per timer per device: <id>.<device>.json
  k3f9a2.theologos-82xm.json           the same timer, changed on the computer
```

A file:

```json
{"id":"k3f9a2","seconds":300,"label":"Tea","state":"running","ends":"2026-10-19T16:05:00Z","left":0,"rev":1,"by":"claude","pinned":false}
```

- `seconds`: the timer's length. `label`: its name on the card (may be empty).
- `state`: `running` (rings at `ends`, an ISO instant in UTC) · `paused` (`left` seconds remain, `ends` null) · `stopped`.
- `rev`: goes up by one at every change. **All the files with the same `id` are one timer; the one with the highest
  `rev` is it** (equal: stopped beats paused beats running).
- `pinned`: the card stays when the timer is stopped or done, ready to start again.
- Nine timers on screen at most (running, paused, ringing or pinned).

## Rules

- **Write only your own file**: `<id>.claude.json` with `"by":"claude"`. Never edit or delete another device's file;
  a higher `rev` in yours overrides it.
- Write beside, then rename, so a sync never reads half a file:
  `printf '%s\n' "$JSON" > ~/Tetra/Files/Timer/.k3f9a2.claude.json.part && mv ~/Tetra/Files/Timer/.k3f9a2.claude.json.part ~/Tetra/Files/Timer/k3f9a2.claude.json`
- Times in `ends` are UTC with a `Z`: `date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ`. Never work them out by hand.

## Doing things

**What is running**: read every `*.json`, group by `id`, keep the highest `rev`. Time left of a running one =
`ends` − now; a paused one has `left` seconds. A `running` timer more than 10 minutes past `ends` is over.

```bash
python3 - <<'EOF'
import json, glob, os, datetime as d
now = d.datetime.now(d.timezone.utc); best = {}
for f in glob.glob(os.path.expanduser('~/Tetra/Files/Timer/*.json')):
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
