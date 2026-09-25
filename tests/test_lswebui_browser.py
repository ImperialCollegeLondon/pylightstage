"""Execute browser regressions in Firefox without a JS build or test dependency."""

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

pytestmark = pytest.mark.unit
STATIC = Path(__file__).parents[1] / "src/pylightstage/lswebui/static"


def test_browser_regressions(tmp_path):
    firefox = shutil.which("firefox")
    if firefox is None:
        pytest.skip("Firefox is required for browser regression tests")
    completed = threading.Event()
    results = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                body = b'<script type="module" src="/tests.js"></script>'
                content_type = "text/html"
            elif self.path == "/tests.js":
                body = Path(__file__).with_suffix(".js").read_bytes()
                content_type = "text/javascript"
            else:
                relative = self.path.removeprefix("/assets/").removeprefix("/")
                path = STATIC / relative
                if not path.is_file() or not path.resolve().is_relative_to(
                    STATIC.resolve()
                ):
                    self.send_error(404)
                    return
                body = path.read_bytes()
                content_type = (
                    "text/html" if path.suffix == ".html" else "text/javascript"
                )
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            results.append(
                json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            )
            self.send_response(204)
            self.end_headers()
            completed.set()

        def log_message(self, *_):
            pass

    # Snap-packaged Firefox has a private /tmp; keep its profile in the workspace.
    with (
        TemporaryDirectory(prefix="browser-test-", dir=Path.cwd()) as profile,
        ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server,
    ):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with (tmp_path / "firefox.log").open("w+") as log:
            process = subprocess.Popen(
                [
                    firefox,
                    "--headless",
                    "--no-remote",
                    "--profile",
                    str(profile),
                    f"http://127.0.0.1:{server.server_port}/",
                ],
                stdout=log,
                stderr=log,
            )
            try:
                finished = completed.wait(30)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                server.shutdown()
                thread.join(timeout=2)
            log.seek(0)
            assert finished, f"Browser did not report results:\n{log.read()}"
    assert results
    assert results[0]["failures"] == []
    assert results[0]["passed"] >= 10
