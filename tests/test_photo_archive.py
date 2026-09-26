import importlib.util
import json
from pathlib import Path
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("photo_archive", Path(__file__).parents[1] / "src/photo_archive.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    source, destination = root / "Photos", root / "disk"
    source.mkdir(); destination.mkdir()
    (source / "εικόνα.jpg").write_bytes(b"test image bytes" * 100)
    result = module.export(source, destination, "test.ldrive")
    assert result["state"] == "transferred"
    with zipfile.ZipFile(destination / "test.ldrive") as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["readOnly"] is True and manifest["library"] == "Photos"
        assert archive.read("Photos/εικόνα.jpg") == (source / "εικόνα.jpg").read_bytes()
        assert archive.getinfo("Photos/εικόνα.jpg").compress_type == zipfile.ZIP_ZSTANDARD
    listing = module.index(destination / "test.ldrive")
    assert listing["readOnly"] is True
    item = listing["items"][0]
    assert {key: item[key] for key in ("path", "name", "collection", "type", "size", "dateSource")} == {"path": "εικόνα.jpg", "name": "εικόνα.jpg", "collection": "Unsorted", "type": "Photo", "size": (source / "εικόνα.jpg").stat().st_size, "dateSource": "Archive snapshot"}
    assert len(item["sha256"]) == 64 and item["modified"]
    cache = root / "cache"
    extracted = module.extract(destination / "test.ldrive", "εικόνα.jpg", cache)
    assert Path(extracted["path"]).read_bytes() == (source / "εικόνα.jpg").read_bytes()
    assert module.extract(destination / "test.ldrive", "εικόνα.jpg", cache)["state"] == "cached"
    drive = root / "Drive"; drive.mkdir(); (drive / "notes.txt").write_text("same words " * 100, encoding="utf-8")
    drive_result = module.export(drive, destination, "files.ldrive", "Drive")
    assert drive_result["state"] == "transferred" and module.index(destination / "files.ldrive")["library"] == "Drive"
    assert Path(module.extract(destination / "files.ldrive", "notes.txt", cache)["path"]).read_text(encoding="utf-8") == "same words " * 100
    original = (destination / "test.ldrive").read_bytes()
    try:
        module.export(source, destination, "test.ldrive")
        raise AssertionError("Existing archive was not rejected")
    except FileExistsError:
        pass
    assert (destination / "test.ldrive").read_bytes() == original
    (source / "link.jpg").symlink_to(destination / "test.ldrive")
    try:
        module.export(source, destination, "linked.ldrive")
        raise AssertionError("Symlink was not rejected")
    except ValueError:
        pass
    assert not (destination / "linked.ldrive").exists()
    assert not list(destination.glob("*.partial"))
print("Photo archive: content, Zstandard, manifest, collision and symlink checks passed")
