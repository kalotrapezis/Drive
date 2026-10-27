"""Tetra's map builder (mapbuild.js, step borders): several regions' .osm.pbf files as one, sorted, each object once, so
GraphHopper builds one graph of their roads joined at the borders. Usage: maps-merge.py out.osm.pbf in1.osm.pbf in2.osm.pbf …"""
import sys
import osmium

r = osmium.MergeInputReader()
for f in sys.argv[2:]:
    r.add_file(f)
w = osmium.WriteHandler(sys.argv[1])
r.apply(w, simplify=True)  # simplify: a node or way both files hold (the border's) written once
w.close()
