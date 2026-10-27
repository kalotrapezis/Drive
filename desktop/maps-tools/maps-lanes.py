#!/usr/bin/env python3
"""Tetra Maps' lanes (the user, 23 Oct: "a strip with arrows, the right lanes lit, and in the voice 'keep to the two right
lanes'"): the lane arrows OpenStreetMap has on roads (turn:lanes), out of Geofabrik's extract of Greece, one line for each
road piece's end in the way it is driven:

    lat <TAB> lng <TAB> bearing <TAB> turn:lanes <TAB> destination:lanes <TAB> metres

lat and lng are the piece's last point (where its lanes lead into a crossing or a fork), bearing the direction it is driven
there in whole degrees (0 north, clockwise), metres the piece's length: where its lanes begin, as an exit's lane does
where the broken line starts (the user, 23 Oct: "take the exit when the dashed lines begin"). The lanes left to right as
OSM writes them: | between lanes, ; between a lane's arrows (through, left, slight_right, merge_to_left…; empty is
through). GraphHopper's graph has no lanes, so the phone finds a turn's lanes by the route passing a piece's end, facing
its way.
Usage: maps-lanes.py greece-latest.osm.pbf greece-lanes.tsv   (needs pyosmium)
"""
import math
import sys
import osmium

ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
         "tertiary", "tertiary_link"}


def bearing(a, b):
    la1, la2 = math.radians(a.lat), math.radians(b.lat)
    dl = math.radians(b.lon - a.lon)
    return math.degrees(math.atan2(math.sin(dl) * math.cos(la2),
                                   math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl))) % 360


def distance(a, b):
    la1, la2 = math.radians(a.lat), math.radians(b.lat)
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b.lon - a.lon) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


class Lanes(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.count = 0

    def write(self, a, b, turns, dest, metres):
        if a.lat == b.lat and a.lon == b.lon:
            return
        clean = lambda s: (s or "").replace("\t", " ").replace("\n", " ")
        self.out.write(f"{b.lat:.6f}\t{b.lon:.6f}\t{round(bearing(a, b)) % 360}\t{clean(turns)}\t{clean(dest)}\t{round(metres)}\n")
        self.count += 1

    def way(self, w):
        t = w.tags
        if t.get("highway") not in ROADS:
            return
        try:
            nodes = [n.location for n in w.nodes]
            if len(nodes) < 2 or not all(n.valid() for n in nodes):
                return
        except osmium.InvalidLocationError:
            return
        oneway = t.get("oneway", "yes" if t.get("highway") in ("motorway", "motorway_link") or t.get("junction") in ("roundabout", "circular") else "no")
        # forward: the way's own direction; backward: against it
        fwd = t.get("turn:lanes:forward") or (t.get("turn:lanes") if oneway in ("yes", "true", "1") else None)
        back = t.get("turn:lanes:backward") or (t.get("turn:lanes") if oneway == "-1" else None)
        metres = sum(distance(a, b) for a, b in zip(nodes, nodes[1:]))
        if fwd and oneway != "-1":
            self.write(nodes[-2], nodes[-1], fwd, t.get("destination:lanes:forward") or t.get("destination:lanes"), metres)
        if back:
            self.write(nodes[1], nodes[0], back, t.get("destination:lanes:backward") or (t.get("destination:lanes") if oneway == "-1" else None), metres)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(dst + ".part", "w", encoding="utf-8") as out:
        h = Lanes(out)
        h.apply_file(src, locations=True)
    import os
    os.replace(dst + ".part", dst)
    print(f"{h.count} lane ends in {dst}")


if __name__ == "__main__":
    main()
