#!/usr/bin/env bash
# What the map builder runs, carried inside the AppImage (the user, 27 Oct: "If it was for the AppImage to need Ubuntu what
# is the point, we could have only deb"): a Java 17 runtime for GraphHopper and a Python with osmium for search, lanes and
# area codes, both built to run on any Linux with glibc 2.17 or newer. The .deb has neither: apt brings them (package.json
# build.deb.depends). Makes desktop/bundled/{jre,python}; downloads are kept in desktop/build-tools between builds.
# Usage: scripts/bundle-tools.sh   (from desktop/; run by `npm run dist` before the AppImage)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
CACHE=build-tools OUT=bundled
JDK_URL=https://api.adoptium.net/v3/binary/version/jdk-17.0.16%2B8/linux/x64/jdk/hotspot/normal/eclipse
PY_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.12.11+20250918-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
# GraphHopper 10.2's modules (jdeps --print-module-deps on its jar), and what logging, XML and zip need
MODULES=java.base,java.compiler,java.desktop,java.instrument,java.naming,java.scripting,java.security.jgss,java.sql,jdk.attach,jdk.jdi,jdk.management,jdk.unsupported,java.logging,java.xml,jdk.crypto.ec,jdk.zipfs
mkdir -p "$CACHE" "$OUT"

if [ ! -x "$OUT/jre/bin/java" ]; then
  [ -f "$CACHE/jdk.tar.gz" ] || { curl -fL -o "$CACHE/jdk.tar.gz.part" "$JDK_URL" && mv "$CACHE/jdk.tar.gz.part" "$CACHE/jdk.tar.gz"; }
  rm -rf "$CACHE/jdk" && mkdir -p "$CACHE/jdk" && tar xzf "$CACHE/jdk.tar.gz" -C "$CACHE/jdk" --strip-components=1
  rm -rf "$OUT/jre"
  "$CACHE/jdk/bin/jlink" --module-path "$CACHE/jdk/jmods" --add-modules "$MODULES" --strip-debug --no-header-files --no-man-pages \
    --compress=2 --output "$OUT/jre"
fi

if [ ! -x "$OUT/python/bin/python3" ]; then
  [ -f "$CACHE/python.tar.gz" ] || { curl -fL -o "$CACHE/python.tar.gz.part" "$PY_URL" && mv "$CACHE/python.tar.gz.part" "$CACHE/python.tar.gz"; }
  rm -rf "$OUT/python" && mkdir -p "$OUT/python" && tar xzf "$CACHE/python.tar.gz" -C "$OUT/python" --strip-components=1
  "$OUT/python/bin/python3" -I -m pip install -q --no-cache-dir --only-binary=:all: osmium
  # what a build never runs: tests, Tk, IDLE, pip itself, headers, static libraries, caches
  rm -rf "$OUT/python/lib/python3.12/test" "$OUT/python/lib/python3.12/idlelib" "$OUT/python/lib/python3.12/tkinter" \
    "$OUT/python/lib/python3.12/turtledemo" "$OUT/python/lib/python3.12/ensurepip" "$OUT/python/lib/python3.12/site-packages/pip" \
    "$OUT/python/lib/tcl"* "$OUT/python/lib/tk"* "$OUT/python/lib/itcl"* "$OUT/python/lib/libtcl"* "$OUT/python/lib/libtk"* "$OUT/python/include" \
    "$OUT/python/share"
  find "$OUT/python" -name '__pycache__' -prune -exec rm -rf {} + ; find "$OUT/python" -name '*.a' -delete
fi

"$OUT/jre/bin/java" -version 2>&1 | head -1
"$OUT/python/bin/python3" -I -c 'import osmium, sys; print("python", sys.version.split()[0], "osmium", osmium.__file__ and "ok")'
du -sh "$OUT/jre" "$OUT/python"
