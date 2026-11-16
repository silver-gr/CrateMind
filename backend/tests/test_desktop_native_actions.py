import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.desktop_runtime.native_actions import router
from app.desktop_runtime.protocol import load_desktop_init


class FakeProtocol:
    def __init__(self):
        self.calls = []

    def request(self, action, arguments):
        self.calls.append((action, arguments))
        return {"canceled": False, "value": None}


def client():
    app = FastAPI()
    app.include_router(router)
    app.state.parent_protocol = FakeProtocol()
    return TestClient(app), app.state.parent_protocol


START = {"path": "/Library/Audio/Plug-Ins/VST3/Fixture.vst3", "sample_rate": 48000}


def test_master_host_actions_reach_the_native_shell_unchanged():
    c, protocol = client()
    for action in ("master_host_scan", "master_host_stop", "master_host_editor"):
        assert c.post("/api/desktop/native-actions", json={"action": action}).status_code == 200
    assert c.post("/api/desktop/native-actions", json={"action": "master_host_start", "arguments": START}).status_code == 200
    upper = {**START, "path": "/Library/Audio/Plug-Ins/VST3/Upper.VST3"}  # the native scan matches the extension in any case
    assert c.post("/api/desktop/native-actions", json={"action": "master_host_start", "arguments": upper}).status_code == 200
    assert protocol.calls == [("master_host_scan", {}), ("master_host_stop", {}), ("master_host_editor", {}),
                              ("master_host_start", START), ("master_host_start", upper)]


@pytest.mark.parametrize("arguments", [
    {},
    {"path": START["path"]},
    {**START, "sample_rate": True},
    {**START, "sample_rate": 48000.0},
    {**START, "sample_rate": "48000"},
    {**START, "sample_rate": 1000},
    {**START, "path": 7},
    {**START, "path": ""},
    {**START, "path": "/Library/Audio/Plug-Ins/Components/Fixture.component"},
    {**START, "path": "/x/" + "a" * 4096 + ".vst3"},
    {**START, "command": "sh"},
])
def test_master_host_start_rejects_malformed_arguments(arguments):
    c, protocol = client()
    response = c.post("/api/desktop/native-actions", json={"action": "master_host_start", "arguments": arguments})
    assert response.status_code == 422
    assert protocol.calls == []


@pytest.mark.parametrize("action", ["master_host_scan", "master_host_stop", "master_host_editor"])
def test_master_host_argument_free_actions_reject_arguments(action):
    c, protocol = client()
    response = c.post("/api/desktop/native-actions", json={"action": action, "arguments": {"path": "/"}})
    assert response.status_code == 422
    assert protocol.calls == []


def test_unknown_master_host_action_is_refused():
    c, protocol = client()
    assert c.post("/api/desktop/native-actions", json={"action": "master_host_stats"}).status_code == 422
    assert protocol.calls == []


def init_record(tmp_path, **extra):
    tools = {}
    for name in ("ffmpeg", "ffprobe", "fpcalc"):
        tools[name] = str(tmp_path / name)
        (tmp_path / name).write_bytes(b"fixture")
    record = {"protocol_version": 1, "runtime_profile": "desktop-core", "launch_id": "a" * 32,
              "session_secret": "s" * 64, "paths": {"app_data": str(tmp_path), "resources": str(tmp_path)},
              "tools": tools, **extra}
    return io.StringIO(json.dumps(record) + "\n")


def test_init_record_master_host_port_is_optional_and_an_int_in_range(tmp_path):
    assert "master_host_port" not in load_desktop_init(init_record(tmp_path))
    assert load_desktop_init(init_record(tmp_path, master_host_port=5123))["master_host_port"] == 5123
    for bad in (True, "5123", 0, 65536, 5123.0):
        with pytest.raises(ValueError):
            load_desktop_init(init_record(tmp_path, master_host_port=bad))
