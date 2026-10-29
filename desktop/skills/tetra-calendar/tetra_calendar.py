#!/usr/bin/env python3
"""Tetra's calendar from the command line (standard library only).

The calendars are folders in ~/Tetra/.System/Calendar/Shared (~/Tetra/Files/Calendar before 29 Oct 2026); each event is one iCalendar (.ics) file in its calendar's folder.
    tetra_calendar.py list                              the calendars, their colours and how many events
    tetra_calendar.py agenda [FROM] [TO]                events between two dates (repeats worked out); default: the next 7 days
    tetra_calendar.py find TEXT                         events whose title, place or notes contain TEXT, with their files
    tetra_calendar.py add --calendar NAME --title T --start "2026-10-20 09:30" [--end ...|--minutes 60]
                    [--all-day 2026-10-20 [--days N]] [--place P] [--notes N] [--repeat RRULE]
                    [--remind 30m,1h,1d,1d@09:00,3d@09:00+daily] [--zone Europe/Athens]
    tetra_calendar.py new-calendar NAME [#RRGGBB]
    tetra_calendar.py trash FILE                        an event (or a calendar folder) to Tetra's Trash — never rm
    tetra_calendar.py check                             every file read and checked; run after any change
--root DIR (or TETRA_CALENDAR) points elsewhere.
"""
import argparse, datetime as dt, hashlib, os, re, shutil, sys, uuid
from zoneinfo import ZoneInfo


def default_root(app):
    """Tetra's .System/<app>/Shared (since 29 Oct 2026); Files/<app> on a computer whose Tetra has not moved it there yet."""
    new, old = os.path.expanduser(f"~/Tetra/.System/{app}/Shared"), os.path.expanduser(f"~/Tetra/Files/{app}")
    return new if os.path.isdir(new) or not os.path.isdir(old) else old

ROOT = os.environ.get("TETRA_CALENDAR", default_root("Calendar"))
PALETTE = ["#E91E63", "#D50000", "#E67C73", "#F4511E", "#F6BF26", "#33B679", "#0B8043", "#039BE5", "#3F51B5", "#7986CB", "#8E24AA", "#616161"]
DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def local_zone():
    try:
        return ZoneInfo(os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1])
    except Exception:
        return ZoneInfo("UTC")


LOCAL = local_zone()

# ——— reading ———

def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text.replace("\r\n", "\n")).split("\n")


def parse(text):
    """Components as dicts: {"name", "props": [(NAME, params, value)], "subs": [...]}."""
    top, stack = [], []
    for line in unfold(text):
        if not line.strip():
            continue
        q, colon = False, -1
        for i, ch in enumerate(line):
            if ch == '"':
                q = not q
            elif ch == ":" and not q:
                colon = i
                break
        if colon < 0:
            continue
        head, value = line[:colon], line[colon + 1:]
        name, _, params = head.partition(";")
        name = name.upper()
        if name == "BEGIN":
            c = {"name": value.strip().upper(), "props": [], "subs": []}
            (stack[-1]["subs"] if stack else top).append(c)
            stack.append(c)
        elif name == "END":
            if stack:
                stack.pop()
        elif stack:
            stack[-1]["props"].append((name, params, value))
    return top


def param(params, key):
    for p in re.findall(r'([^;=]+)=("[^"]*"|[^;]*)', params):
        if p[0].upper() == key:
            return p[1].strip('"')
    return None


def prop(c, name):
    return next((p for p in c["props"] if p[0] == name), None)


def unescape(s):
    return re.sub(r"\\(.)", lambda m: "\n" if m.group(1) in "nN" else m.group(1), s)


def zone(tzid):
    if not tzid:
        return LOCAL
    parts = tzid.strip("/").split("/")
    for k in range(len(parts)):
        try:
            return ZoneInfo("/".join(parts[k:]))
        except Exception:
            pass
    return LOCAL


def time_of(p):
    """(aware datetime, is_date) from a DTSTART-like property."""
    _, params, v = p
    v = v.strip().split(",")[0]
    if (param(params, "VALUE") or "").upper() == "DATE" or len(v) == 8:
        d = dt.datetime.strptime(v[:8], "%Y%m%d")
        return d.replace(tzinfo=LOCAL), True
    if v.upper().endswith("Z"):
        return dt.datetime.strptime(v[:15], "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc), False
    return dt.datetime.strptime(v[:15], "%Y%m%dT%H%M%S").replace(tzinfo=zone(param(params, "TZID"))), False


def duration(s):
    m = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", s.strip().upper())
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    g = [int(x) if x else 0 for x in m.groups()[1:]]
    return sign * (g[0] * 7 + g[1]), sign * (g[2] * 3600 + g[3] * 60 + g[4])


def event(c):
    p = prop(c, "DTSTART")
    if not p:
        return None
    start, all_day = time_of(p)
    end = None
    if prop(c, "DTEND"):
        end = time_of(prop(c, "DTEND"))[0]
    elif prop(c, "DURATION") and duration(prop(c, "DURATION")[2]):
        d, s = duration(prop(c, "DURATION")[2])
        end = start + dt.timedelta(days=d, seconds=s)
    if end is None or end <= start:
        end = start + (dt.timedelta(days=1) if all_day else dt.timedelta(0))
    ex = []
    for n, params, v in c["props"]:
        if n == "EXDATE":
            ex += [time_of((n, params, x))[0] for x in v.split(",")]
    rid = prop(c, "RECURRENCE-ID")
    alarms = []
    for a in c["subs"]:
        if a["name"] == "VALARM" and prop(a, "TRIGGER"):
            alarms.append(prop(a, "TRIGGER")[2] + (f" ×{int(prop(a, 'REPEAT')[2]) + 1}" if prop(a, "REPEAT") else ""))
    get = lambda n: unescape(prop(c, n)[2]) if prop(c, n) else ""
    return {"uid": get("UID").strip(), "title": get("SUMMARY"), "place": get("LOCATION"), "notes": get("DESCRIPTION"),
            "start": start, "end": end, "all_day": all_day, "rrule": (prop(c, "RRULE") or (0, 0, None))[2],
            "exdates": ex, "rid": time_of(rid)[0] if rid else None, "cancelled": get("STATUS").upper() == "CANCELLED", "alarms": alarms}


def calendars(root):
    out = []
    for i, name in enumerate(sorted((n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)) and not n.startswith(".")), key=str.lower) if os.path.isdir(root) else []):
        d = os.path.join(root, name)
        color = open(os.path.join(d, "color")).read().strip() if os.path.isfile(os.path.join(d, "color")) else PALETTE[i % len(PALETTE)]
        out.append({"name": name, "dir": d, "color": color})
    return out


def files(cal):
    for n in sorted(os.listdir(cal["dir"])):
        if n.lower().endswith(".ics") and not n.startswith("."):
            yield os.path.join(cal["dir"], n)


def read(path):
    comps = parse(open(path, encoding="utf-8", errors="replace").read())
    evs = [e for c in comps for v in ([c] if c["name"] == "VEVENT" else c["subs"]) if v["name"] == "VEVENT" for e in [event(v)] if e]
    return evs

# ——— repeats (RFC 5545 RRULE; the parts calendars use) ———

def nth_weekdays(year, month, code):
    """The days of a month that match BYDAY code like 'TU', '3TU', '-1FR'."""
    m = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", code)
    if not m:
        return []
    n, wd = (int(m.group(1)) if m.group(1) else None), DAYS.index(m.group(2))
    first = dt.date(year, month, 1)
    last = (dt.date(year + month // 12, month % 12 + 1, 1) - dt.timedelta(days=1)).day
    days = [first + dt.timedelta(days=i) for i in range(last) if (first + dt.timedelta(days=i)).weekday() == wd]
    if n is None:
        return days
    return [days[n - 1]] if 0 < n <= len(days) else ([days[n]] if -len(days) <= n < 0 else [])


def expand(e, frm, to):
    """The starts of an event in [frm, to) (aware datetimes), in its own clock."""
    start = e["start"]
    if not e["rrule"]:
        return [start]
    r = dict(p.split("=", 1) for p in e["rrule"].upper().split(";") if "=" in p)
    freq, step = r.get("FREQ"), int(r.get("INTERVAL", "1"))
    count = int(r["COUNT"]) if "COUNT" in r else None
    until = None
    if "UNTIL" in r:
        u = r["UNTIL"]
        until = time_of(("UNTIL", "", u))[0] if len(u) > 8 else dt.datetime.strptime(u, "%Y%m%d").replace(tzinfo=start.tzinfo) + dt.timedelta(days=1) - dt.timedelta(seconds=1)
    byday = [d for d in r.get("BYDAY", "").split(",") if d]
    bymd = [int(x) for x in r.get("BYMONTHDAY", "").split(",") if x]
    bymonth = [int(x) for x in r.get("BYMONTH", "").split(",") if x]
    setpos = [int(x) for x in r.get("BYSETPOS", "").split(",") if x]
    s0, clock, tz = start.date(), start.timetz().replace(tzinfo=None), start.tzinfo
    out, n, k = [], 0, 0

    def month_days(y, m):
        last = (dt.date(y + m // 12, m % 12 + 1, 1) - dt.timedelta(days=1)).day
        if bymd:
            return sorted(dt.date(y, m, d if d > 0 else last + 1 + d) for d in bymd if -last <= d <= last and d != 0)
        if byday:
            return sorted({d for code in byday for d in nth_weekdays(y, m, code)})
        return [dt.date(y, m, s0.day)] if s0.day <= last else []

    while k < 200000:
        if freq == "DAILY":
            cands = [s0 + dt.timedelta(days=k * step)]
            cands = [d for d in cands if (not byday or DAYS[d.weekday()] in byday) and (not bymonth or d.month in bymonth)]
        elif freq == "WEEKLY":
            week = s0 - dt.timedelta(days=s0.weekday()) + dt.timedelta(weeks=k * step)
            wds = [DAYS.index(d[-2:]) for d in byday] or [s0.weekday()]
            cands = sorted(week + dt.timedelta(days=w) for w in set(wds))
        elif freq == "MONTHLY":
            y, m = divmod(s0.month - 1 + k * step, 12)
            cands = month_days(s0.year + y, m + 1)
        elif freq == "YEARLY":
            y = s0.year + k * step
            cands = sorted(d for m in (bymonth or [s0.month]) for d in (month_days(y, m) if (byday or bymd) else ([dt.date(y, m, s0.day)] if s0.day <= (dt.date(y + m // 12, m % 12 + 1, 1) - dt.timedelta(days=1)).day else [])))
        else:
            return [start]
        if setpos:
            cands = [cands[p - 1 if p > 0 else p] for p in setpos if -len(cands) <= (p - 1 if p > 0 else p) < len(cands)]
        k += 1
        for d in cands:
            if d < s0:
                continue
            t = dt.datetime.combine(d, clock).replace(tzinfo=tz)
            if (until and t > until) or (count is not None and n >= count) or t >= to:
                return out
            n += 1
            if t >= frm:
                out.append(t)
    return out


def occurrences(cals, frm, to):
    out = []
    for cal in cals:
        for path in files(cal):
            try:
                evs = read(path)
            except Exception as ex:
                print(f"! {path}: {ex}", file=sys.stderr)
                continue
            master = next((e for e in evs if e["rid"] is None), None)
            overrides = [e for e in evs if e["rid"] is not None]
            moved = {o["rid"].timestamp() for o in overrides}
            if master:
                length = master["end"] - master["start"]
                skip = {x.timestamp() for x in master["exdates"]} | moved
                for s in expand(master, frm - length, to):
                    if s.timestamp() not in skip and s + length > frm and s < to:
                        out.append((s, s + length, master, cal, path))
            for o in overrides:
                if not o["cancelled"] and o["start"] < to and o["end"] > frm:
                    out.append((o["start"], o["end"], o, cal, path))
    return sorted(out, key=lambda x: x[0].timestamp())

# ——— writing ———

def esc(s):
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line):
    out, cur, n = [], "", 0
    for ch in line:
        b = len(ch.encode())
        if n + b > 75:
            out.append(cur)
            cur, n = " ", 1
        cur += ch
        n += b
    return "\r\n".join(out + [cur])


def stamp():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def slug(title, uid):
    """Tetra's name for a new event: its title and eight letters of its UID's hash (as the apps name theirs)."""
    s = re.sub(r"[^\w]+", "-", title.lower(), flags=re.UNICODE).strip("-")[:40].rstrip("-") or "event"
    return f"{s}-{hashlib.sha1(uid.encode()).hexdigest()[:8]}.ics"


def dur(days, seconds):
    t = days * 86400 + seconds
    a = abs(t)
    d, h, m = a // 86400, a % 86400 // 3600, a % 3600 // 60
    time = (f"{h}H" if h else "") + (f"{m}M" if m else "")
    return ("-" if t < 0 else "") + "P" + (f"{d}D" if d else "") + (f"T{time}" if time else ("T0S" if not d else ""))


def alarm(spec, start, all_day):
    """30m, 2h, 1d, 1w, 1d@09:00, 3d@09:00+daily → VALARM lines."""
    m = re.fullmatch(r"(\d+)([mhdw])(?:@(\d\d?):(\d\d))?(\+daily)?", spec.strip())
    if not m:
        sys.exit(f"Reminder not understood: {spec} (say 30m, 2h, 1d, 1d@09:00 or 3d@09:00+daily)")
    n, unit = int(m.group(1)), m.group(2)
    lines = ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder"]
    if unit in "mh":
        lines.append("TRIGGER:" + dur(0, -n * (60 if unit == "m" else 3600)))
    else:
        days = n * (7 if unit == "w" else 1)
        at = dt.time(int(m.group(3)), int(m.group(4))) if m.group(3) else (dt.time(9, 0) if all_day else start.time())
        secs = at.hour * 3600 + at.minute * 60 - (0 if all_day else start.hour * 3600 + start.minute * 60)
        lines.append("TRIGGER:" + dur(-days, secs))
        if m.group(5) and days > 1:
            lines += [f"REPEAT:{days - 1}", "DURATION:P1D"]
    return lines + ["END:VALARM"]


def tval(t, all_day):
    if all_day:
        return ";VALUE=DATE", t.strftime("%Y%m%d")
    return f";TZID={t.tzinfo.key}", t.strftime("%Y%m%dT%H%M%S")


def cmd_add(a, root):
    cal = next((c for c in calendars(root) if c["name"].lower() == a.calendar.lower()), None)
    if not cal:
        sys.exit(f"No calendar named {a.calendar}. Calendars: {', '.join(c['name'] for c in calendars(root)) or 'none'} (tetra_calendar.py new-calendar NAME)")
    tz = ZoneInfo(a.zone) if a.zone else LOCAL
    if a.all_day:
        start = dt.datetime.strptime(a.all_day, "%Y-%m-%d")
        end = start + dt.timedelta(days=a.days)
        all_day = True
    else:
        if not a.start:
            sys.exit("--start or --all-day is needed")
        start = dt.datetime.strptime(a.start, "%Y-%m-%d %H:%M").replace(tzinfo=tz)
        end = dt.datetime.strptime(a.end, "%Y-%m-%d %H:%M").replace(tzinfo=tz) if a.end else start + dt.timedelta(minutes=a.minutes)
        if end <= start:
            sys.exit("The end is not after the start.")
        all_day = False
    uid = str(uuid.uuid4())
    s = stamp()
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Claude//tetra-calendar//EN", "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{s}", f"LAST-MODIFIED:{s}",
             "SEQUENCE:0", "SUMMARY:" + esc(a.title)]
    p, v = tval(start, all_day); lines.append(f"DTSTART{p}:{v}")
    p, v = tval(end, all_day); lines.append(f"DTEND{p}:{v}")
    if a.place: lines.append("LOCATION:" + esc(a.place))
    if a.notes: lines.append("DESCRIPTION:" + esc(a.notes))
    if a.repeat: lines.append("RRULE:" + a.repeat.removeprefix("RRULE:"))
    for spec in filter(None, (a.remind or "").split(",")):
        lines += alarm(spec, start, all_day)
    lines += ["END:VEVENT", "END:VCALENDAR"]
    path, n = os.path.join(cal["dir"], slug(a.title, uid)), 2
    while os.path.exists(path):  # never over another event's file
        path, n = os.path.join(cal["dir"], slug(a.title, uid)[:-4] + f" ({n}).ics"), n + 1
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(fold(x) for x in lines) + "\r\n")
    print(path)


def cmd_trash(a, root):
    path = os.path.abspath(a.file)
    if not path.startswith(os.path.abspath(root) + os.sep):
        sys.exit("Only events and calendars inside Tetra's Calendar folder.")
    # .System/Calendar/Shared → .System/Trash/Shared; an older Files/Calendar → Files/Trash
    up = os.path.dirname(os.path.abspath(root))
    trash = os.path.join(os.path.dirname(up), "Trash", "Shared") if os.path.basename(os.path.abspath(root)) == "Shared" else os.path.join(up, "Trash")
    os.makedirs(trash, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(path.rstrip("/")))
    target, n = os.path.join(trash, base + ext), 2
    while os.path.exists(target):
        target, n = os.path.join(trash, f"{base} ({n}){ext}"), n + 1
    shutil.move(path, target)
    print(target)


def cmd_check(root):
    problems, uids, count = 0, {}, 0
    for cal in calendars(root):
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", cal["color"]):
            print(f"! {cal['name']}/color: not #RRGGBB"); problems += 1
        for path in files(cal):
            count += 1
            rel = os.path.relpath(path, root)
            try:
                text = open(path, encoding="utf-8").read()
                comps = parse(text)
                if not any(c["name"] == "VCALENDAR" for c in comps):
                    print(f"! {rel}: no BEGIN:VCALENDAR"); problems += 1; continue
                vevents = [v for c in comps for v in c["subs"] if v["name"] == "VEVENT"]
                if not vevents:
                    print(f"! {rel}: no VEVENT"); problems += 1
                for v in vevents:
                    for need in ("UID", "DTSTART", "DTSTAMP"):
                        if not prop(v, need):
                            print(f"! {rel}: a VEVENT without {need}"); problems += 1
                    for n, params, val in v["props"]:
                        tz = param(params, "TZID")
                        if tz and zone(tz) is LOCAL and tz not in (str(LOCAL), getattr(LOCAL, "key", "")):
                            print(f"! {rel}: {n} names the zone {tz}, which is not an IANA name like Europe/Athens"); problems += 1
                    e = event(v)
                    if e and prop(v, "DTEND") and time_of(prop(v, "DTEND"))[0] < e["start"]:
                        print(f"! {rel}: DTEND before DTSTART"); problems += 1
                    if e and e["rrule"] and not re.search(r"FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)", e["rrule"].upper()):
                        print(f"! {rel}: RRULE without a FREQ Tetra repeats"); problems += 1
                    if e and e["rid"] is None:
                        uids.setdefault((cal["name"], e["uid"]), []).append(rel)
            except Exception as ex:
                print(f"! {rel}: {ex}"); problems += 1
    for (cal, uid), where in uids.items():
        if len(where) > 1:
            print(f"! the same UID {uid} in {', '.join(where)} — a sync conflict or a copy; keep one, move the other to the Trash"); problems += 1
    print(f"{count} event files, {problems} problem{'s' * (problems != 1)}")
    return problems


def when(s, e, all_day):
    if all_day:
        last = (e - dt.timedelta(days=1)).date()
        return s.strftime("%a %d %b") + ("" if last <= s.date() else " – " + last.strftime("%a %d %b")) + ", all day"
    s, e = s.astimezone(LOCAL), e.astimezone(LOCAL)
    return s.strftime("%a %d %b %H:%M") + "–" + (e.strftime("%H:%M") if e.date() == s.date() else e.strftime("%a %d %b %H:%M"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=ROOT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    g = sub.add_parser("agenda"); g.add_argument("frm", nargs="?"); g.add_argument("to", nargs="?")
    f = sub.add_parser("find"); f.add_argument("text")
    n = sub.add_parser("new-calendar"); n.add_argument("name"); n.add_argument("color", nargs="?")
    t = sub.add_parser("trash"); t.add_argument("file")
    sub.add_parser("check")
    a = sub.add_parser("add")
    for x in ("calendar", "title"): a.add_argument("--" + x, required=True)
    for x in ("start", "end", "all-day", "place", "notes", "repeat", "remind", "zone"): a.add_argument("--" + x)
    a.add_argument("--minutes", type=int, default=60); a.add_argument("--days", type=int, default=1)
    args = ap.parse_args()
    root = args.root
    if args.cmd == "list":
        for c in calendars(root):
            print(f"{c['name']}  {c['color']}  {sum(1 for _ in files(c))} events  ({c['dir']})")
    elif args.cmd == "agenda":
        today = dt.datetime.now(LOCAL).replace(hour=0, minute=0, second=0, microsecond=0)
        frm = dt.datetime.strptime(args.frm, "%Y-%m-%d").replace(tzinfo=LOCAL) if args.frm else today
        to = dt.datetime.strptime(args.to, "%Y-%m-%d").replace(tzinfo=LOCAL) + dt.timedelta(days=1) if args.to else frm + dt.timedelta(days=7)
        for s, e, ev, cal, path in occurrences(calendars(root), frm, to):
            extra = (" · " + ev["place"] if ev["place"] else "") + (" (repeats)" if ev["rrule"] or ev["rid"] else "")
            print(f"{when(s, e, ev['all_day'])}  {ev['title'] or '(No title)'}{extra}  [{cal['name']}]  {os.path.relpath(path, root)}")
    elif args.cmd == "find":
        q = args.text.lower()
        for c in calendars(root):
            for path in files(c):
                for ev in read(path):
                    if q in (ev["title"] + " " + ev["place"] + " " + ev["notes"]).lower():
                        print(f"{when(ev['start'], ev['end'], ev['all_day'])}  {ev['title']}{' (repeats: ' + ev['rrule'] + ')' if ev['rrule'] else ''}  {os.path.relpath(path, root)}")
                        break
    elif args.cmd == "new-calendar":
        d = os.path.join(root, args.name)
        if os.path.exists(d):
            sys.exit(f"{args.name} exists.")
        os.makedirs(d)
        open(os.path.join(d, "color"), "w").write((args.color or PALETTE[len(calendars(root)) % len(PALETTE)]).upper() + "\n")
        print(d)
    elif args.cmd == "trash":
        cmd_trash(args, root)
    elif args.cmd == "check":
        sys.exit(1 if cmd_check(root) else 0)
    elif args.cmd == "add":
        cmd_add(args, root)


if __name__ == "__main__":
    main()
