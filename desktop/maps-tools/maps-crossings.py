"""Tetra's map builder (mapbuild.js, step borders): where the roads cross between two neighbouring regions, so a route drives
on one country's graph to a crossing and goes on from there on the next one's (the user, 27 Oct: "Drive to the edge and then
start from the other edge"; "at the border … the main road … not through the fields"). Each Geofabrik region reaches a little
past its border, so a crossing is on both regions' roads.

A crossing is an official one: a barrier=border_control on a car road that both files hold. A border with none marked (inside
Schengen) takes its main roads (motorway to secondary) that both files hold instead. One point a crossing (about 2 km), the
biggest road's first, and up to four a crossing: a station's lanes are one way each, so the route's search tries them all and
the one it can drive straight through is the fastest (one point on the wrong side's lane turned the route round there). Usage: maps-crossings.py a.osm.pbf b.osm.pbf out.tsv — lat, lng, name, road, the crossing's number, a line each."""
import sys
import osmium

CAR = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service']
MAIN = CAR[:4]


def road(h):
    """A highway's rank among the car roads, a link just after its road, or None."""
    r = h.removesuffix('_link')
    return CAR.index(r) * 2 + (r != h) if r in CAR else None


def controls(f):
    return {n.id: (n.location.lat, n.location.lon, n.tags.get('name', ''))
            for n in osmium.FileProcessor(f, osmium.osm.NODE).with_filter(osmium.filter.TagFilter(('barrier', 'border_control')))}


def main(a, b, out):
    ca, cb = controls(a), controls(b)
    both = {i: v for i, v in ca.items() if i in cb}
    found = []  # (rank, lat, lng, name, highway)
    for w in osmium.FileProcessor(b, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway')):
        r = road(w.tags['highway'])
        if r is not None:
            found += [(r, *both[n.ref][:2], both[n.ref][2] or w.tags.get('name', ''), w.tags['highway']) for n in w.nodes if n.ref in both]
    if not found:  # an open border: the main roads both regions hold, each way's middle point
        mains = {w.id for w in osmium.FileProcessor(a, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway')) if road(w.tags['highway']) in range(8)}
        for w in osmium.FileProcessor(b).with_locations().with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)).with_filter(osmium.filter.KeyFilter('highway')):
            if w.id in mains and len(w.nodes):
                n = w.nodes[len(w.nodes) // 2]
                if n.location.valid():
                    found.append((road(w.tags['highway']), n.location.lat, n.location.lon, w.tags.get('name', ''), w.tags['highway']))
    found.sort()
    kept = []
    for c in found:  # the biggest road first; within ~2 km the same crossing, four points of it at most, each 15 m from the others
        near = [k for k in kept if abs(c[1] - k[1]) <= 0.02 and abs(c[2] - k[2]) <= 0.025]
        if len(near) < 4 and all(abs(c[1] - k[1]) > 0.00014 or abs(c[2] - k[2]) > 0.00018 for k in near):
            kept.append((*c, near[0][5] if near else 1 + max((k[5] for k in kept), default=0)))
    with open(out, 'w', encoding='utf-8') as f:
        for _, lat, lng, name, r, n in kept:
            f.write(f"{lat:.6f}\t{lng:.6f}\t{name.replace(chr(9), ' ')}\t{r}\t{n}\n")
    print(f"{len(kept)} points, {max((k[5] for k in kept), default=0)} crossings")


if __name__ == '__main__':
    main(*sys.argv[1:4])
