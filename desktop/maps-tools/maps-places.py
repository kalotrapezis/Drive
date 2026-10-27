#!/usr/bin/env python3
"""Tetra Maps' offline search list (Plan.md § Maps): every town, village and place of the kinds Search offers, out of
Geofabrik's OSM extract of Greece, one line each:

    kind <TAB> lat <TAB> lng <TAB> name <TAB> name:en <TAB> more (address, or brand) <TAB> opening_hours <TAB> phone
         <TAB> website <TAB> wheelchair (yes, limited, no or empty)

for the place's info page offline (the user, 21 Oct: "If I click touch on a place there is no info page for that?").

kind is one of KINDS' keys below (the phone's pills) or a settlement (city, town, village, suburb, island…), whose "more" is
its postcode when OSM has one. Ways are put
at the mean of their nodes; relations are left out (few of these kinds are relations).
A second file, the addresses (the user, 21 Oct: "To click on a spot show the address the number the postcode"), one line
for each thing with a house number: lat <TAB> lng <TAB> street <TAB> number <TAB> postcode <TAB> town.
A third, the streets: name <TAB> lat <TAB> lng, the middle of each named road's piece, so a street named in a decision (an
ΑμεΑ spot from Διαύγεια, tools/maps-diavgeia.py) can be shown even where its house numbers are not known.
Usage: maps-places.py greece-latest.osm.pbf greece-places.tsv greece-addresses.tsv [greece-streets.tsv]   (needs pyosmium)
"""
import sys
import osmium

# the phone's pills, in OSM's words (the user, 21 Oct: "restorants and pharmases and supermarkets or petrol stations or
# charging stations add disability parking stations")
KINDS = {
    "restaurant": lambda t: t.get("amenity") == "restaurant",
    "cafe": lambda t: t.get("amenity") == "cafe",
    "fast_food": lambda t: t.get("amenity") == "fast_food",
    "bakery": lambda t: t.get("shop") == "bakery",
    "supermarket": lambda t: t.get("shop") in ("supermarket", "convenience"),  # mini markets too (Easy Market in Σχηματάρι)
    "pharmacy": lambda t: t.get("amenity") == "pharmacy",
    "hospital": lambda t: t.get("amenity") in ("hospital", "clinic"),
    "fuel": lambda t: t.get("amenity") == "fuel",
    "charging": lambda t: t.get("amenity") == "charging_station",
    # public ones only: not one kept for a person, a house or customers (the user: never personal or exclusive spots)
    "disabled_parking": lambda t: t.get("access", "yes") not in ("private", "customers", "permit", "no", "residents", "designated_private")
        and (t.get("parking_space") == "disabled"
        or (t.get("amenity") == "parking" and t.get("capacity:disabled", "no") not in ("no", "0", ""))),
    "parking": lambda t: t.get("amenity") == "parking",
    "atm": lambda t: t.get("amenity") == "atm" or (t.get("amenity") == "bank" and t.get("atm") == "yes"),
    "hotel": lambda t: t.get("tourism") in ("hotel", "guest_house", "hostel"),
    "beach": lambda t: t.get("natural") == "beach",
    "museum": lambda t: t.get("tourism") == "museum",
    "toilets": lambda t: t.get("amenity") == "toilets",
    # schools, by level (the user, 21 Oct: "from kindengarden to Highschools"): OSM's isced:level, else the Greek name
    "kindergarten": lambda t: t.get("amenity") == "kindergarten" or (t.get("amenity") == "school" and "ηπιαγωγ" in t.get("name", "")),
    "primary_school": lambda t: t.get("amenity") == "school" and (t.get("isced:level", "").startswith("1") or "ημοτικ" in t.get("name", "")),
    "secondary_school": lambda t: t.get("amenity") == "school" and (t.get("isced:level", "")[:1] in ("2", "3")
        or any(w in t.get("name", "") for w in ("υμνάσιο", "ύκειο", "ΓΥΜΝΑΣΙΟ", "ΛΥΚΕΙΟ", "ΕΠΑΛ", "ΕΠΑ.Λ"))),
    "school": lambda t: t.get("amenity") == "school",
    "university": lambda t: t.get("amenity") in ("university", "college"),
    # toll stations (the user, 21 Oct: "Do we know where the talls are to show them on the map as dots on active routs")
    "toll": lambda t: t.get("barrier") == "toll_booth",
}
PLACES = {"city", "town", "village", "suburb", "neighbourhood", "hamlet", "island", "islet", "locality"}


ROADS = {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "pedestrian", "service", "trunk"}


def kind(tags):
    if tags.get("place") in PLACES and "name" in tags:
        return tags["place"]
    for k, test in KINDS.items():
        if test(tags):
            return k
    return None


def clean(s):
    return (s or "").replace("\t", " ").replace("\n", " ").strip()


class Handler(osmium.SimpleHandler):
    def __init__(self, out, addresses, streets=None):
        super().__init__()
        self.out = out
        self.addresses = addresses
        self.streets = streets
        self.count = 0
        self.addressed = 0

    def address(self, lat, lng, tags):
        if "addr:housenumber" in tags and ("addr:street" in tags or "addr:place" in tags):
            street = tags.get("addr:street") or tags.get("addr:place")
            self.addresses.write(f"{lat:.6f}\t{lng:.6f}\t{clean(street)}\t{clean(tags.get('addr:housenumber'))}\t{clean(tags.get('addr:postcode'))}\t{clean(tags.get('addr:city'))}\n")
            self.addressed += 1

    def write(self, k, lat, lng, tags):
        street = " ".join(x for x in (tags.get("addr:street"), tags.get("addr:housenumber")) if x)
        more = ", ".join(x for x in (street, tags.get("addr:city")) if x) or tags.get("brand") or tags.get("operator") or ""
        if k in PLACES:  # a town's or village's postcode, for an address where no house has one (the user, 23 Oct)
            more = tags.get("postal_code") or tags.get("addr:postcode") or ""
        if k == "toll":  # who runs it and, when OSM has it, what a car pays
            more = " · ".join(x for x in (tags.get("operator"), tags.get("charge")) if x)
        phone = tags.get("phone") or tags.get("contact:phone")
        site = tags.get("website") or tags.get("contact:website")
        self.out.write(f"{k}\t{lat:.6f}\t{lng:.6f}\t{clean(tags.get('name'))}\t{clean(tags.get('name:en'))}\t{clean(more)}"
                       f"\t{clean(tags.get('opening_hours'))}\t{clean(phone)}\t{clean(site)}\t{clean(tags.get('wheelchair'))}\n")
        self.count += 1

    def node(self, n):
        if n.location.valid():
            self.address(n.location.lat, n.location.lon, n.tags)
        k = kind(n.tags)
        if k and n.location.valid():
            self.write(k, n.location.lat, n.location.lon, n.tags)

    def way(self, w):
        if self.streets is not None and "highway" in w.tags and "name" in w.tags and w.tags["highway"] in ROADS:
            pts = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
            if pts:
                mid = pts[len(pts) // 2]
                self.streets.write(f"{clean(w.tags['name'])}\t{mid[0]:.6f}\t{mid[1]:.6f}\n")
        k = kind(w.tags)
        if k in PLACES:
            k = None
        if not k and "addr:housenumber" not in w.tags:
            return
        pts = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
        if pts:
            lat, lng = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            self.address(lat, lng, w.tags)
            if k:
                self.write(k, lat, lng, w.tags)


if __name__ == "__main__":
    import os
    streets = open(sys.argv[4] + ".part", "w", encoding="utf-8") if len(sys.argv) > 4 else None
    with open(sys.argv[2] + ".part", "w", encoding="utf-8") as out, open(sys.argv[3] + ".part", "w", encoding="utf-8") as addresses:
        h = Handler(out, addresses, streets)
        h.apply_file(sys.argv[1], locations=True)
    os.replace(sys.argv[2] + ".part", sys.argv[2])
    os.replace(sys.argv[3] + ".part", sys.argv[3])
    if streets:
        streets.close(); os.replace(sys.argv[4] + ".part", sys.argv[4])
    print(f"{h.count} places, {h.addressed} addresses")
