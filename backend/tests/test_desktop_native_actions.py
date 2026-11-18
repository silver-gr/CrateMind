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


PLUGIN = "/Library/Audio/Plug-Ins/VST3/Fixture.vst3"
SLOTS = {"deck_a": None, "deck_b": None, "master": PLUGIN}
START = {"sample_rate": 48000, "slots": SLOTS}


def with_slots(**slots):
    return {**START, "slots": {**SLOTS, **slots}}


def test_master_host_actions_reach_the_native_shell_unchanged():
    c, protocol = client()
    sent = [
        ("master_host_scan", {}),
        ("master_host_stop", {}),
        ("master_host_start", START),
        # the native scan matches the extension in any case
        ("master_host_start", with_slots(deck_a="/Library/Audio/Plug-Ins/VST3/Upper.VST3", master=None)),
        ("master_host_start", with_slots(deck_a=PLUGIN, deck_b=PLUGIN)),
        ("master_host_start", {**with_slots(deck_b=PLUGIN), "sample_rate": 384000}),
    ]
    for slot in ("deck_a", "deck_b", "master"):
        sent += [("master_host_editor", {"slot": slot}),
                 ("master_host_bypass", {"slot": slot, "bypassed": True}),
                 ("master_host_bypass", {"slot": slot, "bypassed": False})]
    for action, arguments in sent:
        response = c.post("/api/desktop/native-actions", json={"action": action, "arguments": arguments})
        assert response.status_code == 200, (action, arguments, response.text)
    assert protocol.calls == sent


@pytest.mark.parametrize("arguments", [
    {},
    {"slots": SLOTS},
    {"sample_rate": 48000},
    {"path": PLUGIN, "sample_rate": 48000},  # the single-plugin shape before the slots
    {**START, "path": PLUGIN},
    {**START, "command": "sh"},
    {**START, "sample_rate": True},
    {**START, "sample_rate": 48000.0},
    {**START, "sample_rate": "48000"},
    {**START, "sample_rate": 1000},
    {**START, "sample_rate": 384001},
    {**START, "slots": None},
    {**START, "slots": [None, None, PLUGIN]},
    {**START, "slots": PLUGIN},
    {**START, "slots": {"deck_a": None, "master": PLUGIN}},
    {**START, "slots": {**SLOTS, "deck_c": None}},
    {**START, "slots": {"A": PLUGIN, "deck_b": None, "master": None}},
    with_slots(master=None),
    with_slots(deck_a=7),
    with_slots(deck_a=True),
    with_slots(deck_a=""),
    with_slots(deck_a=[PLUGIN]),
    with_slots(deck_a="/Library/Audio/Plug-Ins/Components/Fixture.component"),
    with_slots(deck_b="/x/" + "a" * 4096 + ".vst3"),
    with_slots(master="/Library/Audio/Plug-Ins/VST3/Fixture.vst3/../../../../../bin/sh"),
])
def test_master_host_start_rejects_malformed_arguments(arguments):
    c, protocol = client()
    response = c.post("/api/desktop/native-actions", json={"action": "master_host_start", "arguments": arguments})
    assert response.status_code == 422
    assert protocol.calls == []


def test_master_host_start_accepts_a_path_at_the_length_limit():
    c, protocol = client()
    longest = "/x/" + "a" * (4096 - len("/x/.vst3")) + ".vst3"
    assert len(longest) == 4096
    arguments = with_slots(deck_a=longest)
    assert c.post("/api/desktop/native-actions", json={"action": "master_host_start", "arguments": arguments}).status_code == 200
    assert protocol.calls == [("master_host_start", arguments)]


@pytest.mark.parametrize("arguments", [
    {},
    {"slot": "A"},
    {"slot": "Deck A"},
    {"slot": "DECK_A"},
    {"slot": None},
    {"slot": 0},
    {"slot": ["deck_a"]},
    {"slot": "deck_a", "path": PLUGIN},
    {"path": "/"},
])
def test_master_host_editor_rejects_a_bad_or_missing_slot(arguments):
    c, protocol = client()
    response = c.post("/api/desktop/native-actions", json={"action": "master_host_editor", "arguments": arguments})
    assert response.status_code == 422
    assert protocol.calls == []


@pytest.mark.parametrize("arguments", [
    {},
    {"slot": "deck_a"},
    {"bypassed": True},
    {"slot": "A", "bypassed": True},
    {"slot": "deck_c", "bypassed": True},
    {"slot": {"deck_a": 1}, "bypassed": True},
    {"slot": "deck_a", "bypassed": 1},
    {"slot": "deck_a", "bypassed": 0},
    {"slot": "deck_a", "bypassed": "true"},
    {"slot": "deck_a", "bypassed": None},
    {"slot": "deck_a", "bypassed": True, "extra": 1},
])
def test_master_host_bypass_rejects_malformed_arguments(arguments):
    c, protocol = client()
    response = c.post("/api/desktop/native-actions", json={"action": "master_host_bypass", "arguments": arguments})
    assert response.status_code == 422
    assert protocol.calls == []


@pytest.mark.parametrize("action", ["master_host_scan", "master_host_stop"])
def test_master_host_argument_free_actions_reject_arguments(action):
    c, protocol = client()
    for arguments in ({"path": "/"}, {"slot": "master"}):
        response = c.post("/api/desktop/native-actions", json={"action": action, "arguments": arguments})
        assert response.status_code == 422
    assert protocol.calls == []


def test_reveal_recording_resolves_only_recording_files_in_the_export_folder(tmp_path, monkeypatch):
    import app.config as cfg

    out = tmp_path / "out"
    out.mkdir()
    (out / "CrateMind-recording-2026-11-17_23-40.wav").write_bytes(b"RIFF")
    (out / "CrateMind-recording-2026-11-17_23-40-2.m4a").write_bytes(b"ftyp")
    (out / "other.wav").write_bytes(b"RIFF")
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(out))
    cfg.get_settings.cache_clear()
    c, protocol = client()
    ok = c.post("/api/desktop/native-actions", json={"action": "reveal_path",
                                                      "arguments": {"recording": "CrateMind-recording-2026-11-17_23-40.wav"}})
    assert ok.status_code == 200, ok.text
    assert protocol.calls == [("reveal_path", {"path": str((out / "CrateMind-recording-2026-11-17_23-40.wav").resolve())})]
    (out / "CrateMind-recording-2026-11-17_23-41.wav").symlink_to(out / "other.wav")
    for name, status in (("other.wav", 422), ("../CrateMind-recording-2026-11-17_23-40.wav", 422),
                         ("CrateMind-recording-2026-11-17_23-40.wav\x00", 422), ("CrateMind-recording-a:b.wav", 422),
                         ("CrateMind-recording-2026-11-17_23-41.wav", 404), ("CrateMind-recording-2026-11-17_23-42-2.wav", 404),
                         (7, 422)):
        response = c.post("/api/desktop/native-actions", json={"action": "reveal_path", "arguments": {"recording": name}})
        assert response.status_code == status, (name, response.text)
    assert len(protocol.calls) == 1
    aac = c.post("/api/desktop/native-actions", json={"action": "reveal_path",
                                                       "arguments": {"recording": "CrateMind-recording-2026-11-17_23-40-2.m4a"}})
    assert aac.status_code == 200 and len(protocol.calls) == 2
    cfg.get_settings.cache_clear()


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
