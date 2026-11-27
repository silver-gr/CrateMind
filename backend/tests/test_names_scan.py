"""«Καθαρά ονόματα», scan lane: the raw tag read in read_tags, the scanner's raw_* columns (add, change, full scan,
the delta backfill), unreadable apart from never read, merges, and the scan-end hook. Invented names, files built
by hand in tmp_path."""
from __future__ import annotations

import os
import unicodedata

from mutagen.id3 import TALB, TIT2, TPE1, TRCK
from sqlalchemy import text
from sqlmodel import select

from app.models import Job, Track
from app.services import metadata_reader, scanner
from tests.test_names_scan_audio import flac, m4a, mp3, t, wav

RAW = ("raw_artist", "raw_title", "raw_album", "raw_track_no", "raw_state")


def _raw(read: dict) -> tuple:
    return tuple(read[k] for k in RAW)


def _row(db, track_id: int) -> dict:
    return dict(db.execute(text("SELECT * FROM tracks WHERE id = :id"), {"id": track_id}).mappings().one())


def _raw_row(db, track_id: int) -> tuple:
    row = _row(db, track_id)
    return tuple(row[k] for k in RAW)


# ------------------------------------------------------------------------------------------------ read_tags


def test_mp3_raw_is_the_first_value_of_each_frame_before_any_clean_up(tmp_path):
    path = mp3(tmp_path / "x.mp3", t(TPE1, ["Kestro", "Ommi"]), t(TIT2, "  Nightfold (Kestro Remix) 145 FREE DL "),
               t(TALB, ["Tide EP", "Other"]), t(TRCK, "3/12"))
    read = metadata_reader.read_tags(path)
    assert _raw(read) == ("Kestro", "Nightfold (Kestro Remix) 145 FREE DL", "Tide EP", "3/12", "ok")
    assert read["title"] != read["raw_title"]  # the cleaned title is still the one read_tags gives


def test_raw_values_are_nfc(tmp_path):
    decomposed = unicodedata.normalize("NFD", "Café Nöir")
    read = metadata_reader.read_tags(mp3(tmp_path / "x.mp3", t(TPE1, decomposed), t(TIT2, decomposed)))
    assert read["raw_artist"] == read["raw_title"] == "Café Nöir"
    assert unicodedata.is_normalized("NFC", read["raw_artist"])


def test_mp4_raw_reads_the_track_number_pair(tmp_path):
    path = m4a(tmp_path / "x.m4a", {"\xa9ART": "Orvalo", "\xa9nam": "Deep Current [Free DL]", "\xa9alb": "Fernwave",
                                     "trkn": [(5, 9)]})
    assert _raw(metadata_reader.read_tags(path)) == ("Orvalo", "Deep Current [Free DL]", "Fernwave", "5/9", "ok")


def test_flac_raw_reads_tracknumber_and_the_first_artist(tmp_path):
    path = flac(tmp_path / "x.flac", artist=["Brimo", "Sulmo"], title="Static", album="Low Ridge", tracknumber="07")
    assert _raw(metadata_reader.read_tags(path)) == ("Brimo", "Static", "Low Ridge", "07", "ok")


def test_wav_id3_chunk_raw(tmp_path):
    path = wav(tmp_path / "Mirelo - Sunfall.wav", t(TPE1, "Halvex Records"), t(TIT2, "Halvex Records - Mirelo - Sunfall"))
    read = metadata_reader.read_tags(path)
    assert _raw(read) == ("Halvex Records", "Halvex Records - Mirelo - Sunfall", None, None, "ok")
    assert read["artist"] == "Mirelo"


def test_a_file_without_tags_is_read_with_nothing_in_it(tmp_path):
    read = metadata_reader.read_tags(wav(tmp_path / "Pallor - Ember Rise.wav"))
    assert _raw(read) == (None, None, None, None, "ok")
    assert read["artist"] == "Pallor"  # the file-name fill never reaches the raw keys


def test_empty_frames_read_as_none(tmp_path):
    read = metadata_reader.read_tags(mp3(tmp_path / "Sulmo - Quiet.mp3", t(TPE1, "  "), t(TIT2, "")))
    assert _raw(read) == (None, None, None, None, "ok")


def test_unreadable_files_say_so(tmp_path):
    junk = tmp_path / "notes.mp3"
    junk.write_bytes(b"not audio at all")
    for path in (junk, tmp_path / "gone.flac"):
        assert metadata_reader.read_tags(path) == {"raw_artist": None, "raw_title": None, "raw_album": None,
                                                  "raw_track_no": None, "raw_state": "unreadable"}


def test_a_failed_second_open_is_unreadable_and_the_rest_reads_as_before(tmp_path, monkeypatch):
    path = mp3(tmp_path / "Kestro - Nightfold.mp3", t(TPE1, "Kestro"), t(TIT2, "Nightfold"))
    before = {k: v for k, v in metadata_reader.read_tags(path).items() if k not in RAW}
    real = metadata_reader.MutagenFile

    def easy_only(p, *args, **kwargs):
        if not kwargs.get("easy"):
            raise OSError("second open failed")
        return real(p, *args, **kwargs)

    monkeypatch.setattr(metadata_reader, "MutagenFile", easy_only)
    read = metadata_reader.read_tags(path)
    assert read["raw_state"] == "unreadable" and read["raw_artist"] is None
    assert {k: v for k, v in read.items() if k not in RAW} == before


# ------------------------------------------------------------------------------------------------ the scanner


def _one(db) -> Track:
    return db.exec(select(Track)).one()


def test_a_new_file_gets_its_raw_columns_and_the_folder_fallback_never_touches_them(db, tmp_path):
    lib = tmp_path / "lib"
    wav(lib / "Velmora" / "Glass Harbor" / "untitled.wav")  # no tags: artist and album come from the folders
    stats = scanner.scan(db, [lib], mode="delta")
    track = _one(db)
    assert stats["added"] == 1
    assert (track.artist, track.album) == ("Velmora", "Glass Harbor")
    assert _raw_row(db, track.id) == (None, None, None, None, "ok")


def test_a_new_file_with_tags(db, tmp_path):
    lib = tmp_path / "lib"
    mp3(lib / "x.mp3", t(TPE1, "2 Druvan"), t(TIT2, "Lantern Sky"), t(TRCK, "4"))
    scanner.scan(db, [lib])
    track = _one(db)
    assert track.artist == "Druvan"
    assert _raw_row(db, track.id) == ("2 Druvan", "Lantern Sky", None, "4", "ok")


def test_a_changed_file_refreshes_its_raw_columns(db, tmp_path):
    lib = tmp_path / "lib"
    path = mp3(lib / "x.mp3", t(TPE1, "Druvan"), t(TIT2, "Lantern Sky"))
    scanner.scan(db, [lib], mode="delta")
    mp3(path, t(TPE1, "Druvan & Ommi"), t(TIT2, "Lantern Sky (VIP)"), t(TALB, "Night EP"))
    os.utime(path, (1_700_000_000, 1_700_000_000))
    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["updated"] == 1
    assert _raw_row(db, _one(db).id) == ("Druvan & Ommi", "Lantern Sky (VIP)", "Night EP", None, "ok")


def test_a_full_scan_refills_raw_columns_without_counting_the_row_updated(db, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    mp3(lib / "x.mp3", t(TPE1, "Druvan"), t(TIT2, "Lantern Sky"))
    scanner.scan(db, [lib])
    track_id = _one(db).id
    db.execute(text("UPDATE tracks SET raw_artist = 'stale', raw_title = NULL, raw_state = NULL"))
    db.commit()
    monkeypatch.setattr(scanner, "reindex_track", _forbidden)
    stats = scanner.scan(db, [lib], mode="full")
    assert (stats["updated"], stats["unchanged"]) == (0, 1)
    assert _raw_row(db, track_id) == ("Druvan", "Lantern Sky", None, None, "ok")


def _forbidden(*args, **kwargs):
    raise AssertionError("the raw backfill did work it must not do")


def test_the_delta_backfill_writes_only_the_raw_columns(db, tmp_path, monkeypatch):
    from app.services import identity_sync

    lib = tmp_path / "lib"
    mp3(lib / "x.mp3", t(TPE1, "2 Druvan"), t(TIT2, "Lantern Sky 150"), t(TALB, "Night EP"), t(TRCK, "1/3"))
    scanner.scan(db, [lib])
    track_id = _one(db).id
    # A row scanned before the raw columns existed, whose stored artist is not what read_tags would give today.
    db.execute(text("UPDATE tracks SET artist = 'Stored Name', raw_artist = NULL, raw_title = NULL, raw_album = NULL,"
                    " raw_track_no = NULL, raw_state = NULL"))
    db.commit()
    before = {k: v for k, v in _row(db, track_id).items() if k not in RAW}
    fts_before = db.execute(text("SELECT * FROM track_search")).all()
    sync_flags = []
    monkeypatch.setattr(scanner, "reindex_track", _forbidden)
    monkeypatch.setattr(scanner, "_read_file_record", _forbidden)
    monkeypatch.setattr(scanner, "_read_embedded_record", _forbidden)
    monkeypatch.setattr(scanner.hashing, "quick_hash", _forbidden)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", _forbidden)
    monkeypatch.setattr(identity_sync, "sync_session", lambda session, **kw: sync_flags.append(kw) or {})

    stats = scanner.scan(db, [lib], mode="delta")

    assert (stats["unchanged"], stats["updated"], stats["added"]) == (1, 0, 0)
    assert sync_flags == [{"rederive_unchanged": False}]
    db.expire_all()
    assert _raw_row(db, track_id) == ("2 Druvan", "Lantern Sky 150", "Night EP", "1/3", "ok")
    after = {k: v for k, v in _row(db, track_id).items() if k not in RAW}
    assert {k: v for k, v in after.items() if k != "last_scanned_at"} == \
        {k: v for k, v in before.items() if k != "last_scanned_at"}
    assert after["artist"] == "Stored Name"
    assert db.execute(text("SELECT * FROM track_search")).all() == fts_before


def test_the_delta_backfill_runs_once_and_never_retries_an_unreadable_file(db, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    mp3(lib / "good.mp3", t(TPE1, "Druvan"), t(TIT2, "Lantern Sky"))
    junk = lib / "Ommi - Broken.mp3"
    junk.write_bytes(b"not audio at all")
    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["added"] == 2
    states = {r.file_name: _raw_row(db, r.id)[-1] for r in db.exec(select(Track)).all()}
    assert states == {"good.mp3": "ok", "Ommi - Broken.mp3": "unreadable"}

    monkeypatch.setattr(scanner.metadata_reader, "read_tags", _forbidden)
    assert scanner.scan(db, [lib], mode="delta")["unchanged"] == 2


def test_a_full_scan_retries_an_unreadable_file(db, tmp_path):
    lib = tmp_path / "lib"
    path = lib / "x.mp3"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not audio at all")
    scanner.scan(db, [lib])
    track_id = _one(db).id
    assert _raw_row(db, track_id)[-1] == "unreadable"
    stamp = path.stat()
    mp3(path, t(TPE1, "Druvan"))
    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    db.execute(text("UPDATE tracks SET file_size = :size"), {"size": path.stat().st_size})
    db.commit()
    scanner.scan(db, [lib], mode="full")
    assert _raw_row(db, track_id) == ("Druvan", None, None, None, "ok")


def test_a_merge_keeps_the_surviving_rows_raw_columns(db, tmp_path):
    lib = tmp_path / "lib"
    mp3(lib / "old.mp3", t(TPE1, "Old Tag"), t(TIT2, "Old Title"))
    wav(lib / "new.wav")
    scanner.scan(db, [lib])
    old = db.exec(select(Track).where(Track.file_name == "old.mp3")).one().id
    new = db.exec(select(Track).where(Track.file_name == "new.wav")).one().id
    db.execute(text("UPDATE tracks SET raw_state = NULL WHERE id = :id"), {"id": new})
    db.commit()
    scanner.merge_tracks(db, [(old, new)])
    db.commit()
    # The survivor's file is the one whose tags count: never the old file's, even where the survivor has none.
    assert _raw_row(db, new) == (None, None, None, None, None)


def test_a_finished_scan_asks_for_a_names_run(db, tmp_path, monkeypatch):
    from app.jobs import worker
    from app.services import names_store

    lib = tmp_path / "lib"
    lib.mkdir()
    calls = []
    monkeypatch.setattr(names_store, "request_run", lambda cause, **kw: calls.append((cause, kw)) or False)
    job = worker.create_job(db, "scan")
    worker._run_scan(job.id, [str(lib)], "delta")
    db.expire_all()
    assert db.get(Job, job.id).status == "done"
    assert calls == [("scan", {})]
