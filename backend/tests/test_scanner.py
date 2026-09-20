"""Scanner idempotency, missing-file marking, and human-work preservation."""
from __future__ import annotations

from sqlmodel import select

from app.models import Track, TrackDJProfile
from app.services import scanner
from tests.conftest import make_wav


def _lib(tmp_path):
    return tmp_path / "lib"


def test_scan_is_idempotent(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "a.wav", freq_seed=1)
    make_wav(lib / "b.wav", freq_seed=2)

    s1 = scanner.scan(db, [lib])
    assert s1["added"] == 2

    s2 = scanner.scan(db, [lib])
    assert s2["added"] == 0
    assert s2["unchanged"] == 2

    # no duplicate rows after repeated scans
    assert len(db.exec(select(Track)).all()) == 2


def test_removed_file_marked_missing_not_deleted(db, tmp_path):
    lib = _lib(tmp_path)
    a = make_wav(lib / "a.wav", freq_seed=1)
    make_wav(lib / "b.wav", freq_seed=2)
    scanner.scan(db, [lib])

    a.unlink()
    stats = scanner.scan(db, [lib])
    assert stats["missing"] == 1

    rows = {t.file_name: t for t in db.exec(select(Track)).all()}
    assert "a.wav" in rows          # row preserved
    assert rows["a.wav"].missing is True
    assert rows["b.wav"].missing is False


def test_human_profile_survives_rescan(db, tmp_path):
    lib = _lib(tmp_path)
    a = make_wav(lib / "a.wav", freq_seed=1)
    scanner.scan(db, [lib])
    track = db.exec(select(Track)).first()

    db.add(TrackDJProfile(track_id=track.id, energy=9, personal_status="weapon"))
    db.commit()

    # change the file so the scanner takes the "updated" path
    a.write_bytes(a.read_bytes() + b"\x00\x00")
    scanner.scan(db, [lib])

    prof = db.get(TrackDJProfile, track.id)
    assert prof is not None
    assert prof.energy == 9
    assert prof.personal_status == "weapon"


def test_scan_maintains_artist_normalized_for_new_and_updated_tracks(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    a = make_wav(lib / "a.wav", freq_seed=1)
    scanner.scan(db, [lib])
    track = db.exec(select(Track)).first()
    assert track.artist_normalized is None

    monkeypatch.setattr(
        scanner.metadata_reader,
        "read_tags",
        lambda _path: {"artist": "ATYYA", "title": None, "album": None, "label": None,
                       "year": None, "genre": None, "comment": None, "bpm": None,
                       "key_text": None, "rating": None},
    )

    a.write_bytes(a.read_bytes() + b"\x00\x01")
    scanner.scan(db, [lib])

    refreshed = db.get(Track, track.id)
    assert refreshed is not None
    assert refreshed.artist_normalized == "atyya"


def test_scan_infers_artist_from_parent_folder_when_filename_is_title_only(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "ATYYA" / "Desert.wav", freq_seed=1)

    scanner.scan(db, [lib])

    track = db.exec(select(Track)).first()
    assert track is not None
    assert track.artist == "ATYYA"
    assert track.title == "Desert"
    assert track.artist_normalized == "atyya"


def test_scan_infers_artist_and_album_from_two_level_folders(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "ATYYA" / "Live at Boom" / "Desert.wav", freq_seed=1)

    scanner.scan(db, [lib])

    track = db.exec(select(Track)).first()
    assert track is not None
    assert track.artist == "ATYYA"
    assert track.album == "Live at Boom"
    assert track.title == "Desert"
    assert track.artist_normalized == "atyya"


def test_scan_uses_filename_bpm_and_cleans_title(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "XENROX" / "INTO THE WORLD [192] (FREE DOWNLOAD).wav", freq_seed=1)

    scanner.scan(db, [lib])

    track = db.exec(select(Track)).first()
    assert track is not None
    assert track.artist == "XENROX"
    assert track.title == "INTO THE WORLD"
    assert track.bpm == 192.0


def test_scan_does_not_use_label_folder_as_artist_when_filename_has_artist(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "Izuran Records" / "VA-The Arkhetupon Dialectic" / "Izuran Records - Black Phillip - Place of Dead Roads.wav", freq_seed=1)

    scanner.scan(db, [lib])

    track = db.exec(select(Track)).first()
    assert track is not None
    assert track.artist == "Black Phillip"
    assert track.album == "VA-The Arkhetupon Dialectic"
    assert track.label == "Izuran Records"


def test_scan_refreshes_unchanged_rows_with_cleaned_metadata(db, tmp_path):
    lib = _lib(tmp_path)
    make_wav(lib / "Crone" / "Brain Rolling (Kopophobia Rmx) - 207 (Preview).wav", freq_seed=1)

    scanner.scan(db, [lib])
    track = db.exec(select(Track)).first()
    assert track is not None

    track.artist = "02"
    track.title = "Brain Rolling (Kopophobia Rmx) - 207 (Preview)"
    track.bpm = None
    track.artist_normalized = None
    db.add(track)
    db.commit()

    stats = scanner.scan(db, [lib])
    refreshed = db.get(Track, track.id)
    assert stats["updated"] == 1
    assert refreshed is not None
    assert refreshed.artist == "Crone"
    assert refreshed.title == "Brain Rolling (Kopophobia Rmx)"
    assert refreshed.bpm == 207.0
    assert refreshed.artist_normalized == "crone"



def test_delta_skips_unchanged_reads_and_writes(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    make_wav(lib / "a.wav")
    scanner.scan(db, [lib])
    before = db.exec(select(Track)).one().model_dump()
    def forbidden(*args):
        raise AssertionError("unchanged file read")
    monkeypatch.setattr(scanner, "_read_file_record", forbidden)
    monkeypatch.setattr(scanner, "_read_embedded_record", forbidden)
    assert scanner.scan(db, [lib], mode="delta")["unchanged"] == 1
    assert db.exec(select(Track)).one().model_dump() == before


def test_delta_new_changed_restored(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    for name in ("a", "b", "c"):
        make_wav(lib / f"{name}.wav")
    scanner.scan(db, [lib])
    restored = db.exec(select(Track).where(Track.file_name == "c.wav")).one()
    restored.missing = True
    db.add(restored)
    db.add(TrackDJProfile(track_id=restored.id, energy=9))
    db.commit()
    path = lib / "b.wav"
    path.write_bytes(path.read_bytes() + bytes(2))
    make_wav(lib / "d.wav")
    original = scanner._read_file_record
    reads = []
    def read(path, *args):
        reads.append(path.name)
        return original(path, *args)
    monkeypatch.setattr(scanner, "_read_file_record", read)
    stats = scanner.scan(db, [lib], mode="delta")
    assert sorted(reads) == ["b.wav", "c.wav", "d.wav"]
    assert (stats["added"], stats["updated"], stats["unchanged"]) == (1, 2, 1)
    assert db.get(TrackDJProfile, restored.id).energy == 9
    assert not db.get(Track, restored.id).missing


def test_delta_missing_requires_complete_scoped_root(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    sibling = tmp_path / "lib-other"
    a = make_wav(lib / "a.wav")
    make_wav(sibling / "b.wav")
    scanner.scan(db, [lib, sibling])
    a.unlink()
    original = scanner.os.walk
    def inaccessible(root, onerror):
        onerror(PermissionError("denied"))
        return iter(())
    monkeypatch.setattr(scanner.os, "walk", inaccessible)
    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["missing"] == 0 and stats["warnings"]
    monkeypatch.setattr(scanner.os, "walk", original)
    assert scanner.scan(db, [lib], mode="delta")["missing"] == 1
    assert not db.exec(select(Track).where(Track.file_name == "b.wav")).one().missing
    sibling.rename(tmp_path / "unmounted")
    stats = scanner.scan(db, [sibling], mode="delta")
    assert stats["missing"] == 0 and stats["warnings"]
