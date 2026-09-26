import sys
import tempfile
from pathlib import Path
from PIL import Image, ExifTags

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from photo_info import location

with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / "δοκιμή.jpg"
    image = Image.new("RGB", (12, 12))
    image.save(path)
    assert location(path) == {}
    exif = Image.Exif()
    exif[ExifTags.IFD.GPSInfo] = {1: "N", 2: (37.0, 30.0, 0.0), 3: "W", 4: (23.0, 15.0, 0.0)}
    image.save(path, exif=exif)
    assert location(path) == {"latitude": 37.5, "longitude": -23.25}
    exif[ExifTags.IFD.GPSInfo] = {1: "N", 2: (999.0, 0.0, 0.0), 3: "E", 4: (23.0, 0.0, 0.0)}
    image.save(path, exif=exif)
    try:
        location(path)
        raise AssertionError("Invalid latitude accepted")
    except ValueError:
        pass
print("Photo GPS metadata checks passed")
