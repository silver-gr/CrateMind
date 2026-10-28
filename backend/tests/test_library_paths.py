"""Portable logical paths over generated local libraries; no production data."""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlmodel import select

from app.services import library_paths as paths


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


def mapping(local, logical="/origin/Music", flavor="posix", **changes):
    return {"root_key": "stable-library", "logical_prefix": logical,
            "logical_flavor": flavor, "local_prefix": str(local) if local is not None else None,
            "enabled": True, **changes}


def configure(tmp_path, monkeypatch, *entries):
    from app import config

    # A fresh file stands for the next process's immutable configuration snapshot.
    target = tmp_path / f"mapping-{len(list(tmp_path.glob('mapping-*.json')))}.json"
    target.write_text(json.dumps({"version": 1, "library_roots": entries}))
    monkeypatch.setenv("CRATEMIND_PATH_MAPPINGS_FILE", str(target))
    config.get_settings.cache_clear()
    return paths.load_path_mappings()


@pytest.mark.parametrize("logical,flavor,song", [
    ("/Volumes/Library", "posix", "/Volumes/Library/Ελληνικά/Α.wav"),
    ("D:\\Music", "windows", "d:\\music\\Ελληνικά\\Α.wav"),
    ("\\\\server\\share\\Music", "windows", "\\\\SERVER\\share\\music\\Ελληνικά\\Α.wav"),
])
def test_source_flavor_and_unicode_map_whole_components(tmp_path, logical, flavor, song):
    local = tmp_path / "device"; local.mkdir()
    mappings = paths.parse_mappings({"library_roots": [mapping(local, logical, flavor)]})
    expected = local / "Ελληνικά" / "Α.wav"
    assert paths.resolve_source_path(song, mappings) == expected
    roundtrip = paths.logical_source_path(expected, mappings)
    assert paths.resolve_source_path(roundtrip, mappings) == expected
    assert mappings[0].root_key == "stable-library"
    with pytest.raises(paths.PathResolutionError, match="unmapped"):
        paths.resolve_source_path(logical + "-sibling/song.wav", mappings)


def test_posix_case_sensitive_and_windows_case_insensitive(tmp_path):
    local = tmp_path / "device"; local.mkdir()
    mappings = paths.parse_mappings({"library_roots": [mapping(local, "/Music")]})
    with pytest.raises(paths.PathResolutionError):
        paths.resolve_source_path("/music/song.wav", mappings)
    windows = paths.parse_mappings({"library_roots": [mapping(local, "C:\\Music", "windows")]})
    assert paths.resolve_source_path("c:\\MUSIC\\song.wav", windows) == local / "song.wav"


@pytest.mark.parametrize("change", ["nested-logical", "nested-local", "duplicate-key", "traversal",
                                    "relative", "flavor", "boolean", "nul"])
def test_invalid_or_ambiguous_roots_are_rejected(tmp_path, change):
    first = mapping(tmp_path / "one")
    second = mapping(tmp_path / "two", "/other", root_key="second")
    if change == "nested-logical": second["logical_prefix"] = "/origin/Music/child"
    elif change == "nested-local": second["local_prefix"] = str(tmp_path / "one/child")
    elif change == "duplicate-key": second["root_key"] = first["root_key"]
    elif change == "traversal": second["logical_prefix"] = "/other/../secret"
    elif change == "relative": second["local_prefix"] = "relative/path"
    elif change == "flavor": second["logical_flavor"] = "guess"
    elif change == "boolean": second["enabled"] = "false"
    elif change == "nul": second["logical_prefix"] = "/bad\x00path"
    with pytest.raises(ValueError):
        paths.parse_mappings({"version": 1, "library_roots": [first, second]})


@pytest.mark.parametrize("local,enabled,state", [(None, True, "unmapped"),
                                                ("gone", True, "disconnected"),
                                                ("existing", False, "disabled")])
def test_unavailable_roots_do_not_fall_back_to_origin(tmp_path, local, enabled, state):
    existing = tmp_path / "existing"; existing.mkdir()
    root = tmp_path / local if local else None
    mappings = paths.parse_mappings({"library_roots": [mapping(root, enabled=enabled)]})
    with pytest.raises(paths.PathResolutionError) as error:
        paths.resolve_source_path("/origin/Music/song.wav", mappings)
    assert error.value.state == state


def test_empty_enrolled_or_configured_mappings_deny_fallback(tmp_path, monkeypatch):
    from app import config

    existing = tmp_path / "actual.wav"; existing.write_bytes(b"private fixture")
    assert paths.resolve_source_path(str(existing)) == existing  # legacy web
    configure(tmp_path, monkeypatch)
    with pytest.raises(paths.PathResolutionError, match="unmapped"):
        paths.resolve_source_path(str(existing))
    settings = config.get_settings()
    settings.path_mappings_file = ""
    settings.dataset_root = str(tmp_path / "enrolled-fixture")
    with pytest.raises(paths.PathResolutionError, match="unmapped"):
        paths.resolve_source_path(str(existing))


def test_symlink_file_and_reverse_mapping_cannot_escape_root(tmp_path):
    local = tmp_path / "device"; local.mkdir()
    outside = tmp_path / "outside.wav"; outside.write_bytes(b"fixture")
    link = local / "escape.wav"; link.symlink_to(outside)
    mappings = paths.parse_mappings({"library_roots": [mapping(local)]})
    with pytest.raises(paths.PathResolutionError, match="outside_root"):
        paths.resolve_source_path("/origin/Music/escape.wav", mappings)
    with pytest.raises(paths.PathResolutionError, match="outside_root"):
        paths.logical_source_path(link, mappings)
    inner = local / "inside.wav"; inner.write_bytes(b"fixture")
    (local / "safe.wav").symlink_to(inner)
    assert paths.resolve_source_path("/origin/Music/safe.wav", mappings).read_bytes() == b"fixture"


def test_connected_roots_keep_unmapped_descriptors_and_skip_disconnected(tmp_path, monkeypatch):
    local = tmp_path / "device"; local.mkdir()
    mappings = configure(tmp_path, monkeypatch, mapping(local),
                         mapping(None, "/unknown", root_key="unknown"),
                         mapping(tmp_path / "gone", "/offline", root_key="offline"))
    assert len(mappings) == 3
    assert paths.connected_library_roots() == [local]
    from app.config import get_settings

    assert get_settings().roots == [local]


def test_m3u_resolves_device_paths_and_failure_preserves_previous_export(tmp_path, monkeypatch):
    from app.models import Track
    from app.services import exporter_m3u

    local = tmp_path / "device"; local.mkdir()
    song = local / "Α.wav"; song.write_bytes(b"fixture")
    configure(tmp_path, monkeypatch, mapping(local))
    track = Track(id=7, absolute_path="/origin/Music/Α.wav", title="Δοκιμή")
    destination = tmp_path / "exports/set.m3u8"
    exporter_m3u.export_m3u([track], destination)
    original = destination.read_bytes()
    assert str(song) in original.decode()
    assert track.absolute_path == "/origin/Music/Α.wav"
    missing = Track(id=8, absolute_path="/other/song.wav")
    with pytest.raises(exporter_m3u.UnavailableSourcesError) as error:
        exporter_m3u.export_m3u([track, missing], destination, overwrite=True)
    assert error.value.failures == [{"track_id": 8, "logical_path": "/other/song.wav",
                                     "state": "unmapped"}]
    assert destination.read_bytes() == original
    assert list(destination.parent.iterdir()) == [destination]
    song.unlink()
    with pytest.raises(exporter_m3u.UnavailableSourcesError, match="Α.wav"):
        exporter_m3u.export_m3u([track], tmp_path / "never-published.m3u8")
    assert not (tmp_path / "never-published.m3u8").exists()


def test_m3u_cannot_publish_into_source_root(tmp_path, monkeypatch):
    from app.models import Track
    from app.services import exporter_m3u

    local = tmp_path / "device"; local.mkdir()
    song = local / "a.wav"; song.write_bytes(b"original")
    configure(tmp_path, monkeypatch, mapping(local))
    with pytest.raises(exporter_m3u.UnavailableSourcesError):
        exporter_m3u.export_m3u([Track(absolute_path="/origin/Music/a.wav")], song, overwrite=True)
    assert song.read_bytes() == b"original"


def test_m3u_two_devices_and_failed_publication_preserve_logical_state(tmp_path, monkeypatch):
    from app.models import Track
    from app.services import exporter_m3u

    track = Track(id=1, absolute_path="/origin/Music/a.wav")
    outputs = []
    for name in ("device-a", "device-b"):
        device = tmp_path / name; device.mkdir()
        song = device / "a.wav"; song.write_bytes(b"same generated fixture")
        configure(tmp_path, monkeypatch, mapping(device))
        destination = tmp_path / f"{name}.m3u8"
        exporter_m3u.export_m3u([track], destination)
        outputs.append(destination.read_text())
        assert str(song) in outputs[-1]
    assert outputs[0] != outputs[1] and track.absolute_path == "/origin/Music/a.wav"
    before = destination.read_bytes()

    def fail(*args):
        raise OSError("injected publication failure")

    monkeypatch.setattr(exporter_m3u.os, "replace", fail)
    with pytest.raises(OSError, match="publication failure"):
        exporter_m3u.export_m3u([track], destination, overwrite=True)
    assert destination.read_bytes() == before
    assert set(tmp_path.glob("tmp*")) == set()


def test_windows_spelling_preserves_track_id_and_stored_path(db, tmp_path, monkeypatch):
    from app.models import Track
    from app.services import scanner
    from tests.conftest import make_wav

    local = tmp_path / "device"; local.mkdir()
    song = make_wav(local / "song.wav")
    configure(tmp_path, monkeypatch, mapping(local, "D:\\Music", "windows"))
    original = "d:\\MUSIC\\Song.wav"
    db.add(Track(id=42, absolute_path=original, file_size=song.stat().st_size,
                 modified_time=song.stat().st_mtime))
    db.commit()
    assert paths.resolve_source_path(original).samefile(song)
    result = scanner.scan(db, [local], mode="delta")
    assert result["added"] == result["missing"] == 0 and result["unchanged"] == 1
    rows = db.exec(select(Track)).all()
    assert [(row.id, row.absolute_path) for row in rows] == [(42, original)]


def test_tool_and_hash_readers_receive_only_mapped_paths(tmp_path, monkeypatch):
    from app.services import ffprobe_reader, fingerprint, hashing, streaming

    local = tmp_path / "device"; local.mkdir()
    song = local / "a.wav"; song.write_bytes(b"generated fixture audio")
    configure(tmp_path, monkeypatch, mapping(local))
    logical = Path("/origin/Music/a.wav")
    assert hashing.quick_hash(logical) == hashing.quick_hash(song)
    assert hashing.full_hash(logical) == hashing.full_hash(song)
    assert b"".join(streaming.iter_file_range(logical, 0, 8)) == song.read_bytes()[:9]
    calls = []

    def run(tool, arguments, **kwargs):
        calls.append([tool, *arguments])
        return SimpleNamespace(returncode=0, stdout=b'{"fingerprint":"fixture","duration":1}')

    monkeypatch.setattr(ffprobe_reader.media_tools, "run", run)
    ffprobe_reader.read_stream(logical, "/fixture/ffprobe")
    assert fingerprint.compute(logical, "/fixture/fpcalc")["chromaprint"] == "fixture"
    assert all(str(song) in command and str(logical) not in command for command in calls)


def test_provider_evidence_is_read_only_and_distinguishes_unmapped_from_absent(tmp_path, monkeypatch):
    from app.services import provider_resolution

    local = tmp_path / "device"; local.mkdir()
    song = local / "a.wav"; song.write_bytes(b"fixture")
    configure(tmp_path, monkeypatch, mapping(local))
    assert provider_resolution.file_evidence("/origin/Music/a.wav")["state"] == "present"
    absent = provider_resolution.file_evidence("/origin/Music/missing.wav", "/origin/Music")
    assert absent["verified_path_absent"]
    unknown = provider_resolution.file_evidence("/unknown/a.wav", "/unknown")
    assert unknown == {"state": "unmapped", "verified_path_absent": False}


def test_playback_and_artwork_waveform_use_mapped_file(client, tmp_path, monkeypatch):
    from sqlmodel import Session

    from app import db as dbmod
    from app.models import Track
    from app.services import artwork, waveform
    from tests.conftest import make_wav

    local = tmp_path / "device"; local.mkdir()
    song = make_wav(local / "a.wav")
    configure(tmp_path, monkeypatch, mapping(local))
    with Session(dbmod.get_engine()) as session:
        session.add(Track(id=1, absolute_path="/origin/Music/a.wav", extension="wav"))
        session.commit()
    response = client.get("/api/tracks/1/audio", headers={"range": "bytes=0-15"})
    assert response.status_code == 206 and response.content == song.read_bytes()[:16]
    calls = []
    monkeypatch.setattr(artwork, "File", lambda path: calls.append(path))
    artwork.extract_embedded_artwork("/origin/Music/a.wav")
    assert calls == [str(song)]
    monkeypatch.setattr(waveform, "_decode", lambda path, binary: (
        calls.append(str(path)) or {"peaks": [.5], "rms": [.2], "version": waveform.VERSION}))
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/fixture/ffmpeg")
    from app.config import get_settings

    get_settings.cache_clear()
    assert waveform.get_or_compute_waveform(1, "/origin/Music/a.wav")["peaks"] == [.5]
    assert calls[-1] == str(song)
    assert client.get("/api/tracks/1").json()["track"]["absolute_path"] == "/origin/Music/a.wav"


def test_two_mount_scans_preserve_catalog_identity_and_decisions(db, tmp_path, monkeypatch):
    from app.models import Track
    from app.services import canonical_library, manual_identity, scanner
    from tests.conftest import make_wav
    from tests.test_canonical import entity, fixture_db, put

    first = tmp_path / "device-a"; second = tmp_path / "device-b"
    first.mkdir(); second.mkdir()
    audio = make_wav(first / "Artist - Song.wav")
    replica = second / audio.name; replica.write_bytes(audio.read_bytes())
    os.utime(replica, (audio.stat().st_atime, audio.stat().st_mtime + 10))
    original_files = [(file, file.read_bytes(), file.stat().st_mtime_ns) for file in (audio, replica)]
    identity = Path(db.get_bind().url.database).with_name("identity.sqlite")
    source = fixture_db(); source.executescript(canonical_library.SCHEMA); source.commit()
    with sqlite3.connect(identity) as destination: source.backup(destination)
    source.close()
    configure(tmp_path, monkeypatch, mapping(first))
    first_result = scanner.scan(db, [first])
    assert first_result["added"] == 1
    track = db.exec(select(Track)).one()
    original_id, logical = track.id, track.absolute_path
    assert logical == "/origin/Music/Artist - Song.wav"
    assert track.volume_root == "/origin/Music"
    with canonical_library.connect(identity) as canonical:
        for sid in ("spotify:track:accepted", "spotify:track:rejected"):
            put(canonical, entity(sid, "spotify", artist=track.artist, title=track.title))
        canonical_library.promote(canonical)
        canonical.commit()
        left, accepted = f"local:{track.id}", "spotify:track:accepted"
        preview = manual_identity.comparison(canonical, left, accepted)
        manual_identity.link(canonical, left, accepted, preview["token"], left, mirror_legacy=False)
        canonical.commit()
        rejected = "spotify:track:rejected"
        preview = manual_identity.comparison(canonical, left, rejected)
        manual_identity.reject(canonical, left, rejected, preview["token"])
        canonical_library.review(canonical, f"local:{track.id}", "edit", {
            "title": "Human title", "credits": [{"name": track.artist, "role": "primary"}],
        })
    before_mapping = [tuple(row) for row in db.connection().exec_driver_sql("SELECT * FROM tracks")]
    with sqlite3.connect(identity) as saved:
        before_identity = list(saved.iterdump())
    configure(tmp_path, monkeypatch, mapping(second))
    assert paths.resolve_source_path(logical).samefile(replica)
    from app.services import identity_library, provider_resolution

    with identity_library.connect(identity) as saved:
        observation = saved.execute("SELECT * FROM entities WHERE id=?", (f"local:{track.id}",)).fetchone()
        assert provider_resolution.local_asset(observation)["playable"]
    assert before_mapping == [tuple(row) for row in db.connection().exec_driver_sql("SELECT * FROM tracks")]
    with sqlite3.connect(identity) as saved:
        assert list(saved.iterdump()) == before_identity
    moved = scanner.scan(db, [second], mode="delta")
    assert moved["added"] == 0 and moved["updated"] == 1
    db.expire_all()
    track = db.exec(select(Track)).one()
    assert (track.id, track.absolute_path) == (original_id, logical)
    assert track.modified_time == replica.stat().st_mtime
    with canonical_library.connect(identity) as canonical:
        row = canonical.execute("SELECT title FROM canonical_recordings WHERE recording_id=?",
                                (f"local:{original_id}",)).fetchone()
        assert row[0] == "Human title"
        raw = json.loads(canonical.execute("SELECT metadata_json FROM entities WHERE id=?",
                                          (f"local:{original_id}",)).fetchone()[0])
        assert raw["absolute_path"] == logical
        assert str(second) not in json.dumps(raw)
        assert canonical.execute("SELECT revoked_at FROM identity_acceptances").fetchall()[0][0] is None
        assert canonical.execute("SELECT reason FROM canonical_blocks").fetchall()[0][0] == "human_rejection"
    before = [tuple(row) for row in db.connection().exec_driver_sql("SELECT * FROM tracks")]
    stable = scanner.scan(db, [second], mode="delta")
    after = [tuple(row) for row in db.connection().exec_driver_sql("SELECT * FROM tracks")]
    assert stable["unchanged"] == 1 and before == after
    assert all(file.read_bytes() == data and file.stat().st_mtime_ns == modified
               for file, data, modified in original_files)


def test_unmapped_scan_never_marks_existing_tracks_missing(db, tmp_path, monkeypatch):
    from app.models import Track
    from app.services import scanner

    db.add(Track(absolute_path="/old-device/Music/a.wav", missing=False))
    db.commit()
    configure(tmp_path, monkeypatch, mapping(None, "/old-device/Music"))
    stats = scanner.scan(db, [Path("/old-device/Music")], mode="delta")
    assert stats["scanned"] == stats["missing"] == 0 and stats["warnings"]
    assert not db.exec(select(Track)).one().missing


def test_web_analysis_and_provider_submission_receive_web_local_path(db, tmp_path, monkeypatch):
    from app.models import Track
    from app.services import audio_analysis as analysis

    local = tmp_path / "web-device"; local.mkdir()
    song = local / "desktop-added.wav"; song.write_bytes(b"fixture")
    configure(tmp_path, monkeypatch, mapping(local))
    db.add(Track(absolute_path="/origin/Music/desktop-added.wav", extension="wav", duration=60))
    db.commit()
    calls = []

    def analyze(path, **kwargs):
        calls.append(("local", path))
        return analysis.AnalysisResult(bpm=140, bpm_raw=140, bpm_method="fixture")

    class Provider:
        def __init__(self, **kwargs): pass
        def analyze(self, path, duration):
            calls.append(("provider", path))
            return SimpleNamespace(bpm=141, source="fixture")

    monkeypatch.setattr(analysis, "analyze_file", analyze)
    monkeypatch.setattr(analysis, "ReccoBeatsClient", Provider)
    settings = analysis.get_settings().model_copy(update={"reccobeats_enabled": True})
    monkeypatch.setattr(analysis, "get_settings", lambda: settings)
    result = analysis.analyze_all(db)
    assert result["analyzed"] == 1
    assert calls == [("local", str(song)), ("provider", str(song))]
    assert db.exec(select(Track)).one().absolute_path == "/origin/Music/desktop-added.wav"
