"""Create a verified, read-only photo-library snapshot. Python 3.14+, Linux."""
import ctypes
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import uuid
import zipfile

CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp"}


def _entry_path(value, library):
    path = PurePosixPath(value)
    if not isinstance(value, str) or not value.startswith(library + "/") or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("Archive contains an unsafe entry path")
    return path


def _manifest(archive_path):
    target = Path(archive_path).resolve(strict=True)
    if not target.is_file() or target.suffix != ".ldrive":
        raise ValueError("Choose an existing .ldrive archive")
    with zipfile.ZipFile(target) as archive:
        try:
            manifest = json.loads(archive.read("manifest.json"))
        except (KeyError, json.JSONDecodeError) as error:
            raise ValueError("Archive manifest is unreadable") from error
        library = manifest.get("library", "Photos")
        if manifest.get("format") not in ("local-drive-library", "local-drive-photo-library") or manifest.get("version") != 1 or manifest.get("readOnly") is not True or library not in ("Photos", "Drive") or not isinstance(manifest.get("entries"), list):
            raise ValueError("Archive format is unsupported")
        entries = []
        seen = set()
        for item in manifest["entries"]:
            if not isinstance(item, dict) or not isinstance(item.get("size"), int) or item["size"] < 0 or not isinstance(item.get("modifiedNs"), int) or not isinstance(item.get("sha256"), str) or len(item["sha256"]) != 64:
                raise ValueError("Archive manifest entry is invalid")
            path = _entry_path(item.get("path"), library)
            if str(path) in seen:
                raise ValueError("Archive manifest contains duplicate paths")
            seen.add(str(path))
            try:
                info = archive.getinfo(str(path))
            except KeyError as error:
                raise ValueError("Archive entry is missing") from error
            if info.is_dir() or info.file_size != item["size"]:
                raise ValueError("Archive entry differs from its manifest")
            entries.append({"path": str(path), "size": item["size"], "modifiedNs": item["modifiedNs"], "sha256": item["sha256"].lower()})
    return target, library, entries


def index(archive_path):
    target, library, entries = _manifest(archive_path)
    items = []
    for entry in entries:
        relative = PurePosixPath(entry["path"]).relative_to(library)
        suffix = relative.suffix.lower()
        kind = "Photo" if suffix in PHOTO_EXTENSIONS else "Video" if suffix in VIDEO_EXTENSIONS else "Other"
        items.append({"path": str(relative), "name": relative.name, "collection": relative.parts[0] if len(relative.parts) > 1 else "Unsorted", "type": kind, "size": entry["size"], "modified": datetime.fromtimestamp(entry["modifiedNs"] / 1_000_000_000, UTC).isoformat(), "dateSource": "Archive snapshot", "sha256": entry["sha256"]})
    return {"state": "ready", "archive": str(target), "library": library, "readOnly": True, "items": items}


def _trim_cache(root, keep):
    # ponytail: single-process LRU cleanup; add a lock only if archive reads become concurrent.
    files = [path for path in root.rglob("*") if path.is_file() and path != keep]
    total = sum(path.stat().st_size for path in files) + (keep.stat().st_size if keep.exists() else 0)
    for path in sorted(files, key=lambda value: value.stat().st_mtime_ns):
        if total <= CACHE_LIMIT_BYTES:
            break
        size = path.stat().st_size
        path.unlink(missing_ok=True)
        total -= size


def extract(archive_path, relative_path, cache_root):
    target, library, entries = _manifest(archive_path)
    entry_path = _entry_path(library + "/" + relative_path, library)
    entry = next((item for item in entries if item["path"] == str(entry_path)), None)
    if entry is None:
        raise ValueError("Archive item is unavailable")
    root = Path(cache_root).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive_stat = target.stat()
    archive_id = hashlib.sha256(f"{target}:{archive_stat.st_dev}:{archive_stat.st_ino}:{archive_stat.st_size}:{archive_stat.st_mtime_ns}".encode()).hexdigest()
    destination_dir = root / archive_id
    destination_dir.mkdir(mode=0o700, exist_ok=True)
    suffix = PurePosixPath(relative_path).suffix[:20]
    destination = destination_dir / f"{entry['sha256']}{suffix}"
    if destination.is_file() and destination.stat().st_size == entry["size"]:
        os.utime(destination, None)
        _trim_cache(root, destination)
        return {"state": "cached", "path": str(destination), "size": entry["size"]}
    temporary = destination_dir / f".{entry['sha256']}.{uuid.uuid4().hex}.partial"
    try:
        with zipfile.ZipFile(target) as archive, archive.open(entry["path"]) as incoming, open(temporary, "xb") as output:
            digest = hashlib.sha256()
            while chunk := incoming.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if temporary.stat().st_size != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise RuntimeError("Archive item failed SHA-256 verification")
        try:
            os.link(temporary, destination)
        except FileExistsError:
            if not destination.is_file() or destination.stat().st_size != entry["size"]:
                raise RuntimeError("Archive cache entry changed")
        _trim_cache(root, destination)
        return {"state": "cached", "path": str(destination), "size": entry["size"]}
    finally:
        temporary.unlink(missing_ok=True)


def export(source, destination, name, library="Photos", progress=lambda event: None):
    if not hasattr(zipfile, "ZIP_ZSTANDARD"):
        raise RuntimeError("Photo export requires Python 3.14 with Zstandard support")
    if library not in ("Photos", "Drive") or not name.endswith(".ldrive") or Path(name).name != name or name.startswith("."):
        raise ValueError("Choose a .ldrive filename")
    root = Path(source).resolve(strict=True)
    target_dir = Path(destination).resolve(strict=True)
    if target_dir == root or root in target_dir.parents:
        raise ValueError("Export storage must be outside the active Photos folder")
    directory = os.open(target_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = f".{name}.{uuid.uuid4().hex}.partial"
    created = False
    try:
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("Destination exists; nothing was replaced")
        entries = []
        for parent, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for part in dirs + files:
                if (Path(parent) / part).is_symlink():
                    raise ValueError("Resolve symbolic links before exporting this library")
            for file in sorted(files):
                if not file.startswith("."):
                    entries.append(Path(parent) / file)
        if not entries:
            raise ValueError("The Photos library is empty")
        manifest = {"format": "local-drive-library", "version": 1, "library": library, "readOnly": True, "entries": []}
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        created = True
        with os.fdopen(fd, "w+b") as output:
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_ZSTANDARD, compresslevel=3, allowZip64=True) as archive:
                for index, path in enumerate(entries):
                    # Resolve parent components again; a moved/replaced source aborts rather than escaping Photos.
                    if not path.resolve(strict=True).is_relative_to(root):
                        raise ValueError("Source location changed during export")
                    source_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(source_fd, "rb") as incoming:
                        before = os.fstat(incoming.fileno())
                        if not stat.S_ISREG(before.st_mode):
                            raise ValueError("Only regular files can be exported")
                        relative = library + "/" + path.relative_to(root).as_posix()
                        digest = hashlib.sha256()
                        with archive.open(relative, "w", force_zip64=True) as outgoing:
                            while chunk := incoming.read(1024 * 1024):
                                outgoing.write(chunk)
                                digest.update(chunk)
                        after = os.fstat(incoming.fileno())
                        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                            raise RuntimeError("Source changed during export; retry after edits finish")
                        manifest["entries"].append({"path": relative, "size": before.st_size, "modifiedNs": before.st_mtime_ns, "sha256": digest.hexdigest()})
                    progress({"state": "copying", "filesDone": index + 1, "filesTotal": len(entries)})
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
            output.flush()
            os.fsync(output.fileno())
            output.seek(0)
            with zipfile.ZipFile(output) as archive:
                for index, entry in enumerate(manifest["entries"]):
                    digest = hashlib.sha256()
                    with archive.open(entry["path"]) as restored:
                        while chunk := restored.read(1024 * 1024):
                            digest.update(chunk)
                    if digest.hexdigest() != entry["sha256"]:
                        raise RuntimeError("Archive verification failed")
                    progress({"state": "verifying", "filesDone": index + 1, "filesTotal": len(entries)})
        # Linux atomic no-replace publication also works on filesystems without hard links.
        rename = ctypes.CDLL(None, use_errno=True).renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        if rename(directory, os.fsencode(temporary), directory, os.fsencode(name), 1) != 0:
            raise OSError(ctypes.get_errno(), "Could not publish archive; destination may already exist")
        created = False
        os.fsync(directory)
        return {"state": "transferred", "path": str(target_dir / name), "files": len(entries), "result": f"{library} archive exported and SHA-256 verified. Originals were kept."}
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


if __name__ == "__main__":
    def report(event):
        print(json.dumps(event), flush=True)
    try:
        command = sys.argv[1]
        if command == "export":
            report(export(*sys.argv[2:6], progress=report))
        elif command == "index":
            report(index(sys.argv[2]))
        elif command == "extract":
            report(extract(sys.argv[2], sys.argv[3], sys.argv[4]))
        else:
            raise ValueError("Unknown archive command")
    except Exception as error:
        report({"state": "failed", "result": str(error)})
        sys.exit(1)
