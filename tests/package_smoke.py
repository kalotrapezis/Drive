"""Run against an extracted .deb's usr directory, without touching the real catalog."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

root = Path(sys.argv[1]).resolve()
binary = root / "bin/local-drive"
assert binary.is_file() and (root / "share/local-drive/web/index.html").is_file()
with socket.socket() as check:
    assert check.connect_ex(("127.0.0.1", 43172)) != 0, "Quit the existing backend before this test"

with tempfile.TemporaryDirectory(prefix="local-drive-package-test-") as folder:
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen", XDG_DATA_HOME=folder + "/data", XDG_CONFIG_HOME=folder + "/config")
    assert "0.1.0-alpha.2" in subprocess.check_output([binary, "--version"], env=env, text=True)
    process = subprocess.Popen([binary, "--web-only"], cwd=folder, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    def get(path, headers=None):
        with urlopen(Request("http://127.0.0.1:43172" + path, headers=headers or {}), timeout=3) as response:
            return response.read(), response.headers.get("Content-Type", "")
    try:
        for attempt in range(100):
            try:
                health = json.loads(get("/api/v1/health")[0]); break
            except (URLError, TimeoutError):
                assert process.poll() is None, "Backend exited during startup"
                time.sleep(.1)
        else:
            raise AssertionError("Backend did not start")
        assert health["application"] == "local-drive" and health["appVersion"] == "0.1.0-alpha.2" and health["userId"] == os.geteuid()
        html, mime = get("/")
        assert "text/html" in mime and b'@vite/client' not in html
        assets = re.findall(rb'(?:src|href)="(/assets/[^\"]+)"', html)
        assert assets, "No compiled assets in packaged UI"
        for asset in assets:
            data, mime = get(asset.decode())
            assert data and ("javascript" in mime or "css" in mime or "image/" in mime)
        assert isinstance(json.loads(get("/api/v1/state")[0])["routes"], list)
        for path, headers, expected in [("/api/v1/session", {"Host": "evil.example"}, 403),
                                        ("/api/v1/session", {"Origin": "https://evil.example"}, 403),
                                        ("/api/v1/missing", {}, 404), ("/%2e%2e/etc/passwd", {}, 404)]:
            try:
                get(path, headers)
                raise AssertionError("Unsafe/missing request accepted")
            except HTTPError as error:
                assert error.code == expected, (path, error.code)
        print("PASS: extracted Alpha package, isolated catalog, compiled UI/assets, API identity and security checks")
    finally:
        process.terminate()
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate()
