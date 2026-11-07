"""Scanner idempotency, missing-file marking, and human-work preservation."""
from __future__ import annotations

import pytest
from sqlmodel import select

from app.models import AuditLog, DJSet, SetTrack, Track, TrackDJProfile
from app.services import scanner
from tests.conftest import make_wav


def _lib(tmp_path):
    return tmp_path / "lib"


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_renamed_file_merges_into_new_row(db, tmp_path, mode):
    lib = _lib(tmp_path)
    original = make_wav(lib / "Artist - Song.wav", freq_seed=1)
    make_wav(lib / "other.wav", freq_seed=2)
    scanner.scan(db, [lib], mode=mode)
    old = db.exec(select(Track).where(Track.file_name == "Artist - Song.wav")).one()
    old_id, old.rating, old.play_count = old.id, 5, 2
    dj_set = DJSet(title="Set")
    db.add_all([old, dj_set, TrackDJProfile(track_id=old_id, energy=9, personal_status="weapon")])
    db.flush()
    db.add(SetTrack(set_id=dj_set.id, position=0, track_id=old_id))
    db.commit()
    renamed = lib / "Artist" / "01 Song.wav"
    renamed.parent.mkdir()
    original.rename(renamed)
    data = renamed.read_bytes()

    stats = scanner.scan(db, [lib], mode=mode)
    assert stats["added"] == stats["missing"] == stats["merged_moved"] == 1
    db.expire_all()
    new = db.exec(select(Track).where(Track.file_name == "01 Song.wav")).one()
    assert db.get(Track, old_id) is None and len(db.exec(select(Track)).all()) == 2
    assert (new.missing, new.rating, new.play_count) == (False, 5, 2)
    assert db.get(TrackDJProfile, new.id).personal_status == "weapon"
    assert db.exec(select(SetTrack)).one().track_id == new.id
    log = db.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).one()
    assert log.entity_id == old_id
    assert renamed.read_bytes() == data
    assert scanner.scan(db, [lib], mode=mode)["merged_moved"] == 0


def test_moved_merge_keeps_survivor_data_and_skips_ambiguous_copies(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner, "_has_available_duplicate", lambda *_: False)
    a = make_wav(lib / "a.wav", freq_seed=1)
    make_wav(lib / "b.wav", freq_seed=1)
    c = make_wav(lib / "c.wav", freq_seed=3)
    make_wav(lib / "d.wav", freq_seed=3)
    make_wav(lib / "e.wav", freq_seed=3)
    scanner.scan(db, [lib])
    ids = {t.file_name: t.id for t in db.exec(select(Track)).all()}
    db.add_all([TrackDJProfile(track_id=ids["a.wav"], energy=1), TrackDJProfile(track_id=ids["b.wav"], energy=8)])
    db.commit()
    a.unlink()
    c.unlink()

    stats = scanner.scan(db, [lib])
    assert stats["missing"] == 2 and stats["merged_moved"] == 1
    db.expire_all()
    assert db.get(Track, ids["a.wav"]) is None
    assert db.get(TrackDJProfile, ids["b.wav"]).energy == 8  # the available row's record wins
    assert db.get(Track, ids["c.wav"]).missing is True  # two copies: left for review
    log = db.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).one()
    assert '"energy": 1' in log.before_json


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


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_scan_skips_existing_recording_with_variant_download_metadata(db, tmp_path, monkeypatch, mode):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda p, *_: {
        "duration": 302.0 if "Official Audio" in p.name else 300.0,
    })
    original = make_wav(lib / "Alpha & Beta - Moon Garden.wav", freq_seed=1)
    scanner.scan(db, [lib], mode=mode)
    track = db.exec(select(Track)).one()
    db.add(TrackDJProfile(track_id=track.id, energy=9))
    db.commit()
    download = make_wav(
        lib / "Alpha and Beta - Moon Garden (Original Mix) [Official Audio].wav", freq_seed=2,
    )
    before = {p: p.read_bytes() for p in (original, download)}

    for _ in range(2):
        stats = scanner.scan(db, [lib], mode=mode)
        assert stats["added"] == 0
        assert stats["skipped_duplicates"] == 1
        assert stats["added_track_ids"] == []
        assert db.exec(select(Track)).one().id == track.id
        assert db.get(TrackDJProfile, track.id).energy == 9
    assert all(p.read_bytes() == data for p, data in before.items())


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_scan_checks_new_tracks_against_earlier_additions(db, tmp_path, monkeypatch, mode):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    make_wav(lib / "Alpha & Beta - Moon Garden.wav", freq_seed=1)
    make_wav(lib / "Alpha and Beta - Moon Garden (Original Mix).wav", freq_seed=2)

    stats = scanner.scan(db, [lib], mode=mode)
    assert stats["added"] == stats["skipped_duplicates"] == 1
    assert stats["added_track_ids"] == [db.exec(select(Track)).one().id]


@pytest.mark.parametrize("duration", [None, 0.0, -1.0, float("nan"), float("inf"), 310.0])
def test_scan_does_not_skip_without_matching_valid_duration(db, tmp_path, monkeypatch, duration):
    lib = _lib(tmp_path)
    make_wav(lib / "Alpha - Moon Garden.wav", freq_seed=1)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    scanner.scan(db, [lib], mode="delta")
    make_wav(lib / "Alpha - Moon Garden (Original Mix).wav", freq_seed=2)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": duration})

    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["added"] == 1
    assert stats["skipped_duplicates"] == 0


@pytest.mark.parametrize("name", [
    "Other Artist - Moon Garden.wav",
    "Alpha - Moon Garden (Live).wav",
    "Alpha - Moon Garden (Gamma Remix).wav",
    "Alpha - Moon Garden (Radio Edit).wav",
    "Alpha - Another Song.wav",
])
def test_scan_keeps_different_performers_songs_and_versions(db, tmp_path, monkeypatch, name):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    make_wav(lib / "Alpha - Moon Garden.wav", freq_seed=1)
    scanner.scan(db, [lib], mode="delta")
    make_wav(lib / name, freq_seed=2)

    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["added"] == 1
    assert stats["skipped_duplicates"] == 0


@pytest.mark.parametrize("missing", [False, True])
def test_scan_imports_replacement_when_previous_copy_is_unavailable(db, tmp_path, monkeypatch, missing):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    original = make_wav(lib / "Alpha - Moon Garden.wav", freq_seed=1)
    scanner.scan(db, [lib], mode="delta")
    old_track = db.exec(select(Track)).one()
    old_track.missing = missing
    db.add(old_track)
    db.commit()
    original.unlink()
    make_wav(lib / "downloads" / "Alpha - Moon Garden (Original Mix).wav", freq_seed=2)

    stats = scanner.scan(db, [lib / "downloads"], mode="delta")
    assert stats["added"] == 1
    assert stats["skipped_duplicates"] == 0


def test_scan_does_not_skip_against_metadata_of_a_changed_file(db, tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    original = make_wav(lib / "original.wav", freq_seed=1)
    download = lib / "download.wav"
    metadata = {original: {"artist": "Alpha", "title": "Moon Garden", "duration": 300.0}}
    read = scanner._read_file_record
    monkeypatch.setattr(scanner, "_read_file_record", lambda p, *a: {**read(p, *a), **metadata[p]})
    scanner.scan(db, [lib], mode="delta")
    original.write_bytes(original.read_bytes() + bytes(2))
    make_wav(download, freq_seed=2)
    metadata[original] = {"artist": "Alpha", "title": "Different Song", "duration": 300.0}
    metadata[download] = {"artist": "Alpha", "title": "Moon Garden", "duration": 300.0}
    monkeypatch.setattr(scanner, "_iter_delta_audio", lambda *_: iter([(lib, download, download.stat()), (lib, original, original.stat())]))

    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["added"] == 1
    assert stats["skipped_duplicates"] == 0


@pytest.mark.parametrize("original_title,download_title", [
    ("Moon Garden Part 1", "Moon Garden Part 2"),
    ("Moon Garden (Part 1)", "Moon Garden (Part 2)"),
    ("Moon Garden (2022 Remaster)", "Moon Garden (2024 Remaster)"),
    ("Moon Garden (Remastered 2022)", "Moon Garden (Remastered 2024)"),
])
def test_scan_preserves_numbered_parts_and_editions(db, tmp_path, monkeypatch, original_title, download_title):
    lib = _lib(tmp_path)
    monkeypatch.setattr(scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    make_wav(lib / f"Alpha - {original_title}.wav", freq_seed=1)
    scanner.scan(db, [lib], mode="delta")
    make_wav(lib / f"Alpha - {download_title}.wav", freq_seed=2)

    stats = scanner.scan(db, [lib], mode="delta")
    assert stats["added"] == 1
    assert stats["skipped_duplicates"] == 0


@pytest.mark.parametrize('mode', ['full', 'delta'])
def test_missing_detection_protects_offline_and_sibling_roots_but_marks_empty_root(db, tmp_path, mode):
    live, offline, sibling = [tmp_path / name for name in ('lib', 'offline', 'lib-other')]
    for root, name in ((live, 'a'), (offline, 'b'), (sibling, 'c')):
        make_wav(root / f'{name}.wav')
    scanner.scan(db, [live, offline, sibling])
    (live / 'a.wav').unlink()
    offline.rename(tmp_path / 'unmounted')
    stats = scanner.scan(db, [live, offline], mode=mode)
    rows = {track.file_name: track for track in db.exec(select(Track)).all()}
    assert stats['missing'] == 1
    assert rows['a.wav'].missing
    assert not rows['b.wav'].missing
    assert not rows['c.wav'].missing
    assert stats['warnings']


@pytest.mark.parametrize('mode', ['full', 'delta'])
def test_partial_traversal_cannot_mark_unvisited_files_missing(db, tmp_path, monkeypatch, mode):
    root = tmp_path / 'lib'
    for name in ('a.wav', 'hidden/b.wav'):
        make_wav(root / name)
    scanner.scan(db, [root])

    def partial_walk(root, onerror):
        yield str(root), ['hidden'], ['a.wav']
        onerror(PermissionError('subfolder unreadable'))

    monkeypatch.setattr(scanner.os, 'walk', partial_walk)
    stats = scanner.scan(db, [root], mode=mode)
    assert stats['scanned'] == 1
    assert stats['missing'] == 0
    assert stats['warnings']


def test_scan_commits_catalog_before_identity_and_retries_unchanged_delta(db, tmp_path, monkeypatch):
    from sqlmodel import Session

    from app.services import identity_sync

    root = tmp_path / 'lib'
    make_wav(root / 'a.wav')
    calls = []

    def synchronize(session, track_ids=None, **kwargs):
        with Session(session.get_bind()) as independent:
            calls.append(independent.exec(select(Track)).one().id)
        if len(calls) == 1:
            raise RuntimeError('identity unavailable')
        return {'updated': 1}

    monkeypatch.setattr(identity_sync, 'sync_session', synchronize)
    monkeypatch.setattr(identity_sync, 'replay_mirror_intents', lambda session: 0)
    with pytest.raises(RuntimeError, match='identity'):
        scanner.scan(db, [root], mode='delta')
    original = db.exec(select(Track)).one().model_dump()
    assert scanner.scan(db, [root], mode='delta')['unchanged'] == 1
    assert calls == [original['id'], original['id']]
    assert db.exec(select(Track)).one().model_dump() == original


def test_scan_batches_catalog_and_fts_commits_without_losing_search_rows(db, tmp_path):
    from sqlalchemy import event, text

    from app.models import Job

    root = tmp_path / 'lib'
    for index in range(12):
        make_wav(root / f'Artist{index} - Title{index}.wav')
    job = Job(kind='scan', status='running')
    db.add(job)
    db.commit()
    commits = []
    event.listen(db, 'after_commit', lambda session: commits.append(True))
    stats = scanner.scan(db, [root], job=job)
    assert stats['added'] == 12
    assert len(commits) <= 2
    assert db.execute(text('SELECT count(*) FROM track_search')).scalar() == 12
    assert job.processed == 12


@pytest.mark.parametrize('mode', ['full', 'delta'])
def test_present_empty_mount_directory_is_not_a_mounted_library(db, tmp_path, monkeypatch, mode):
    offline, readable, sibling = [tmp_path / name for name in ('offline', 'lib', 'lib-other')]
    for root, name in ((offline, 'offline.wav'), (readable, 'gone.wav'), (sibling, 'sibling.wav')):
        make_wav(root / name)
    scanner.scan(db, [offline, readable, sibling])
    (offline / 'offline.wav').unlink()
    (readable / 'gone.wav').unlink()
    assert offline.is_dir() and not list(offline.iterdir())
    original_volume = scanner._volume_root
    monkeypatch.setattr(scanner, '_volume_root', lambda path: '/Volumes/Offline' if path.is_relative_to(offline) else original_volume(path))
    monkeypatch.setattr(scanner.os.path, 'ismount', lambda path: str(path) != '/Volumes/Offline')
    stats = scanner.scan(db, [offline, readable], mode=mode)
    tracks = {track.file_name: track for track in db.exec(select(Track)).all()}
    assert not tracks['offline.wav'].missing
    assert tracks['gone.wav'].missing
    assert not tracks['sibling.wav'].missing
    assert stats['missing'] == 1
    assert any('mounted' in warning for warning in stats['warnings'])


@pytest.mark.parametrize('mode', ['full', 'delta'])
def test_empty_mounted_volume_can_establish_missing_files(db, tmp_path, monkeypatch, mode):
    root = tmp_path / 'lib'
    audio = make_wav(root / 'gone.wav')
    scanner.scan(db, [root])
    audio.unlink()
    monkeypatch.setattr(scanner, '_volume_root', lambda path: '/Volumes/Present')
    monkeypatch.setattr(scanner.os.path, 'ismount', lambda path: True)
    assert scanner.scan(db, [root], mode=mode)['missing'] == 1


def test_volume_unmounted_during_traversal_cannot_establish_missing_files(db, tmp_path, monkeypatch):
    root = tmp_path / 'lib'
    audio = make_wav(root / 'gone.wav')
    scanner.scan(db, [root])
    audio.unlink()
    mounted = iter((True, False))
    monkeypatch.setattr(scanner, '_volume_root', lambda path: '/Volumes/Present')
    monkeypatch.setattr(scanner.os.path, 'ismount', lambda path: next(mounted))
    stats = scanner.scan(db, [root], mode='full')
    assert stats['missing'] == 0
    assert stats['warnings']


def test_delta_reuses_one_audio_stat_and_never_opens_unchanged_audio(db,tmp_path,monkeypatch):
    from pathlib import Path
    from app.services import identity_sync

    root = tmp_path/'lib'
    audio = make_wav(root/'Artist - Song.wav')
    scanner.scan(db,[root],mode='delta')
    before = db.exec(select(Track)).one().model_dump()
    original_stat = Path.stat
    calls = []
    sync_flags = []
    def stamped(path,*args,**kwargs):
        if path == audio and kwargs.get('follow_symlinks',True):
            calls.append(path)
        return original_stat(path,*args,**kwargs)
    def forbidden(*args,**kwargs):
        raise AssertionError('unchanged delta attempted expensive file/identity work')
    monkeypatch.setattr(Path,'stat',stamped)
    monkeypatch.setattr(scanner.metadata_reader,'read_tags',forbidden)
    monkeypatch.setattr(scanner.hashing,'quick_hash',forbidden)
    monkeypatch.setattr(scanner.ffprobe_reader,'read_stream',forbidden)
    monkeypatch.setattr(scanner,'CandidateIndex',forbidden)
    monkeypatch.setattr(identity_sync,'sync_session',lambda session,**kwargs: sync_flags.append(kwargs) or {})
    stats = scanner.scan(db,[root],mode='delta')
    assert stats['unchanged'] == 1 and stats['updated'] == stats['added'] == 0
    assert calls == [audio]
    assert sync_flags == [{'rederive_unchanged':False}]
    assert db.exec(select(Track)).one().model_dump() == before
