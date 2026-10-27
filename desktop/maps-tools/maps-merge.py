"""Tetra's map builder (mapbuild.js, step borders): two neighbouring regions' .osm.pbf files as one, sorted, each object once,
so GraphHopper builds one graph of their roads joined at the border. Streamed: little memory however big the regions
(the user, 27 Oct: "Break it into pieces"). Usage: maps-merge.py out.osm.pbf in1.osm.pbf in2.osm.pbf …"""
import sys
import osmium

with osmium.SimpleWriter(sys.argv[1], overwrite=True) as w:
    # the files side by side in id order; an object both hold (the border's nodes and ways) written once
    for objs in osmium.zip_processors(*(osmium.FileProcessor(f) for f in sys.argv[2:])):
        o = next(x for x in objs if x is not None)
        if o.is_node():
            w.add_node(o)
        elif o.is_way():
            w.add_way(o)
        else:
            w.add_relation(o)
