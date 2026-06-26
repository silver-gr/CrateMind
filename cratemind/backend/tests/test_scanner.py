"""Scanner idempotency, missing-file marking, and human-work preservation."""
from __future__ import annotations

from datetime import datetime

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
