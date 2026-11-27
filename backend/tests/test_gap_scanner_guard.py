"""Scanner gaps: the mass-missing guard's boundaries, per-root counting, moves across roots,
unicode file names and missing-count idempotency. Hand-made WAV fixtures only."""
from __future__ import annotations

import pytest
from sqlmodel import select

from app.models import Track, TrackDJProfile
from app.services import scanner
from tests.conftest import make_wav


def _files(root, count, first_seed=1):
    # Distinct seeds give distinct bytes, so no two fixtures share a quick_hash.
    return [make_wav(root / f"t{index:03d}.wav", seconds=0.05, freq_seed=first_seed + index)
            for index in range(count)]


@pytest.mark.parametrize("known,gone,marked", [
    (19, 19, 19),   # below MASS_MISSING_MIN_TRACKS: a small folder may be emptied
    (20, 10, 10),   # exactly half is not "more than half"
    (21, 10, 10),
    (21, 11, 0),    # 22 > 21: held back
    (40, 20, 20),
    (40, 21, 0),
])
def test_guard_boundaries(db, tmp_path, known, gone, marked):
    lib = tmp_path / "lib"
    files = _files(lib, known)
    assert scanner.scan(db, [lib])["added"] == known
    for path in files[:gone]:
        path.unlink()

    stats = scanner.scan(db, [lib])
    assert stats["missing"] == marked
    assert sum(t.missing for t in db.exec(select(Track)).all()) == marked
    if marked:
        assert stats["warnings"] == []
    else:
        (warning,) = stats["warnings"]
        assert f"λείπουν {gone} από τα {known} tracks" in warning and scanner.MASS_MISSING_NOTE in warning


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_guard_holds_back_one_root_and_still_marks_its_sibling(db, tmp_path, mode):
    big, small = tmp_path / "big", tmp_path / "small"
    big_files = _files(big, 20)
    small_files = _files(small, 3, first_seed=50)
    scanner.scan(db, [big, small])
    for path in big_files[:15]:
        path.unlink()
    small_files[0].unlink()

    stats = scanner.scan(db, [big, small], mode=mode)
    assert stats["missing"] == 1
    (warning,) = stats["warnings"]
    assert warning.startswith(f"{big}:")
    missing = {t.absolute_path for t in db.exec(select(Track)).all() if t.missing}
    assert missing == {str(small_files[0])}


def test_missing_count_reports_only_newly_missing_rows(db, tmp_path):
    lib = tmp_path / "lib"
    a, _ = _files(lib, 2)
    scanner.scan(db, [lib])
    a.unlink()
    assert scanner.scan(db, [lib])["missing"] == 1
    again = scanner.scan(db, [lib])
    assert (again["missing"], again["merged_moved"], again["warnings"]) == (0, 0, [])
    rows = {t.file_name: t.missing for t in db.exec(select(Track)).all()}
    assert rows == {"t000.wav": True, "t001.wav": False}


def test_moved_files_leave_the_guard_count_and_real_deletions_are_marked(db, tmp_path):
    lib = tmp_path / "lib"
    files = _files(lib, 20)
    scanner.scan(db, [lib])
    (lib / "sub").mkdir()
    for path in files[:15]:
        path.rename(lib / "sub" / path.name)
    for path in files[15:18]:
        path.unlink()

    stats = scanner.scan(db, [lib])
    assert stats["warnings"] == [] and stats["merged_moved"] == 15
    rows = db.exec(select(Track)).all()
    assert len(rows) == 20
    assert sorted(t.file_name for t in rows if t.missing) == ["t015.wav", "t016.wav", "t017.wav"]


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_move_to_another_root_merges_once_the_old_root_is_scanned(db, tmp_path, mode):
    crate_a, crate_b = tmp_path / "a", tmp_path / "b"
    song = make_wav(crate_a / "Artist - Song.wav", freq_seed=7)
    make_wav(crate_a / "keep.wav", freq_seed=8)
    crate_b.mkdir()
    scanner.scan(db, [crate_a, crate_b])
    old = db.exec(select(Track).where(Track.file_name == "Artist - Song.wav")).one()
    old_id = old.id
    db.add(TrackDJProfile(track_id=old_id, energy=8, personal_status="weapon"))
    db.commit()
    moved = crate_b / song.name
    song.rename(moved)

    # Only the new root: the old row is outside the scan, so it is neither missing nor merged.
    only_b = scanner.scan(db, [crate_b], mode=mode)
    assert (only_b["added"], only_b["missing"], only_b["merged_moved"]) == (1, 0, 0)
    assert db.get(Track, old_id).missing is False

    both = scanner.scan(db, [crate_a, crate_b], mode=mode)
    assert both["merged_moved"] == 1
    db.expire_all()
    assert db.get(Track, old_id) is None
    new = db.exec(select(Track).where(Track.absolute_path == str(moved))).one()
    assert new.missing is False and db.get(TrackDJProfile, new.id).personal_status == "weapon"


_UNICODE_NAMES = [
    "Καλημέρα - Ξημέρωμα.wav",
    "Café del Mar.wav",            # decomposed accent (NFD)
    "Café del Mar (NFC).wav",
    "DJ 🎧 Set.wav",
    "東京 Drift.wav",
    "  spaced  name .wav",
    "O'Neil & \"Quotes\" [Live] 100%.wav",
    "semi;colon,comma#hash.wav",
]


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_unicode_and_odd_file_names_rescan_without_new_rows_or_missing(db, tmp_path, mode):
    lib = tmp_path / "lib"
    for seed, name in enumerate(_UNICODE_NAMES, start=1):
        make_wav(lib / "Φάκελος" / name, seconds=0.05, freq_seed=seed)
    first = scanner.scan(db, [lib], mode=mode)
    assert first["added"] == len(_UNICODE_NAMES)
    second = scanner.scan(db, [lib], mode=mode)
    assert (second["added"], second["missing"], second["unchanged"]) == (0, 0, len(_UNICODE_NAMES))
    rows = db.exec(select(Track)).all()
    assert len(rows) == len(_UNICODE_NAMES) and not any(t.missing for t in rows)


@pytest.mark.parametrize("old,new", [
    ("Καλημέρα.wav", "Νέος φάκελος/Καλημέρα (edit).wav"),
    ("plain.wav", "Ελληνικά/πρωί.wav"),
    ("DJ 🎧 Set.wav", "sets/DJ 🎧 Set v2.wav"),
])
def test_unicode_rename_keeps_the_users_work(db, tmp_path, old, new):
    lib = tmp_path / "lib"
    source = make_wav(lib / old, freq_seed=11)
    make_wav(lib / "other.wav", freq_seed=12)
    scanner.scan(db, [lib])
    track = db.exec(select(Track).where(Track.absolute_path == str(source))).one()
    db.add(TrackDJProfile(track_id=track.id, energy=6))
    db.commit()
    target = lib / new
    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)

    stats = scanner.scan(db, [lib])
    assert stats["merged_moved"] == 1
    db.expire_all()
    survivor = db.exec(select(Track).where(Track.absolute_path == str(target))).one()
    assert db.get(TrackDJProfile, survivor.id).energy == 6
    assert len(db.exec(select(Track)).all()) == 2
