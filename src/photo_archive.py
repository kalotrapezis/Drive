"""Create a verified, read-only photo-library snapshot. Python 3.14+, Linux."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid
import zipfile


def export(source, destination, name, progress=lambda event: None):
    if not hasattr(zipfile, "ZIP_ZSTANDARD"):
        raise RuntimeError("Photo export requires Python 3.14 with Zstandard support")
    if not name.endswith(".ldrive") or Path(name).name != name or name.startswith("."):
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
        manifest = {"format": "local-drive-photo-library", "version": 1, "readOnly": True, "entries": []}
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
                        relative = "Photos/" + path.relative_to(root).as_posix()
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
        return {"state": "transferred", "path": str(target_dir / name), "files": len(entries), "result": "Photo library exported and SHA-256 verified. Originals were kept."}
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


if __name__ == "__main__":
    def report(event):
        print(json.dumps(event), flush=True)
    try:
        report(export(*sys.argv[1:4], progress=report))
    except Exception as error:
        report({"state": "failed", "result": str(error)})
        sys.exit(1)
