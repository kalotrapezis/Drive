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
        assert manifest["readOnly"] is True
        assert archive.read("Photos/εικόνα.jpg") == (source / "εικόνα.jpg").read_bytes()
        assert archive.getinfo("Photos/εικόνα.jpg").compress_type == zipfile.ZIP_ZSTANDARD
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
