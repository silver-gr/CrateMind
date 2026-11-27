"""library_paths gaps: config shape validation, lookup keys, root labels, re-enrolment, and scans over
switched-off roots or source-ambiguous rows. Generated folders only; no production data."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import select

from app.models import Track
from app.services import library_paths as paths
from tests.conftest import make_wav


@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    from app import config

    for name in ("CRATEMIND_IDENTITY_DB_PATH", "CRATEMIND_DATASET_ROOT"):
        monkeypatch.delenv(name, raising=False)
    for name, value in {
        "DB_PATH": tmp_path / "catalog.sqlite", "BACKUP_DIR": tmp_path / "backups",
        "OUTPUT_DIR": tmp_path / "exports", "LIBRARY_ROOTS": tmp_path / "unused-library",
        "PATH_MAPPINGS_FILE": "", "RUNTIME_PROFILE": "web",
        "RECCOBEATS_ENABLED": "false", "GETSONGBPM_ENABLED": "false",
        "ESSENTIA_ENABLED": "false", "CYANITE_ENABLED": "false",
    }.items():
        monkeypatch.setenv("CRATEMIND_" + name, str(value))
    config.get_settings.cache_clear()
    paths._read_mappings.cache_clear()
    yield
    config.get_settings.cache_clear()
    paths._read_mappings.cache_clear()


def _mapping(local, logical="/origin/Music", flavor="posix", key="stable-library", **changes):
    return {"root_key": key, "logical_prefix": logical, "logical_flavor": flavor,
            "local_prefix": str(local) if local is not None else None, "enabled": True, **changes}


def _configure(tmp_path, monkeypatch, *entries):
    from app import config

    target = tmp_path / f"mapping-{len(list(tmp_path.glob('mapping-*.json')))}.json"
    target.write_text(json.dumps({"version": 1, "library_roots": list(entries)}))
    monkeypatch.setenv("CRATEMIND_PATH_MAPPINGS_FILE", str(target))
    config.get_settings.cache_clear()
    paths._read_mappings.cache_clear()
    return paths.load_path_mappings()


@pytest.mark.parametrize("data", [
    [], "v1", {"version": 2}, {"version": "1"}, {"version": True}, {"version": 1.0},
    {"library_roots": {"root_key": "x"}}, {"library_roots": ["/Music"]},
    {"library_roots": [{"root_key": "x", "logical_prefix": "/M", "logical_flavor": "posix", "extra": 1}]},
    {"library_roots": [{"root_key": "x", "logical_prefix": "/M"}]},
    {"library_roots": [{"root_key": "  ", "logical_prefix": "/M", "logical_flavor": "posix"}]},
    {"library_roots": [{"root_key": 7, "logical_prefix": "/M", "logical_flavor": "posix"}]},
    {"library_roots": [{"root_key": "x", "logical_prefix": 7, "logical_flavor": "posix"}]},
    {"library_roots": [{"root_key": "x", "logical_prefix": "/M", "logical_flavor": "posix", "local_prefix": 7}]},
    {"library_roots": [{"root_key": "x", "logical_prefix": "Music", "logical_flavor": "posix"}]},
    {"library_roots": [{"root_key": "x", "logical_prefix": "Music\\Sets", "logical_flavor": "windows"}]},
])
def test_malformed_mapping_files_are_rejected(data):
    with pytest.raises(ValueError):
        paths.parse_mappings(data)


@pytest.mark.parametrize("data", [{}, {"version": 1}, {"version": 1, "library_roots": []}])
def test_empty_mapping_files_have_no_roots(data):
    assert paths.parse_mappings(data) == ()


@pytest.mark.parametrize("first,second,accepted", [
    (("/Music", "posix"), ("C:\\Music", "windows"), True),    # different source platforms never overlap
    (("/Music", "posix"), ("/music/Sets", "posix"), True),    # POSIX is case-sensitive
    (("C:\\Music", "windows"), ("c:\\music\\Sets", "windows"), False),
    (("/Music", "posix"), ("/Musical", "posix"), True),       # whole components only
])
def test_overlap_rules_follow_the_source_platform(first, second, accepted):
    rows = [_mapping(None, *first, key="one"), _mapping(None, *second, key="two")]
    if accepted:
        assert len(paths.parse_mappings({"library_roots": rows})) == 2
    else:
        with pytest.raises(ValueError):
            paths.parse_mappings({"library_roots": rows})


@pytest.mark.parametrize("logical_path,expected", [
    ("C:\\Music\\Psy\\Song.WAV", ("windows", "c:\\music\\psy\\song.wav")),
    ("c:\\MUSIC\\psy\\song.wav", ("windows", "c:\\music\\psy\\song.wav")),
    ("/Volumes/Library/Psy/Song.WAV", ("posix", "/Volumes/Library/Psy/Song.WAV")),
    ("/elsewhere/Song.wav", ("native", "/elsewhere/Song.wav")),
])
def test_source_path_keys(tmp_path, logical_path, expected):
    mappings = paths.parse_mappings({"library_roots": [
        _mapping(None, "C:\\Music", "windows", key="win"), _mapping(None, "/Volumes/Library", key="mac")]})
    assert paths.source_path_key(logical_path, mappings) == expected


@pytest.mark.parametrize("local,expected", [
    ("/Volumes/USB Disk/Music/Psy/a.wav", "/Volumes/USB Disk"),
    ("/Users/dj/Music/a.wav", "/"),
])
def test_root_label_without_mappings(local, expected):
    assert paths.logical_root_for_path(local) == expected


def test_root_label_with_mappings_is_the_logical_prefix(tmp_path):
    device = tmp_path / "device"
    device.mkdir()
    mappings = paths.parse_mappings({"library_roots": [_mapping(device)]})
    assert paths.logical_root_for_path(device / "Psy" / "a.wav", mappings) == "/origin/Music"
    with pytest.raises(paths.PathResolutionError) as error:
        paths.logical_root_for_path(tmp_path / "elsewhere" / "a.wav", mappings)
    assert error.value.state == "unmapped"


@pytest.mark.parametrize("enabled,local,state", [(False, "device", "disabled"), (True, None, "unmapped"),
                                                (True, "gone", "disconnected")])
def test_resolution_errors_carry_the_state_and_the_logical_path(tmp_path, enabled, local, state):
    (tmp_path / "device").mkdir()
    mappings = paths.parse_mappings({"library_roots": [
        _mapping(tmp_path / local if local else None, enabled=enabled)]})
    with pytest.raises(paths.PathResolutionError) as error:
        paths.resolve_source_path("/origin/Music/Ελληνικά/α.wav", mappings)
    assert (error.value.state, error.value.logical_path) == (state, "/origin/Music")
    assert isinstance(error.value, OSError) and state in str(error.value)


def test_a_switched_off_root_is_not_a_connected_library_root(tmp_path, monkeypatch):
    on, off = tmp_path / "on", tmp_path / "off"
    on.mkdir(); off.mkdir()
    _configure(tmp_path, monkeypatch, _mapping(on, "/origin/On", key="on"),
               _mapping(off, "/origin/Off", key="off", enabled=False))
    assert paths.connected_library_roots() == [on]


def test_reenrolment_keeps_a_binding_only_for_the_same_root_identity(tmp_path):
    device = tmp_path / "device"
    device.mkdir()
    saved = paths.parse_mappings({"library_roots": [_mapping(device)]})
    same = {"root_key": "stable-library", "logical_prefix": "/origin/Music", "logical_flavor": "posix"}
    renamed = {**same, "root_key": "new-generation"}
    (kept,) = paths.reconcile_mappings(saved, [same])
    (fresh,) = paths.reconcile_mappings(saved, [renamed])
    assert kept.local_prefix == str(device)
    assert (fresh.root_key, fresh.local_prefix) == ("new-generation", None)
    with pytest.raises(paths.PathResolutionError, match="unmapped"):
        paths.resolve_source_path("/origin/Music/a.wav", (fresh,))


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_a_switched_off_root_is_never_scanned_or_marked_missing(db, tmp_path, monkeypatch, mode):
    from app.services import scanner

    on, off = tmp_path / "on", tmp_path / "off"
    kept = make_wav(on / "kept.wav", freq_seed=1)
    gone = make_wav(on / "gone.wav", freq_seed=2)
    away = [make_wav(off / f"away-{n}.wav", freq_seed=10 + n) for n in range(3)]
    rows = (_mapping(on, "/origin/On", key="on"), _mapping(off, "/origin/Off", key="off"))
    _configure(tmp_path, monkeypatch, *rows)
    assert scanner.scan(db, [on, off])["added"] == 5

    _configure(tmp_path, monkeypatch, rows[0], {**rows[1], "enabled": False})
    gone.unlink()
    for path in away:
        path.unlink()
    stats = scanner.scan(db, [on, off], mode=mode)
    assert stats["scanned"] == 1 and stats["missing"] == 1
    assert len(stats["warnings"]) == 1 and str(off) in stats["warnings"][0]
    state = {t.absolute_path: t.missing for t in db.exec(select(Track)).all()}
    assert state == {"/origin/On/kept.wav": False, "/origin/On/gone.wav": True,
                     **{f"/origin/Off/away-{n}.wav": False for n in range(3)}}
    assert kept.exists()


def test_scan_refuses_rows_that_collide_on_a_windows_source(db, tmp_path, monkeypatch):
    from app.services import scanner

    device = tmp_path / "device"
    make_wav(device / "a.wav")
    _configure(tmp_path, monkeypatch, _mapping(device, "C:\\Music", "windows"))
    db.add_all([Track(absolute_path="C:\\Music\\a.wav"), Track(absolute_path="C:\\MUSIC\\A.wav")])
    db.commit()
    with pytest.raises(ValueError, match="αμφίσημες"):
        scanner.scan(db, [device])
    assert len(db.exec(select(Track)).all()) == 2
