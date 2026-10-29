---
name: tetra-calendar
description: Read and manage the user's calendar in Tetra — its calendars are folders of iCalendar (.ics) files in ~/Tetra/.System/Calendar/Shared that sync to their phone and tablet. Use whenever the user asks what is on their calendar, to add, move, change, cancel or delete an event or a reminder, to make or rename a calendar, to find free time, to plan a week, or to import events from an email, a timetable or a list into their calendar.
---

# Tetra's calendar

The user's calendar is **files**, on purpose: Tetra (their own app, on Android and the PC) shows them and rings their
reminders, and you manage them by changing the files. Tetra syncs the folder to their phone and tablet.

```
~/Tetra/.System/Calendar/Shared/   one folder per calendar; the folder's name is the calendar's name
  Personal/
    color                               one line: #E91E63 (the calendar's colour)
    dentist-3f9a2c41.ics                  one event = one .ics file (a repeating one, with its changed days, too)
  Work/
    color
    staff-meeting-c2d41077.ics
```

Tetra keeps it in its hidden system folder since 29 Oct 2026 (it was `~/Tetra/Files/Calendar` before; `tetra_calendar.py` still
finds that one on a computer whose Tetra has not moved it yet, so prefer the helper over hard-coded paths).

## Use the helper first

`tetra_calendar.py` beside this file (standard library only) does the careful parts. Run it with `python3`:

```bash
C=~/.claude/skills/tetra-calendar/tetra_calendar.py  # not calendar.py: that name hides Python's own module
python3 $C list                                  # the calendars, colours, event counts
python3 $C agenda 2026-10-19 2026-10-25          # what happens between two dates, repeats worked out
python3 $C find dentist                          # an event's file, by title, place or notes
python3 $C add --calendar Personal --title "Dentist" --start "2026-10-21 17:30" --minutes 45 \
    --place "Thiva" --remind 30m,1d@09:00
python3 $C add --calendar Family --title "Mum's birthday" --all-day 2027-03-12 --repeat "FREQ=YEARLY" \
    --remind 3d@09:00+daily                      # 3 days before at 9:00, and every day after until the day
python3 $C new-calendar "School" "#33B679"
python3 $C trash ~/Tetra/.System/Calendar/Shared/Personal/dentist-3f9a2c41.ics
python3 $C check                                 # ALWAYS after any change: every file read and checked
```

`--remind` takes a comma list: `30m`, `2h`, `1d`, `1w` before; `1d@09:00` = the day before at 09:00; `3d@09:00+daily`
= at 09:00 on each of the 3 days before. `--repeat` takes an RRULE (below). Times are the computer's zone
(Europe/Athens) unless `--zone` says otherwise.

Answering "what's on next week" or "when am I free": run `agenda` for the span and read it; never work out repeats in
your head.

## Changing a file by hand

For what the helper does not do (a new title, a moved time, one day of a repeat), edit the event's .ics directly.
Find it with `find`. An event file looks like this:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Claude//tetra-calendar//EN
BEGIN:VEVENT
UID:6f1c2b0e-8a1d-4a43-9f3e-2b7d5c9e1a10
DTSTAMP:20261018T090000Z
LAST-MODIFIED:20261018T090000Z
SEQUENCE:0
SUMMARY:Staff meeting
DTSTART;TZID=Europe/Athens:20261020T100000
DTEND;TZID=Europe/Athens:20261020T110000
LOCATION:Room 2\, first floor
DESCRIPTION:Agenda:\n1. Timetable\n2. Trips
RRULE:FREQ=WEEKLY;BYDAY=TU
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Reminder
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR
```

The rules (RFC 5545, as Google and Outlook write it):
- **UID** unique and never changed. A new event: a new file with a new UID (`uuidgen`), any name ending in `.ics`
  (Tetra's own: the title's words and eight letters of the UID's SHA-1, `staff-meeting-6f1c2b0e.ics`; never a name
  another file has). Never rename a file.
- **On every change** set `DTSTAMP` and `LAST-MODIFIED` to now in UTC (`date -u +%Y%m%dT%H%M%SZ`) and add 1 to
  `SEQUENCE`. Sync uses them to tell the newer version.
- **Times**: `DTSTART;TZID=Europe/Athens:20261020T100000` (local time in an IANA zone), or UTC with `Z`
  (`20261020T070000Z`). No VTIMEZONE block is needed. **All day**: `DTSTART;VALUE=DATE:20261102` and `DTEND` the day
  **after** the last (`20261104` for 2–3 November).
- **Text**: escape `,` `;` `\` as `\,` `\;` `\\`, a new line as `\n`. Lines may be long; Tetra reads them either way.
- Keep every line you do not understand (ATTENDEE, X-GOOGLE-…, X-…). Change only what you mean to.

### Repeats (RRULE)
| Wanted | RRULE |
|---|---|
| Every day | `FREQ=DAILY` |
| Every weekday | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` |
| Weekly on Tuesday and Thursday | `FREQ=WEEKLY;BYDAY=TU,TH` |
| Every two weeks | `FREQ=WEEKLY;INTERVAL=2` |
| Monthly on day 20 | `FREQ=MONTHLY` (day from DTSTART) or `FREQ=MONTHLY;BYMONTHDAY=20` |
| Monthly on the third Tuesday / the last Friday | `FREQ=MONTHLY;BYDAY=3TU` / `FREQ=MONTHLY;BYDAY=-1FR` |
| Yearly | `FREQ=YEARLY` |
| …10 times / until 30 June 2027 | add `;COUNT=10` / `;UNTIL=20270630T235959Z` (all-day: `;UNTIL=20270630`) |

- **Cancel one day** of a repeat: add `EXDATE;TZID=Europe/Athens:20261027T100000` (the day's original start) to the
  event. All day: `EXDATE;VALUE=DATE:20261027`.
- **Change one day**: add a second VEVENT to the **same file**, with the same UID, `RECURRENCE-ID` = that day's original
  start (`RECURRENCE-ID;TZID=Europe/Athens:20261027T100000`), its own DTSTART/DTEND/SUMMARY…, DTSTAMP.
- **Change from a day on** ("this and following"): end the old one with `UNTIL` (the day before, e.g.
  `UNTIL=20261026T235959Z`, removing any COUNT) and make a new event file from that day with the new details.

### Reminders (VALARM)
Each reminder is a `BEGIN:VALARM … END:VALARM` inside the VEVENT, with `ACTION:DISPLAY`, `DESCRIPTION:Reminder` and a
`TRIGGER` counted from the start: `-PT30M` (30 minutes before), `-PT1H`, `-P1D`, `PT0S` (at the time). Several are fine.
- At a clock time, days before: count back from the event's start. An all-day event starts at 00:00, so "the day
  before at 09:00" is `-PT15H`, "3 days before at 09:00" is `-P2DT15H`. A 17:30 event: the day before at 09:00 is
  `-P1DT8H30M`.
- **Repeating reminder** ("every day for the 3 days before, at 09:00"): the first one as above, then `REPEAT:2` and
  `DURATION:P1D` (2 more, a day apart).
- If you move a timed event, recompute any "at 09:00" reminder so it still lands at 09:00.

## Calendars
- New: `new-calendar NAME [#RRGGBB]`, or `mkdir` + a `color` file holding `#RRGGBB`.
- Rename: rename the folder. Colour: rewrite `color`.
- Move an event to another calendar: `mv` its file into that folder.
- Delete an event or a calendar: **`tetra_calendar.py trash PATH`** (into `~/Tetra/.System/Trash/Shared`). Not `rm`: a file moved into
  Trash moves there on every device and can be restored; an `rm`'d event leaves no copy here (since desktop
  0.6.0-beta.4 the other devices put theirs in their Trash; older builds brought it back from the phone).
- Colours Tetra offers: `#E91E63` pink, `#D50000` red, `#E67C73` flamingo, `#F4511E` tangerine, `#F6BF26` yellow,
  `#33B679` sage, `#0B8043` green, `#039BE5` blue, `#3F51B5` blueberry, `#7986CB` lavender, `#8E24AA` grape,
  `#616161` grey.

## Importing
To bring in an .ics from elsewhere (Google, Outlook, an invitation), prefer Tetra's own **Import** (side panel, or
open the file with Tetra Calendar): it splits it into one file per event and updates rather than doubles. By hand:
one VEVENT (with its RECURRENCE-ID changes) per file, the file's own VTIMEZONE blocks may stay.

## After a change
1. `python3 $C check` — fix anything it reports.
2. Say what you changed, and that the phone and tablet get it within seconds while Tetra is open there (otherwise at
   their next sync, or Refresh at the top of their Calendar). Tetra on the computer shows it immediately; reminders ring
   on every device. A deleted event stays 30 days in the Trash (Calendar's trash button restores it), then goes.
3. Two files with the same UID in one calendar is a sync conflict (`name (2).ics`): Tetra shows the newer and offers
   "Keep this one"; you may move the older to the Trash after checking which is right.
