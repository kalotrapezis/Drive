"""Read GPS locally; missing GPS is not a guessed location."""
import json
import math
import sys
from PIL import Image, ExifTags


def location(path):
    with Image.open(path) as image:
        gps = image.getexif().get_ifd(ExifTags.IFD.GPSInfo)
    if not all(key in gps for key in (1, 2, 3, 4)):
        return {}
    def degrees(values):
        if len(values) != 3:
            raise ValueError("Invalid GPS metadata")
        d, m, s = map(float, values)
        if not all(math.isfinite(x) and x >= 0 for x in (d, m, s)) or m >= 60 or s >= 60:
            raise ValueError("Invalid GPS metadata")
        return d + m / 60 + s / 3600
    latitude, longitude = degrees(gps[2]), degrees(gps[4])
    if gps[1] not in ("N", "S") or gps[3] not in ("E", "W") or latitude > 90 or longitude > 180:
        raise ValueError("Invalid GPS metadata")
    return {"latitude": -latitude if gps[1] == "S" else latitude,
            "longitude": -longitude if gps[3] == "W" else longitude}


if __name__ == "__main__":
    try:
        print(json.dumps(location(sys.argv[1]), allow_nan=False))
    except Exception:
        print(json.dumps({"error": "Image location metadata could not be read"}))
