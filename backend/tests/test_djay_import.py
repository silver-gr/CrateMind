"""djay beatgrid import. Every fixture is hand-built in tmp; no real djay or
CrateMind data is read. Format layouts follow docs of the djay-phrase-tool."""
from __future__ import annotations

import json
import os
import plistlib
import shutil
import sqlite3
import struct
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from sqlmodel import Session, select

from app.models import Job, Track, TrackBeatgrid
from app.services import djay_import as dj

# ---- fixture builders --------------------------------------------------------

def make_bookmark(volume: str, parts: list[str]) -> bytes:
    body = bytearray(b"\0\0\0\0")

    def add(kind: int, payload: bytes) -> int:
        offset = len(body)
        body.extend(struct.pack("<II", len(payload), kind) + payload)
        body.extend(b"\0" * (-len(body) % 4))
        return offset

    offsets = [add(0x101, part.encode()) for part in parts]
    array = add(0x601, b"".join(struct.pack("<I", o) for o in offsets))
    vol = add(0x101, volume.encode())
    toc = len(body)
    entries = [(0x1004, array), (0x2002, vol)]
    body.extend(struct.pack("<IIIII", 20 + 12 * len(entries), 0xFFFFFFFE, 0, 0, len(entries)))
    for key, offset in entries:
        body.extend(struct.pack("<III", key, offset, 0))
    body[0:4] = struct.pack("<I", toc)
    return b"book" + struct.pack("<III", 48 + len(body), 0x10040000, 48) + b"\0" * 32 + bytes(body)


def location_blob(duration: float | None, bookmark: bytes | None) -> bytes:
    blob = b"TSAF\x03\x00\x03\x00\x2b\x08ADCMediaItemLocation\x00"
    if duration is not None:
        blob += b"\x13\x00\x00\x00" + struct.pack("<f", duration) + b"\x08duration\x00"
    return blob + (bookmark or b"")


def edits_blob(position: float | None, *, shift: int = 0) -> bytes:
    blob = b"TSAF\x03\x00\x03\x00\x2b\x08ADCMediaItemUserData\x00\x2b\x08ADCBeatGridEdits\x00"
    if position is None:
        blob += b"\x2e"
    else:
        blob += b"\x13\x00\x00\x00" + struct.pack("<f", position)
    blob += b"\x08firstDownbeatPosition\x00"
    blob += (b"\x0b" + struct.pack("<i", shift) if shift else b"\x2e") + b"\x08nrOfBeatShift\x00"
    blob += b"\x0a\x00\x00\x00\x00\x08downbeatMarkers\x00\x2e\x08firstGridSegmentTempoExponent\x00"
    blob += b"\x13\x00\x00\x00\x00\x00\x00\x00\x08fractionalBeatShift\x00"
    return blob


def make_plist(beats, first_down=0, *, straight=True, straight_bpm=120.0, bpm=None, version=8,
               signature=4, confidence=0.9) -> bytes:
    return plistlib.dumps({
        "deepBeatTrackerInfo": {
            "version": version, "timeSignatureIndex": signature, "straightGrid": straight,
            "straightBPM": straight_bpm, "bpm": bpm if bpm is not None else straight_bpm,
            "analyzedBPM": straight_bpm, "bpmConfidence": confidence,
            "firstDownBeatIndex": first_down,
            "compressedBeats": zlib.compress(np.asarray(beats, dtype=">f4").tobytes()),
        },
        "info": {"Name": "x", "Artist": "y", "Duration": 100, "source": 1},
    }, fmt=plistlib.FMT_BINARY)


def straight_beats(bpm=120.0, anchor=0.25, count=200, jitter=0.0, seed=1):
    rng = np.random.default_rng(seed)
    return anchor + np.arange(count) * 60.0 / bpm + rng.uniform(-jitter, jitter, count)


SCHEMA = [
    'CREATE TABLE database2 ("rowid" INTEGER PRIMARY KEY, "collection" CHAR NOT NULL, '
    '"key" CHAR NOT NULL, "data" BLOB, "metadata" BLOB)',
    'CREATE TABLE "secondaryIndex_mediaItemLocationIndex" ("rowid" INTEGER PRIMARY KEY, "fileName" TEXT)',
    'CREATE TABLE "secondaryIndex_mediaItemAnalyzedDataIndex" ("rowid" INTEGER PRIMARY KEY, '
    '"bpm" REAL, "manualBPM" REAL, "keySignatureIndex" INTEGER)',
]


def build_library(source: Path, items: list[dict], wal_only: list[dict] = ()) -> Path:
    """A YapDatabase-shaped WAL database. `wal_only` rows are committed after a
    checkpoint, so they exist ONLY in the -wal file. Only db + wal are kept."""
    staging = source.parent / (source.name + "-staging")
    staging.mkdir(parents=True)
    db = staging / "MediaLibrary.db"
    connection = sqlite3.connect(db)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    for statement in SCHEMA:
        connection.execute(statement)

    def insert(item: dict) -> None:
        rowid = connection.execute("INSERT INTO database2(collection,key,data) VALUES "
                                   "('localMediaItemLocations',?,?)", (item["uuid"], item["location"])).lastrowid
        connection.execute('INSERT INTO "secondaryIndex_mediaItemLocationIndex" VALUES (?,?)',
                           (rowid, item["file_name"]))
        rowid = connection.execute("INSERT INTO database2(collection,key,data) VALUES "
                                   "('mediaItemAnalyzedData',?,?)", (item["uuid"], b"TSAF")).lastrowid
        connection.execute('INSERT INTO "secondaryIndex_mediaItemAnalyzedDataIndex" VALUES (?,?,?,?)',
                           (rowid, item.get("bpm"), item.get("manual"), item.get("key", 3)))
        if item.get("edits") is not None:
            connection.execute("INSERT INTO database2(collection,key,data) VALUES "
                               "('mediaItemUserData',?,?)", (item["uuid"], item["edits"]))

    for item in items:
        insert(item)
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    for item in wal_only:
        insert(item)
    connection.commit()
    source.mkdir()
    shutil.copyfile(db, source / "MediaLibrary.db")  # while the connection is still open
    shutil.copyfile(str(db) + "-wal", source / "MediaLibrary.db-wal")
    connection.close()
    return source / "MediaLibrary.db"


def item(uuid, file_name, path, duration=100.0, **extra):
    parts = list(Path(path).parts[1:])
    return {"uuid": uuid, "file_name": file_name, "bpm": 120.0,
            "location": location_blob(duration, make_bookmark("/", parts)), **extra}


@pytest.fixture(autouse=True)
def fresh_settings_cache():
    """Earlier test files leave a cached Settings behind; never inherit it."""
    import app.config as cfg

    cfg.get_settings.cache_clear()
    yield
    cfg.get_settings.cache_clear()


@pytest.fixture(autouse=True)
def no_retry_sleep(monkeypatch):
    monkeypatch.setattr(dj, "_RETRY_PAUSE_S", 0.0)


def snapshot(root: Path):
    return {str(p): (p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ino)
            for p in sorted(root.rglob("*")) if p.is_file()}


# ---- parsers ---------------------------------------------------------------------

def test_bookmark_path_uses_volume_and_components():
    assert dj.bookmark_path(location_blob(1.0, make_bookmark("/", ["Users", "dj", "a b.mp3"]))) == "/Users/dj/a b.mp3"
    # Real bookmarks list path components from the filesystem root; the volume path is a separate entry.
    assert dj.bookmark_path(make_bookmark("/Volumes/Disk", ["Volumes", "Disk", "Music", "ä.flac"])) == "/Volumes/Disk/Music/ä.flac"
    assert dj.bookmark_path(b"no bookmark here") is None
    assert dj.bookmark_path(b"book" + b"\xff" * 20) is None


def test_bookmark_path_skips_an_earlier_book_inside_a_file_name():
    blob = b"\x08Notebook.mp3\x00Facebook" + make_bookmark("/", ["Users", "dj", "a.mp3"])
    assert dj.bookmark_path(blob) == "/Users/dj/a.mp3"


def test_tsaf_field_reads_value_before_name_and_ignores_null():
    blob = edits_blob(0.1875)
    assert dj.tsaf_field(blob, "firstDownbeatPosition") == pytest.approx(0.1875)
    assert dj.tsaf_field(edits_blob(None), "firstDownbeatPosition") is None
    assert dj.tsaf_field(blob, "nope") is None
    assert dj.tsaf_beatgrid_edits(edits_blob(0.1875)) == (pytest.approx(0.1875), False)
    assert dj.tsaf_beatgrid_edits(edits_blob(0.0)) == (0.0, False)  # a genuine 0.0 edit is honoured
    assert dj.tsaf_beatgrid_edits(edits_blob(None)) == (None, False)  # null is unset
    assert dj.tsaf_beatgrid_edits(edits_blob(0.2, shift=2))[1] is True
    assert dj.tsaf_beatgrid_edits(b"TSAF unrelated") == (None, False)
    assert dj._location_duration(location_blob(212.5, None)) == pytest.approx(212.5)


def test_tsaf_field_does_not_depend_on_the_bytes_before_the_value():
    # In djay's real location blobs the byte 8 before the name varies (0x00, 't', 's', ...), not only 0x13.
    for prefix in (b"\x00\x00\x00\x00", b"tes\x00", b"\x13\x00\x00\x00"):
        assert dj.tsaf_field(b"TSAF" + prefix + struct.pack("<f", 312.5) + b"\x08duration\x00", "duration") == 312.5
    assert dj._location_duration(b"TSAF\x00\x00\x00\x00" + struct.pack("<f", 200.25) + b"\x08duration\x00") == 200.25
    assert dj.tsaf_field(b"TSAF\x00\x00\x00\x00\x2e\x08firstDownbeatPosition\x00", "firstDownbeatPosition") is None


def test_read_analysis_decodes_big_endian_beats_and_gates(tmp_path):
    beats = straight_beats()
    path = tmp_path / "a.djayMetadata"
    path.write_bytes(make_plist(beats, first_down=3, straight_bpm=120.0))
    analysis = dj.read_analysis(path)
    assert analysis.first_down == 3 and analysis.straight_grid
    assert analysis.beats[:3] == pytest.approx(beats[:3], abs=1e-4)
    for name, kwargs, reason in (("v7", {"version": 7}, "version"), ("ts", {"signature": 3}, "time_signature")):
        path.write_bytes(make_plist(beats, **kwargs))
        with pytest.raises(dj.UnsupportedAnalysis) as error:
            dj.read_analysis(path)
        assert error.value.reason == reason
    path.write_bytes(plistlib.dumps({"other": 1}, fmt=plistlib.FMT_BINARY))
    with pytest.raises(dj.UnsupportedAnalysis):
        dj.read_analysis(path)
    path.write_bytes(make_plist(beats)[:40])  # a file djay is rewriting
    with pytest.raises(dj.TransientSourceError):
        dj.read_analysis(path)
    with pytest.raises(dj.TransientSourceError) as missing:
        dj.read_analysis(tmp_path / "gone.djayMetadata")
    assert missing.value.reason == "missing"


# ---- grid model --------------------------------------------------------------------

def analysis_for(beats, first_down=0, straight=True, bpm=120.0):
    return dj.Analysis(np.asarray(beats, dtype=float), first_down, straight, bpm, bpm, 0.9, 8)


def test_gap_aware_fit_recovers_anchor_from_gappy_jittered_beats():
    beats = straight_beats(bpm=124.0, anchor=1.37, count=300, jitter=0.003)
    keep = np.ones(len(beats), bool)
    keep[40:43] = keep[120:121] = keep[200:204] = False  # whole beats missing
    sparse = beats[keep]
    first_down = 5  # array index, NOT beat number: gaps make them differ later
    fit = dj.fit_grid(analysis_for(sparse, first_down, bpm=124.0), None, None, False)
    assert fit.straight and fit.bpm == pytest.approx(124.0)
    assert fit.anchor_s == pytest.approx(1.37 + first_down * 60.0 / 124.0, abs=0.002)
    assert fit.first_downbeat_index == first_down and fit.beats is None
    assert fit.residual_ms < 5


def test_residual_gate_stores_raw_beats_for_drifting_straight_flag():
    beats = straight_beats(bpm=120.0, count=200) * 1.0
    beats = beats + np.linspace(0, 0.6, len(beats))  # slow drift: not a straight grid
    fit = dj.fit_grid(analysis_for(beats), None, None, False)
    assert not fit.straight and fit.beats is not None and fit.residual_ms > dj.RESIDUAL_GATE_MS
    assert len(fit.beats) == len(beats)


def test_breakdown_wander_keeps_a_djay_straight_grid_straight():
    # Measured on a real library: on djay-straight tracks the typical beat sits ~3 ms off the grid, but ~18%
    # of beats wander (breakdowns without a kick). The gate judges the typical beat, not the worst 5%.
    beats = straight_beats(bpm=145.0, count=400)
    beats[150:220] += np.random.default_rng(3).uniform(-0.15, 0.15, 70)  # 70 wandering beats (17.5%)
    fit = dj.fit_grid(analysis_for(beats, bpm=145.0), None, None, False)
    assert fit.straight and fit.beats is None and fit.residual_ms < dj.RESIDUAL_GATE_MS


def drifting_beats():
    return straight_beats(bpm=120.0, count=200) + np.linspace(0, 0.6, 200)


def test_residual_failed_straight_grid_honours_manual_bpm_factor():
    beats = drifting_beats()
    fit = dj.fit_grid(analysis_for(beats), 60.0, None, False)
    assert fit.edited and fit.beats is None and fit.anchor_s is None and not fit.straight
    kept = dj.fit_grid(analysis_for(beats), 120.0, None, False)
    assert not kept.edited and kept.beats is not None


def test_residual_failed_straight_grid_remaps_first_downbeat_index_to_the_edit():
    beats = drifting_beats()
    fit = dj.fit_grid(analysis_for(beats), None, beats[7] + 0.004, False)
    assert not fit.straight and fit.first_downbeat_index == 7


def test_dynamic_grid_is_never_forced_straight():
    beats = straight_beats(bpm=120.0)  # would pass the gate, but djay said dynamic
    fit = dj.fit_grid(analysis_for(beats, straight=False), None, None, False)
    assert not fit.straight and fit.beats is not None and fit.residual_ms is None


def test_manual_bpm_double_half_keep_the_downbeat_timestamp():
    beats = straight_beats(bpm=70.0, anchor=0.9)
    base = dj.fit_grid(analysis_for(beats, bpm=70.0), None, None, False)
    doubled = dj.fit_grid(analysis_for(beats, bpm=70.0), 140.0, None, False)
    halved = dj.fit_grid(analysis_for(beats, bpm=70.0), 35.0, None, False)
    same = dj.fit_grid(analysis_for(beats, bpm=70.0), 70.0, None, False)
    assert doubled.straight and doubled.bpm == pytest.approx(140.0)
    assert halved.bpm == pytest.approx(35.0)
    assert doubled.anchor_s == halved.anchor_s == base.anchor_s == same.anchor_s
    other = dj.fit_grid(analysis_for(beats, bpm=70.0), 93.0, None, False)
    assert other.edited and other.anchor_s is None and other.beats is None
    assert dj.fit_grid(analysis_for(beats, straight=False, bpm=70.0), 93.0, None, False).edited


def test_first_downbeat_edit_overrides_anchor_and_other_edits_flag_edited():
    beats = straight_beats(bpm=120.0, anchor=0.25)
    assert dj.fit_grid(analysis_for(beats), None, 0.75, False).anchor_s == pytest.approx(0.75)
    assert dj.fit_grid(analysis_for(beats), None, 0.75, True).edited
    dyn = dj.fit_grid(analysis_for(beats, straight=False), None, beats[7] + 0.004, False)
    assert dyn.first_downbeat_index == 7


# ---- library copy ---------------------------------------------------------------------

def test_wal_only_row_is_read_from_private_copy_and_live_db_is_never_opened(tmp_path, monkeypatch):
    track = tmp_path / "lib" / "one.mp3"
    wal_row = item("b" * 32, "two.mp3", tmp_path / "lib" / "two.mp3", edits=edits_blob(0.5))
    live = build_library(tmp_path / "djay", [item("a" * 32, "one.mp3", track, manual=140.0)], [wal_row])
    # Without its WAL the main file lacks the row: the WAL really is needed.
    bare = tmp_path / "bare"
    bare.mkdir()
    shutil.copyfile(live, bare / "MediaLibrary.db")
    with sqlite3.connect(bare / "MediaLibrary.db") as connection:
        assert connection.execute("select count(*) from database2 where key=?", ("b" * 32,)).fetchone()[0] == 0
    before = snapshot(live.parent)
    opened, copies = [], []
    real_connect, real_copy = sqlite3.connect, shutil.copyfile

    def spy_connect(database, *args, **kwargs):
        opened.append(Path(str(database)))
        assert Path(str(database)).parent != live.parent, "the live djay database must never be opened"
        return real_connect(database, *args, **kwargs)

    def spy_copy(source, destination, *args, **kwargs):
        copies.append(Path(source).name)
        return real_copy(source, destination, *args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", spy_connect)
    monkeypatch.setattr(shutil, "copyfile", spy_copy)
    work = tmp_path / "work"
    work.mkdir()
    copy = dj.copy_library(live, work)
    items = dj.read_library(copy)
    monkeypatch.undo()
    assert set(items) == {"a" * 32, "b" * 32}
    assert items["a" * 32].manual_bpm == 140.0 and items["a" * 32].key_index == 3
    assert items["b" * 32].first_downbeat == pytest.approx(0.5)
    assert items["a" * 32].path == str(track) and items["a" * 32].duration == pytest.approx(100.0)
    assert opened and all(path.parent == work for path in opened)
    assert sorted(copies) == ["MediaLibrary.db", "MediaLibrary.db-wal"]  # never -shm
    assert snapshot(live.parent) == before  # sizes, mtimes, inodes untouched
    assert not (live.parent / "MediaLibrary.db-shm").exists()


def test_changing_source_retries_then_aborts_before_any_upsert(tmp_path, monkeypatch, db):
    live = build_library(tmp_path / "djay", [item("a" * 32, "one.mp3", tmp_path / "one.mp3")])
    wal = Path(str(live) + "-wal")
    real_copy = shutil.copyfile
    calls = {"n": 0}

    def flaky(source, destination, *args, **kwargs):
        result = real_copy(source, destination, *args, **kwargs)
        calls["n"] += 1
        if Path(source) == live and calls["n"] <= 2:  # djay checkpoints/rewrites during the copy
            os.utime(wal, ns=(time.time_ns(), time.time_ns() + calls["n"] * 10**9))
        return result

    monkeypatch.setattr(shutil, "copyfile", flaky)
    work = tmp_path / "w1"
    work.mkdir()
    assert dj.copy_library(live, work).is_file()  # third attempt is stable
    assert calls["n"] >= 4

    def always(source, destination, *args, **kwargs):
        result = real_copy(source, destination, *args, **kwargs)
        if Path(source) == wal:
            with open(wal, "r+b") as handle:  # a truncated / reset WAL
                handle.truncate(max(handle.seek(0, 2) - 32, 0))
        return result

    monkeypatch.setattr(shutil, "copyfile", always)
    with pytest.raises(dj.DjayImportError, match="κλείσε το djay"):
        dj.run_import(db, library=live, metadata=tmp_path / "meta")
    assert db.exec(select(TrackBeatgrid)).all() == []


def test_wal_appearing_or_disappearing_counts_as_change(tmp_path, monkeypatch):
    live = build_library(tmp_path / "djay", [item("a" * 32, "one.mp3", tmp_path / "one.mp3")])
    wal = Path(str(live) + "-wal")
    wal_bytes = wal.read_bytes()
    real_copy = shutil.copyfile
    copies = []

    def vanish(source, destination, *args, **kwargs):
        result = real_copy(source, destination, *args, **kwargs)
        copies.append(Path(source).name)
        if len(copies) == 2:  # the WAL was just copied: djay checkpoints and removes it
            wal.unlink()
        return result

    monkeypatch.setattr(shutil, "copyfile", vanish)
    work = tmp_path / "w"
    work.mkdir()
    dj.copy_library(live, work)
    assert copies == ["MediaLibrary.db", "MediaLibrary.db-wal", "MediaLibrary.db"]  # retried; stale WAL dropped
    assert not (work / "MediaLibrary.db-wal").exists()

    monkeypatch.setattr(shutil, "copyfile", real_copy)
    copies.clear()

    def appear(source, destination, *args, **kwargs):
        result = real_copy(source, destination, *args, **kwargs)
        copies.append(Path(source).name)
        if len(copies) == 1:  # a WAL shows up after the first look
            wal.write_bytes(wal_bytes)
        return result

    monkeypatch.setattr(shutil, "copyfile", appear)
    dj.copy_library(live, work)
    assert copies == ["MediaLibrary.db", "MediaLibrary.db", "MediaLibrary.db-wal"]
    assert (work / "MediaLibrary.db-wal").read_bytes() == wal_bytes


def test_permission_errors_name_the_responsible_app(tmp_path, monkeypatch):
    live = build_library(tmp_path / "djay", [item("a" * 32, "one.mp3", tmp_path / "one.mp3")])

    def deny(*args, **kwargs):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(shutil, "copyfile", deny)
    work = tmp_path / "w"
    work.mkdir()
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", "desktop-core")
    with pytest.raises(dj.DjayImportError, match="«CrateMind Preview»"):
        dj.copy_library(live, work)
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", "web")
    monkeypatch.setenv("TERM_PROGRAM", "iTerm.app")
    with pytest.raises(dj.DjayImportError, match="«iTerm»"):
        dj.copy_library(live, work)
    monkeypatch.setattr(os, "scandir", deny)
    with pytest.raises(dj.DjayImportError, match="«iTerm»"):
        dj.index_metadata(tmp_path / "meta")


def test_sources_come_from_desktop_config_or_web_env(tmp_path, monkeypatch):
    from app.config import Settings

    web = Settings(_env_file=None, djay_library=str(tmp_path / "L.db"), djay_metadata=str(tmp_path / "M"))
    assert dj.resolve_sources(web) == (tmp_path / "L.db", tmp_path / "M")
    assert dj.resolve_sources(Settings(_env_file=None))[0].name == "MediaLibrary.db"
    (tmp_path / "desktop-config.json").write_text(json.dumps(
        {"version": 1, "djay_library": str(tmp_path / "dl.db"), "djay_metadata": str(tmp_path / "dm")}))
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", "desktop-core")
    desktop = Settings(_env_file=None, dataset_root=str(tmp_path))
    assert dj.resolve_sources(desktop) == (tmp_path / "dl.db", tmp_path / "dm")
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", "web")  # web ignores desktop-config.json
    assert dj.resolve_sources(Settings(_env_file=None, dataset_root=str(tmp_path)))[0].name == "MediaLibrary.db"


# ---- matching ----------------------------------------------------------------------------

def djay_item(uuid, name, path=None, duration=100.0):
    return dj.DjayItem(uuid, name, duration, str(path) if path else None)


def test_matching_rules_bookmark_first_name_second_and_uniqueness_both_ways():
    tracks = [(1, "/m/a.mp3", "a.mp3", 100.0), (2, "/other/a.mp3", "a.mp3", 100.4),
              (3, "/m/solo.mp3", "solo.mp3", 200.0), (4, "/m/dup.mp3", "dup.mp3", 50.0),
              (5, "/n/dup.mp3", "dup.mp3", 50.5), (6, "/m/far.mp3", "far.mp3", 10.0)]
    items = {
        "U1": djay_item("U1", "a.mp3", "/m/a.mp3"),          # bookmark -> track 1; shared uuid, so
        "U2": djay_item("U2", "solo.mp3", "/gone/solo.mp3", 200.5),  # name rule -> 3
        "U3": djay_item("U3", "dup.mp3", None, 50.2),         # two tracks match -> ambiguous
        "U4": djay_item("U4", "far.mp3", None, 12.5),         # duration off by >1s -> unmatched
        "U5": djay_item("U5", "missing.mp3", None),
        "U6": djay_item("U6", "a.mp3", "/m/a.mp3"),           # competes with U1 for track 1
    }
    matched, reasons = dj.match_items(items, tracks)
    assert matched == {"U2": 3}
    assert reasons == {"U3": "ambiguous", "U4": "unmatched", "U5": "unmatched",
                       "U1": "ambiguous", "U6": "ambiguous"}


def test_shared_uuid_is_not_claimed_by_name_when_a_bookmark_matched():
    tracks = [(1, "/m/a.mp3", "a.mp3", 100.0), (2, "/copy/a.mp3", "a.mp3", 100.0)]
    matched, reasons = dj.match_items({"U1": djay_item("U1", "a.mp3", "/m/a.mp3")}, tracks)
    assert matched == {"U1": 1} and reasons == {}


# ---- end to end -------------------------------------------------------------------------------

@pytest.fixture
def world(client, tmp_path, monkeypatch):
    """Library of tracks + a hand-built djay library and metadata folder."""
    import app.config as cfg
    from app.db import get_engine

    lib = tmp_path / "lib"
    lib.mkdir()
    names = ["straight", "dynamic", "ver", "manual", "edited", "ghost"]
    meta = tmp_path / "meta"
    plists = {
        "straight": make_plist(straight_beats(120.0, 0.3), 2, straight_bpm=120.0),
        "dynamic": make_plist(straight_beats(100.0, 0.1) + np.linspace(0, 0.9, 200), 0, straight=False,
                              straight_bpm=100.0),
        "ver": make_plist(straight_beats(), version=8),
        "manual": make_plist(straight_beats(70.0, 0.9), 0, straight_bpm=70.0),
        "edited": make_plist(straight_beats(128.0, 0.2), 0, straight_bpm=128.0),
    }
    entries = []
    with Session(get_engine(), expire_on_commit=False) as session:
        for number, name in enumerate(names):
            path = lib / f"{name}.mp3"
            path.write_bytes(b"audio")
            track = Track(absolute_path=str(path), file_name=path.name, duration=100.0)
            session.add(track)
            uuid = f"{number:02d}" * 16
            extra = {"manual": 140.0} if name == "manual" else {}
            if name == "edited":
                extra["edits"] = edits_blob(None, shift=3)
            if name == "straight":
                extra["edits"] = edits_blob(None)
            entries.append(item(uuid, path.name, path, **extra))
            if name in plists:
                shard = meta / f"{number:02d}"
                shard.mkdir(parents=True, exist_ok=True)
                (shard / f"{uuid}.djayMetadata").write_bytes(plists[name])
        session.commit()
    live = build_library(tmp_path / "djay", entries[:-2], entries[-2:])
    monkeypatch.setenv("CRATEMIND_DJAY_LIBRARY", str(live))
    monkeypatch.setenv("CRATEMIND_DJAY_METADATA", str(meta))
    cfg.get_settings.cache_clear()
    return {"client": client, "live": live, "meta": meta, "tmp": tmp_path, "names": names}


def run_job(client):
    started = client.post("/api/import/djay")
    assert started.status_code == 200, started.text
    for _ in range(200):
        status = client.get("/api/import/djay").json()
        if status["job"]["status"] in {"done", "error"}:
            return status
        time.sleep(0.05)
    raise AssertionError("djay_import job did not finish")


def grids(session_factory=None):
    from app.db import get_engine

    with Session(get_engine()) as session:
        return {row.track_id: row for row in session.exec(select(TrackBeatgrid)).all()}


def test_import_job_end_to_end_and_remove(world):
    client, tmp = world["client"], world["tmp"]
    before = snapshot(tmp / "djay") | snapshot(world["meta"])
    status = run_job(client)
    assert status["job"]["status"] == "done", status
    report = status["report"]
    assert report["items"] == 6 and report["matched"] == 6
    assert report["added"] == 5 and report["edited"] == 1 and report["non_straight"] == 1
    assert report["transient"] == 1  # "ghost" has no analysis file
    rows = {r.source_uuid: r for r in grids().values()}
    straight = rows["00" * 16]
    assert straight.straight and straight.bpm == pytest.approx(120.0) and straight.beats is None
    assert straight.anchor_s == pytest.approx(0.3 + 2 * 0.5, abs=0.002)  # first_down index 2 kept separate
    dynamic = rows["01" * 16]
    assert not dynamic.straight and len(dynamic.beats) == 200 * 4
    assert rows["03" * 16].bpm == pytest.approx(140.0) and rows["03" * 16].straight
    assert rows["04" * 16].edited and rows["04" * 16].anchor_s is None
    assert rows["00" * 16].key_index == 3 and rows["00" * 16].source_version == 8
    assert snapshot(tmp / "djay") | snapshot(world["meta"]) == before  # djay's files untouched

    imported = {r.source_uuid: r.imported_at for r in grids().values()}
    again = run_job(client)["report"]
    assert again["added"] == 0 and again["updated"] == 0 and again["unchanged"] == 5
    assert {r.source_uuid: r.imported_at for r in grids().values()} == imported  # no churn

    # Authoritative: the source now says "unsupported" -> row removed.
    # Transient: the file is missing -> the row is kept.
    ver_path = next(world["meta"].glob("02/*.djayMetadata"))
    ver_path.write_bytes(make_plist(straight_beats(), version=9))
    next(world["meta"].glob("00/*.djayMetadata")).unlink()
    third = run_job(client)["report"]
    assert third["unknown_version"] == 1 and third["removed"] == 1  # "ver" lost its row
    assert third["transient"] == 2
    assert "00" * 16 in {r.source_uuid for r in grids().values()}
    status = client.get("/api/import/djay").json()
    assert status["grids"] == 4 and status["sources"]["library"] == str(world["live"])


def test_remove_deletes_only_djay_rows_and_is_rejected_while_busy(world):
    from app.db import get_engine
    from app.jobs import worker

    client = world["client"]
    run_job(client)
    with Session(get_engine()) as session:
        first = session.exec(select(Track)).first()
        session.add(TrackBeatgrid(track_id=first.id, source="other", source_uuid="x", bpm=99.0))
        session.commit()
        busy = worker.create_job(session, "djay_import")  # an import "in flight"
        assert client.delete("/api/import/djay").status_code == 409
        assert client.post("/api/import/djay").status_code == 409
        busy.status = "done"
        session.add(busy)
        session.commit()
        worker._starting_jobs.clear()
    removed = client.delete("/api/import/djay")
    assert removed.status_code == 200 and removed.json()["removed"] == 5
    with Session(get_engine()) as session:
        left = session.exec(select(TrackBeatgrid)).all()
        assert [(row.source, row.bpm) for row in left] == [("other", 99.0)]
        assert session.exec(select(Track)).first() is not None


def test_beatgrid_route_returns_stored_grid_or_404(world):
    client = world["client"]
    assert client.get("/api/tracks/9999/beatgrid").status_code == 404
    run_job(client)
    by_uuid = {row.source_uuid: row for row in grids().values()}
    straight = client.get(f"/api/tracks/{by_uuid['00' * 16].track_id}/beatgrid")
    assert straight.status_code == 200
    body = straight.json()
    assert body["straight"] is True and body["beats"] is None and body["source"] == "djay"
    assert body["first_downbeat_index"] == 2 and body["bpm"] == pytest.approx(120.0)
    dynamic = client.get(f"/api/tracks/{by_uuid['01' * 16].track_id}/beatgrid").json()
    assert dynamic["straight"] is False and len(dynamic["beats"]) == 200
    # An edited grid has no usable beats, and an unimported track has no row.
    assert client.get(f"/api/tracks/{by_uuid['04' * 16].track_id}/beatgrid").status_code == 404
    with Session(__import__("app.db", fromlist=["get_engine"]).get_engine()) as session:
        ghost = session.exec(select(Track).where(Track.file_name == "ghost.mp3")).one()
    assert client.get(f"/api/tracks/{ghost.id}/beatgrid").status_code == 404


def test_missing_library_is_a_fatal_job_error_with_greek_message(world, monkeypatch):
    monkeypatch.setenv("CRATEMIND_DJAY_LIBRARY", str(world["tmp"] / "nope" / "MediaLibrary.db"))
    import app.config as cfg

    cfg.get_settings.cache_clear()
    status = run_job(world["client"])
    assert status["job"]["status"] == "error" and "Δεν βρέθηκε η βιβλιοθήκη του djay" in status["job"]["error"]
    assert grids() == {}


def test_upsert_touches_imported_at_only_on_real_change(db):
    track = Track(absolute_path="/x/a.mp3", file_name="a.mp3")
    db.add(track)
    db.commit()
    content = {"source_uuid": "u", "bpm": 120.0, "straight": True, "anchor_s": 0.5, "first_downbeat_index": 0,
               "beats": None, "residual_ms": 1.0, "confidence": 0.9, "edited": False, "key_index": 1,
               "source_version": 8}
    assert dj._upsert(db, track.id, content) == "added"
    db.commit()
    stamp = db.exec(select(TrackBeatgrid)).one().imported_at
    assert dj._upsert(db, track.id, dict(content)) == "unchanged"
    db.commit()
    assert db.exec(select(TrackBeatgrid)).one().imported_at == stamp
    assert dj._upsert(db, track.id, {**content, "anchor_s": 0.6}) == "updated"
    db.commit()
    assert db.exec(select(TrackBeatgrid)).one().imported_at > stamp


def test_upsert_removes_the_other_row_when_a_uuid_moves_to_another_track(db):
    one, two = Track(absolute_path="/x/a.mp3", file_name="a.mp3"), Track(absolute_path="/x/b.mp3", file_name="b.mp3")
    db.add(one)
    db.add(two)
    db.commit()
    content = {"source_uuid": "u", "bpm": 120.0, "straight": True, "anchor_s": 0.5, "first_downbeat_index": 0,
               "beats": None, "residual_ms": 1.0, "confidence": 0.9, "edited": False, "key_index": 1,
               "source_version": 8}
    dj._upsert(db, one.id, content)
    db.commit()
    assert dj._upsert(db, two.id, content) == "added"
    db.commit()
    rows = db.exec(select(TrackBeatgrid)).all()
    assert [(r.track_id, r.source_uuid) for r in rows] == [(two.id, "u")]


# ---- schema contract + rollout protection ---------------------------------------------------------

def test_contract_lists_the_table_and_a_catalog_without_it_is_pending(tmp_path):
    from sqlmodel import SQLModel, create_engine

    from app.db import _missing_schema
    from app.services.schema_contract import inspect_schema, load_schema_contract

    contract = load_schema_contract()["normalized_catalog_schema"]
    assert "track_beatgrids" in contract["tables"]
    full = tmp_path / "full.sqlite"
    engine = create_engine(f"sqlite:///{full}")
    SQLModel.metadata.create_all(engine)
    engine.dispose()
    assert "track_beatgrids" in inspect_schema(full)["tables"]
    with sqlite3.connect(full) as connection:
        connection.execute("DROP TABLE track_beatgrids")
    assert _missing_schema(contract, inspect_schema(full))


@pytest.mark.parametrize("profile", ["web", "desktop-core"])
def test_first_migrated_launch_takes_a_real_pre_migration_backup_before_init_db(tmp_path, monkeypatch, profile):
    """Dataset-root startup (desktop and web) backs up BEFORE init_db adds the table."""
    import app.config as cfg
    import app.db as dbmod
    from fastapi.testclient import TestClient

    from app.app_factory import create_app
    from app.library_exchange.operations import initialize_empty

    for name in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH", "CRATEMIND_BACKUP_DIR", "CRATEMIND_OUTPUT_DIR"):
        monkeypatch.delenv(name, raising=False)
    dataset = initialize_empty(tmp_path / "data")
    with sqlite3.connect(dataset.catalog_path) as connection:  # make it a pre-J catalog
        connection.execute("DROP TABLE track_beatgrids")
        connection.commit()
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(dataset.dataset_root))
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", profile)
    cfg.get_settings.cache_clear()
    monkeypatch.setattr(dbmod, "_engine", None)
    monkeypatch.setattr(dbmod, "_settings", cfg.get_settings())

    events = []
    real_backup, real_init = dbmod.backup_on_launch, dbmod.init_db

    def backup():
        bundle = real_backup()
        events.append(("backup", bundle))
        return bundle

    def init():
        events.append(("init_db", None))
        return real_init()

    monkeypatch.setattr(dbmod, "backup_on_launch", backup)
    monkeypatch.setattr(dbmod, "init_db", init)
    with TestClient(create_app()) as client:
        assert client.get("/api/health").status_code == 200
    dbmod.get_engine().dispose()
    cfg.get_settings.cache_clear()

    assert [name for name, _ in events] == ["backup", "init_db"]
    bundle = events[0][1]
    assert bundle is not None and dbmod.launch_phase["backup"].startswith("new:")
    with sqlite3.connect(Path(bundle) / "catalog.sqlite") as connection:
        names = {row[0] for row in connection.execute("select name from sqlite_master")}
    assert "track_beatgrids" not in names and "tracks" in names  # a real pre-migration copy
    with sqlite3.connect(dataset.catalog_path) as connection:
        assert connection.execute("select name from sqlite_master where name='track_beatgrids'").fetchone()
