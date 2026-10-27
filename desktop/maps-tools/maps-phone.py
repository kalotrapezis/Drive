#!/usr/bin/env python3
"""
A map's phone table (Plan.md § Phone: where a landline number is from): every area code of a country with its place,
from Google's libphonenumber geocoding data (Apache-2.0), in each language libphonenumber has for it. Tetra's Phone reads
the tables beside the installed maps (PhoneArea in PhoneLog.kt), so a map's country is the country whose places it names.

  #prefix  en           el            (en first, the other languages after it, an empty cell where one lacks a prefix)
  302310   Thessaloniki  Θεσσαλονίκη  (the prefix with the country code, digits only)

Usage: maps-phone.py GR greece-phone.tsv   (the country's ISO 3166-1 code, as Geofabrik's index gives it)
"""
import json, os, re, sys, urllib.error, urllib.request

TAG = "v9.0.42"  # libphonenumber's release; a newer one only changes the names
RAW = f"https://raw.githubusercontent.com/google/libphonenumber/{TAG}/resources"
API = "https://api.github.com/repos/google/libphonenumber"


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Tetra maps-phone.py"}), timeout=60) as r:
        return r.read().decode("utf-8")


def main(iso, out):
    meta = get(f"{RAW}/PhoneNumberMetadata.xml")
    m = re.search(rf'<territory id="{re.escape(iso.upper())}" countryCode="(\d+)"', meta)
    if not m:
        sys.exit(f"{iso}: no country code in libphonenumber")
    cc = m.group(1)
    # the geocoding folder's files, one call: <lang>/<cc>.txt, or several <cc><area>.txt for big codes (+1's areas)
    geo = next(x["sha"] for x in json.loads(get(f"{API}/contents/resources?ref={TAG}")) if x["name"] == "geocoding")
    paths = [t["path"] for t in json.loads(get(f"{API}/git/trees/{geo}?recursive=1"))["tree"] if t["type"] == "blob"]
    # country codes are prefix-free, so every file whose name starts with cc is this code's; shortcut: a +1 map gets all of
    # North America's areas and a +7 map Russia's and Kazakhstan's (fine for naming a caller)
    names = {}
    for p in paths:
        lang, _, name = p.partition("/")
        if not (name.startswith(cc) and name.endswith(".txt") and name[:-4].isdigit()):
            continue
        for line in get(f"{RAW}/geocoding/{p}").splitlines():
            prefix, bar, place = line.partition("|")
            if bar and prefix.isdigit() and place.strip():
                names.setdefault(prefix, {})[lang] = place.strip().replace("\t", " ")
    if not names:
        sys.exit(f"+{cc}: libphonenumber names no places")
    langs = sorted({l for v in names.values() for l in v}, key=lambda l: (l != "en", l))
    with open(out + ".part", "w", encoding="utf-8") as f:
        f.write("#prefix\t" + "\t".join(langs) + "\n")
        for prefix in sorted(names):
            f.write(prefix + "\t" + "\t".join(names[prefix].get(l, "") for l in langs) + "\n")
    os.replace(out + ".part", out)
    print(f"{out}: +{cc}, {len(names)} prefixes, {' '.join(langs)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
