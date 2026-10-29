#!/usr/bin/env python3
"""Tetra's timers from the command line (standard library only).

Each timer is a JSON file per device in ~/Tetra/Files/Timer (<id>.<device>.json); the highest rev wins.
    tetra_timer.py list                                 the timers now: id, label, state, time left
    tetra_timer.py start 10m [--label Pasta] [--pin]    a new running timer (10m, 1h30m, 90s or plain seconds)
    tetra_timer.py pause|resume|stop|delete|again WHO   WHO = a timer's id or its label (again: start a pinned one anew)
--root DIR (or TETRA_TIMER) points elsewhere. Only <id>.claude.json is ever written.
"""
import argparse, datetime as dt, glob, json, os, re, secrets, sys

ROOT = os.environ.get("TETRA_TIMER", os.path.expanduser("~/Tetra/Files/Timer"))
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
    a = ap.parse_args()
    root = a.root
    if a.cmd == "list":
        return show(root)
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
