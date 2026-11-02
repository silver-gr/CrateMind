"""Real subprocess HTTP/stdio lifecycle and complete handoff on generated data."""
import http.client
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from app.library_exchange import operations as exchange
from app.services.active_dataset import resolve_active_dataset

BACKEND = Path(__file__).resolve().parents[1]


class DesktopProcess:
    def __init__(self, root, resources):
        self.root = root
        self.init = {"protocol_version": 1, "launch_id": uuid.uuid4().hex,
            "session_secret": uuid.uuid4().hex + uuid.uuid4().hex,
            "paths": {"app_data": str(root), "resources": str(resources)},
            "tools": {name: sys.executable for name in ("ffmpeg", "ffprobe", "fpcalc")},
            "runtime_profile": "desktop-core"}
        self.events, self.errors = queue.Queue(), []
        env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
        self.process = subprocess.Popen([sys.executable, "-m", "app.desktop_runtime.bootstrap"],
            cwd=BACKEND, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def stdout():
            for line in self.process.stdout:
                self.events.put(json.loads(line))
        def stderr():
            for line in self.process.stderr:
                self.errors.append(line)
        threading.Thread(target=stdout, daemon=True).start()
        threading.Thread(target=stderr, daemon=True).start()
        self.send(self.init)
        try:
            record = self.events.get(timeout=15)
            assert record["type"] == "BOUND", record
            self.port = record["port"]
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    if self.request("GET", "/api/desktop/health", native=True)[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(.05)
            else:
                raise AssertionError("Health timeout: " + "".join(self.errors))
        except BaseException:
            self.stop()
            raise

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def request(self, method, path, body=None, *, native=False, upload=None, authenticated=True):
        headers = {}
        if authenticated:
            headers = {"Cookie": f"cratemind_{self.init['launch_id']}={self.init['session_secret']}",
                       "Origin": f"http://127.0.0.1:{self.port}"}
        if native:
            headers = {"X-CrateMind-Desktop-Secret": self.init["session_secret"]}
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        if upload is not None:
            boundary = uuid.uuid4().hex
            headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="state.cmexchange"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode() + upload.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            value = response.read()
            if response.getheader("content-type", "").startswith("application/json"):
                value = json.loads(value)
            return response.status, value
        finally:
            connection.close()

    def stop(self):
        if self.process.poll() is None:
            if not self.process.stdin.closed:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()


@contextmanager
def desktop(root, resources):
    process = DesktopProcess(root, resources)
    try:
        yield process
    finally:
        process.stop()


def test_real_desktop_handoff_helper_and_restart_preserve_all_state(tmp_path):
    import sqlite3
    resources = tmp_path / "resources"
    (resources / "frontend").mkdir(parents=True)
    (resources / "frontend/index.html").write_text('<html lang="el"><body>Δοκιμή</body></html>')
    a, b = tmp_path / "web", tmp_path / "desktop"
    original = exchange.initialize_empty(a)
    with sqlite3.connect(original.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('web tag')")
    baseline = exchange.export_exchange(a, tmp_path / "S0.cmexchange")
    exchange.apply_import(exchange.prepare_import(baseline.path, b), b)
    with desktop(b, resources) as process:
        assert process.request("GET", "/api/capabilities", authenticated=False)[0] == 403
        status, caps = process.request("GET", "/api/capabilities")
        assert status == 200 and caps["analysis"] is True
        assert process.request("GET", "/api/unknown")[0] == 404
        assert process.request("PATCH", "/api/desktop/preferences", {"cratemind-theme": "light"})[0] == 200
        assert process.request("POST", "/api/tags", {"name": "desktop tag"})[0] == 200
        status, exported = process.request("POST", "/api/exchange/export", {})
        assert status == 200, exported
        sent = Path(exported["path"])
        exchange.apply_import(exchange.prepare_import(sent, a), a)
        with sqlite3.connect(resolve_active_dataset(a).catalog_path) as db:
            assert db.execute("SELECT count(*) FROM tags").fetchone()[0] == 2
            db.execute("INSERT INTO tags(name) VALUES('web return')")
        returned = exchange.export_exchange(a, tmp_path / "S2.cmexchange")
        status, preview = process.request("POST", "/api/exchange/inspect", upload=returned.path)
        assert status == 200 and preview["status"] == "ready", preview
        record = process.events.get(timeout=5)
        assert record["type"] == "EXCHANGE_PREPARED"
        status, body = process.request("POST", "/api/desktop/exchange/commit",
                                       {"preview_id": preview["preview_id"], "decision": "import"})
        assert status == 202, body
        assert process.events.get(timeout=5)["action"] == "apply_exchange"
        # Admission stays closed between the completed 202 and intentional exit.
        assert process.request("POST", "/api/tags", {"name": "must not write"})[0] == 409
        process.stop()
        assert process.process.returncode == 0, process.errors
        helper = subprocess.run([sys.executable, "-m", "app.desktop_runtime.bootstrap",
                                 "--desktop-helper", "apply-exchange", "--preview-id", preview["preview_id"],
                                 "--decision", "import"], input=json.dumps(process.init) + "\n",
                                cwd=BACKEND, capture_output=True, text=True, timeout=15)
        assert helper.returncode == 0, helper.stderr
        assert json.loads(helper.stdout)["ok"]
    with desktop(b, resources) as restarted:
        assert restarted.request("GET", "/api/desktop/preferences")[1]["cratemind-theme"] == "light"
        assert {row["name"] for row in restarted.request("GET", "/api/tags")[1]} == {"web tag", "desktop tag", "web return"}
    assert restarted.process.returncode == 0
