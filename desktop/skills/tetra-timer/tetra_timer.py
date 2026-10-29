#!/usr/bin/env python3
"""Tetra's timers from the command line (standard library only).

Each timer is a JSON file per device in ~/Tetra/.System/Timer/Shared (~/Tetra/Files/Timer before 29 Oct 2026) (<id>.<device>.json); the highest rev wins.
    tetra_timer.py list                                 the timers now: id, label, state, time left
    tetra_timer.py start 10m [--label Pasta] [--pin]    a new running timer (10m, 1h30m, 90s or plain seconds)
    tetra_timer.py pause|resume|stop|delete|again WHO   WHO = a timer's id or its label (again: start a pinned one anew)
    tetra_timer.py alarms                               the alarms: id, time, days, label, on/off, when it rings next
    tetra_timer.py alarm 07:30 [--label Σχολείο] [--days MO,TU|daily|weekdays] [--date 2026-10-30]
                                                        a new alarm (no --days: once, the next 07:30 or on --date)
    tetra_timer.py alarm-on|alarm-off|alarm-delete WHO  WHO = an alarm's id, label or time (07:30)
    tetra_timer.py stopwatch [show|start|pause|lap|reset]  the one stopwatch every device shares
--root DIR (or TETRA_TIMER) points elsewhere. Only <id>.claude.json is ever written.
"""
import argparse, datetime as dt, glob, json, os, re, secrets, sys


def default_root(app):
    """Tetra's .System/<app>/Shared (since 29 Oct 2026); Files/<app> on a computer whose Tetra has not moved it there yet."""
    new, old = os.path.expanduser(f"~/Tetra/.System/{app}/Shared"), os.path.expanduser(f"~/Tetra/Files/{app}")
    return new if os.path.isdir(new) or not os.path.isdir(old) else old

ROOT = os.environ.get("TETRA_TIMER", default_root("Timer"))
ORDER = ["running", "paused", "stopped"]  # equal rev: stopped beats paused beats running


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def instant(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def seconds(text):
    if text.isdigit():
        return int(text)
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", text)
    if not m or not any(m.groups()):
        sys.exit(f"Not a length: {text} (say 10m, 1h30m, 90s or 600).")
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s


def timers(root):
    """Every timer once: the winning record of its files, and the highest rev among them."""
    best, top = {}, {}
    for f in glob.glob(os.path.join(root, "*.json")):
        try:
            t = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if t.get("kind", "timer") != "timer":  # an alarm or the stopwatch
            continue
        t.setdefault("id", os.path.basename(f).split(".")[0])
        key = (t.get("rev", 0), ORDER.index(t.get("state", "running")) if t.get("state") in ORDER else 0)
        i = t["id"]
        top[i] = max(top.get(i, 0), t.get("rev", 0))
        if i not in best or key > best[i][0]:
            best[i] = (key, t)
    return [(t, top[i]) for i, (_, t) in best.items()]


def left(t):
    if t.get("state") == "running" and t.get("ends"):
        return max(0, int((instant(t["ends"]) - now()).total_seconds()))
    return t.get("left", 0) if t.get("state") == "paused" else 0


DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
ALARM_ORDER = ["on", "off", "deleted"]  # equal rev: deleted, then off, wins
WATCH_ORDER = ["counting", "held", "reset"]  # equal rev: reset, then held, wins


def records(root, kind, order):
    """Every alarm (or the stopwatch) once: the winning record of its files, and the highest rev among them."""
    best, top = {}, {}
    for f in glob.glob(os.path.join(root, "*.json")):
        try:
            t = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if t.get("kind") != kind or t.get("state") not in order:
            continue
        i = t.setdefault("id", os.path.basename(f).split(".")[0])
        top[i] = max(top.get(i, 0), t.get("rev", 0))
        key = (t.get("rev", 0), order.index(t["state"]))
        if i not in best or key > best[i][0]:
            best[i] = (key, t)
    return [(t, top[i]) for i, (_, t) in best.items()]


def local(t):
    return t.astimezone()  # the computer's own zone, as each device rings in its own


def next_ring(a, after):
    """When the alarm rings next after `after` (aware), by its time, days, date and snooze; None when off or past."""
    if a.get("state") != "on":
        return None
    h, m = (int(x) for x in a["time"].split(":"))
    ans = instant(a["answered"]) if a.get("answered") else None
    after = max(after, ans) if ans else after
    days, start = a.get("days") or [], local(after)
    if not days and a.get("date"):
        cands = [dt.datetime.fromisoformat(a["date"]).replace(hour=h, minute=m).astimezone()]
    else:
        cands = [(start + dt.timedelta(days=k)).replace(hour=h, minute=m, second=0, microsecond=0) for k in range(9)]
        cands = [c for c in cands if not days or DAYS[c.weekday()] in days]
    if a.get("snooze"):
        cands.append(instant(a["snooze"]))
    cands = [c for c in cands if c > after]
    return min(cands) if cands else None


def pick_alarm(root, who):
    rows = [(t, r) for t, r in records(root, "alarm", ALARM_ORDER) if t["state"] != "deleted"]
    found = [(t, r) for t, r in rows if t["id"] == who] or [(t, r) for t, r in rows if t.get("time") == who.zfill(5)] or \
            [(t, r) for t, r in rows if who.lower() in t.get("label", "").lower()]
    if len(found) != 1:
        sys.exit(f"No alarm {who}." if not found else f"{len(found)} alarms match {who}: " + ", ".join(t["id"] for t, _ in found))
    return found[0]


def show_alarms(root):
    rows = sorted((t for t, _ in records(root, "alarm", ALARM_ORDER) if t["state"] != "deleted"), key=lambda t: t["time"])
    for t in rows:
        n = next_ring(t, now())
        days = "every day" if len(t.get("days") or []) == 7 else ",".join(t.get("days") or []) or ("once " + (t.get("date") or ""))
        print(f"{t['id']}  {t['time']}  {days}  {t.get('label') or '(no label)'}  " + (f"next {local(n):%a %Y-%m-%d %H:%M}" if n else "off"))
    if not rows:
        print("No alarms.")


def stopwatch(root):
    rows = records(root, "stopwatch", WATCH_ORDER)
    return rows[0] if rows else ({"kind": "stopwatch", "id": "stopwatch", "state": "reset", "started": None, "elapsed": 0, "laps": [], "rev": 0}, 0)


def elapsed(w):
    if w["state"] == "counting" and w.get("started"):
        return max(0.0, (now() - instant(w["started"])).total_seconds())
    return float(w.get("elapsed", 0)) if w["state"] == "held" else 0.0


def write(root, t):
    t["by"] = "claude"
    os.makedirs(root, exist_ok=True)
    part, final = os.path.join(root, f".{t['id']}.claude.json.part"), os.path.join(root, f"{t['id']}.claude.json")
    with open(part, "w", encoding="utf-8") as f:  # beside, then rename: a sync never reads half a file
        json.dump(t, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(part, final)


def pick(root, who):
    found = [(t, r) for t, r in timers(root) if t["id"] == who] or \
            [(t, r) for t, r in timers(root) if who.lower() in t.get("label", "").lower()]
    if len(found) != 1:
        sys.exit(f"No timer {who}." if not found else f"{len(found)} timers match {who}: " + ", ".join(t["id"] for t, _ in found))
    return found[0]


def show(root):
    rows = [(t, r) for t, r in timers(root) if t.get("state") != "stopped" or t.get("pinned")]
    for t, _ in rows:
        over = t.get("state") == "running" and t.get("ends") and (now() - instant(t["ends"])).total_seconds() > 600
        state = "over" if over else ("ringing" if t.get("state") == "running" and not left(t) else t.get("state"))
        print(f"{t['id']}  {t.get('label') or '(no label)'}  {state}  {t['seconds']} s long  {left(t)} s left" + ("  pinned" if t.get("pinned") else ""))
    if not rows:
        print("No timers.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=ROOT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    s = sub.add_parser("start"); s.add_argument("length"); s.add_argument("--label", default=""); s.add_argument("--pin", action="store_true")
    for c in ("pause", "resume", "stop", "delete", "again"):
        sub.add_parser(c).add_argument("who")
    sub.add_parser("alarms")
    s = sub.add_parser("alarm"); s.add_argument("time"); s.add_argument("--label", default=""); s.add_argument("--days", default=""); s.add_argument("--date")
    for c in ("alarm-on", "alarm-off", "alarm-delete"):
        sub.add_parser(c).add_argument("who")
    sub.add_parser("stopwatch").add_argument("action", nargs="?", default="show", choices=["show", "start", "pause", "lap", "reset"])
    a = ap.parse_args()
    root = a.root
    if a.cmd == "list":
        return show(root)
    if a.cmd == "alarms":
        return show_alarms(root)
    if a.cmd == "alarm":
        if not re.fullmatch(r"\d{1,2}:\d{2}", a.time):
            sys.exit(f"Not a time: {a.time} (say 07:30).")
        days = {"daily": DAYS, "weekdays": DAYS[:5], "": []}.get(a.days.lower(), [d.strip().upper()[:2] for d in a.days.split(",")])
        if any(d not in DAYS for d in days):
            sys.exit(f"Days are MO,TU,WE,TH,FR,SA,SU (or daily, weekdays): {a.days}")
        rows = records(root, "alarm", ALARM_ORDER)
        gone = sorted((t["id"], r) for t, r in rows if t["state"] == "deleted")  # a deleted alarm's file is used again
        ids = {t["id"] for t, _ in rows}
        i, rev = gone[0] if gone else (next(x for x in ("alarm-" + secrets.token_hex(3) for _ in iter(int, 1)) if x not in ids), 0)
        t = {"kind": "alarm", "id": i, "time": a.time.zfill(5), "days": [d for d in DAYS if d in days], "date": None, "label": a.label,
             "state": "on", "answered": iso(now()), "snooze": None, "rev": rev + 1}
        if not days:
            t["date"] = a.date or f"{local(next_ring(t, now())):%Y-%m-%d}"
        write(root, t)
        return show_alarms(root)
    if a.cmd.startswith("alarm-"):
        t, top = pick_alarm(root, a.who)
        t = dict(t, rev=top + 1, snooze=None)
        if a.cmd == "alarm-on":
            t.update(state="on", answered=iso(now()))
            if not t.get("days"):
                t["date"] = None
                t["date"] = f"{local(next_ring(t, now())):%Y-%m-%d}"
        else:
            t["state"] = "off" if a.cmd == "alarm-off" else "deleted"
        write(root, t)
        return show_alarms(root)
    if a.cmd == "stopwatch":
        w, top = stopwatch(root)
        e = elapsed(w)
        if a.action == "start" and w["state"] != "counting":
            w = dict(w, state="counting", started=iso(now() - dt.timedelta(seconds=e)), elapsed=0)
        elif a.action == "pause" and w["state"] == "counting":
            w = dict(w, state="held", elapsed=round(e, 1), started=None)
        elif a.action == "lap" and w["state"] == "counting":
            w = dict(w, laps=list(w.get("laps") or []) + [round(e, 1)])
        elif a.action == "reset" and w["state"] != "reset":
            w = dict(w, state="reset", started=None, elapsed=0, laps=[])
        else:
            w = None
        if w:
            w.update(rev=top + 1, kind="stopwatch", id="stopwatch")
            write(root, w)
        w, _ = stopwatch(root)
        e = int(elapsed(w))
        print(f"stopwatch  {w['state']}  {e // 3600}:{e % 3600 // 60:02d}:{e % 60:02d}" + (f"  laps {w['laps']}" if w.get("laps") else ""))
        return
    if a.cmd == "start":
        n = seconds(a.length)
        ids = {t["id"] for t, _ in timers(root)}
        i = next(x for x in iter(lambda: secrets.token_hex(3), None) if x not in ids)
        write(root, {"id": i, "seconds": n, "label": a.label, "state": "running", "ends": iso(now() + dt.timedelta(seconds=n)),
                     "left": 0, "rev": 1, "by": "claude", "pinned": a.pin})
    else:
        t, top = pick(root, a.who)
        t = dict(t, rev=top + 1)
        if a.cmd == "pause":
            t.update(state="paused", left=left(t), ends=None)
        elif a.cmd == "resume":
            t.update(state="running", ends=iso(now() + dt.timedelta(seconds=t.get("left", 0))), left=0)
        elif a.cmd == "again":
            t.update(state="running", ends=iso(now() + dt.timedelta(seconds=t["seconds"])), left=0)
        else:  # stop, delete (delete also drops the pinned card)
            t.update(state="stopped", ends=None, left=0, **({"pinned": False} if a.cmd == "delete" else {}))
        write(root, t)
    show(root)


if __name__ == "__main__":
    main()
