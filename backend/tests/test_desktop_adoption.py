"""Deno adoption uses generated SQLite/audio fixtures, never user app data."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import Counter
from contextlib import closing
from pathlib import Path

import pytest

from app.desktop_runtime import adoption
from app.library_exchange import operations as exchange
from app.library_exchange.cli import main as cli
from app.library_exchange.manifest import inspect_archive
from app.services.backup import verify_backup
from app.services.dataset_access import DatasetBusyError, DatasetLease
from app.services.schema_contract import EXCLUDED_VALUE_TABLES, load_schema_contract

REPOSITORY = Path(__file__).resolve().parents[2]


def fixture_source(tmp_path, *, version=3, cues=False, wal=False):
    source = tmp_path / "deno" / "cratemind.sqlite"
    source.parent.mkdir(parents=True)
    schema = (REPOSITORY / "desktop/src/db/schema.sql").read_text()
    if version < 3:
        schema = re.sub(r"    bpm_consensus(?:_sources)? (?:REAL|TEXT),\n", "", schema)
    db = sqlite3.connect(source)
    db.executescript(schema)
    if version >= 2:
        migrations = (REPOSITORY / "desktop/src/db/migrations.ts").read_text()
        db.executescript(re.search(r"db.exec\(`(.*?)`\)", migrations, re.DOTALL).group(1))
    db.executemany("INSERT INTO schema_migrations VALUES (?,?)", [(number, "2026-10-19T08:21:30.123Z") for number in range(1, version + 1)])
    music = tmp_path / "music"
    music.mkdir()
    audio = music / "fixture.wav"
    audio.write_bytes(b"RIFF-generated-fixture-not-user-audio")
    db.execute("""INSERT INTO tracks(id, absolute_path, normalized_path, volume_root, file_name,
                  extension, artist, title, bpm_analyzed, bpm_analyzed_method, analyzed_at,
                  imported_at, last_scanned_at, last_played_at, play_count, full_hash)
                  VALUES(42,?,?,?,?,?,'Αφετηρία','Νυχτερινή διαδρομή',143.25,'fixture',
                  '2026-10-20T00:20:30.123Z','2026-09-01T00:00:00Z','2026-10-21T03:20:00Z',
                  '2026-10-21T04:21:31Z',7,'preserved-hash')""",
               (str(audio), str(audio).lower(), str(music), audio.name, '.wav'))
    db.execute("INSERT INTO tags VALUES(17,'Νυχτερινό','set-role')")
    db.execute("INSERT INTO track_tags VALUES(42,17,'human',0.9)")
    db.execute("""INSERT INTO track_dj_profile(track_id,energy,notes,human_confirmed,updated_at)
                  VALUES(42,8,'Κράτησε το break',1,'2026-10-21T04:20:00.300Z')""")
    db.execute("""INSERT INTO artist_profiles(id,normalized_name,canonical_name,energy_min,energy_max,
                  created_at,updated_at) VALUES(21,'αφετηρία','Αφετηρία',3,9,
                  '2026-09-01T00:00:00Z','2026-10-21T04:00:00Z')""")
    db.execute("INSERT INTO sets VALUES(31,'Δοκιμή','2026-10-20',3600,'140→145','3→9','set note','2026-10-20T00:00:00Z')")
    db.execute("INSERT INTO set_tracks VALUES(31,2,42,'second position')")
    db.execute("INSERT INTO play_events VALUES(15,42,31,'2026-10-20T03:00:00Z','practice',4,'play note')")
    db.execute("INSERT INTO track_pair_notes VALUES(16,42,42,5,'cut','pair note','2026-10-20T00:01:00Z')")
    db.execute("INSERT INTO saved_searches VALUES(12,'Αναζήτηση','energy:8','saved',1,3,'2026-10-20T00:00:00Z','2026-10-21T00:00:00Z')")
    db.execute("INSERT INTO audit_log VALUES(9,'human-confirm','track',42,'{}','{\"energy\":8}','2026-10-20T00:00:00Z')")
    db.execute("INSERT INTO duplicate_groups VALUES(8,'fixture','rejected','2026-10-20T00:00:00Z')")
    db.execute("INSERT INTO duplicate_group_tracks VALUES(8,42,'keep')")
    db.execute("INSERT INTO track_search(rowid,artist,title,notes,tags) VALUES(42,'Αφετηρία','Νυχτερινή διαδρομή','Κράτησε το break','Νυχτερινό')")
    if version >= 2:
        db.execute("""INSERT INTO soundcloud_tracks(soundcloud_track_id,title,raw_json,fetched_at)
                      VALUES(123,'provider snapshot','{"id":123}','2026-10-20T05:00:00Z')""")
        db.execute("INSERT INTO track_soundcloud_matches VALUES(42,123,0.99,'human','[\"accepted\"]','2026-10-20T05:00:00Z','2026-10-21T00:00:00Z')")
        db.execute("INSERT INTO soundcloud_match_candidates VALUES(42,123,0.99,'[]','accepted','2026-10-20T00:00:00Z','2026-10-21T00:00:00Z')")
    if cues:
        for statement in load_schema_contract()["initialization_sql"]["catalog"]:
            if statement.startswith("CREATE TABLE track_cues ") or re.search(r" ON track_cues ", statement):
                db.execute(statement)
        db.execute("""INSERT INTO track_cues(id,track_id,kind,position_ms,label,created_at,updated_at)
                      VALUES(55,42,'cue',12345,'Επιστροφή','2026-10-20T00:00:00Z','2026-10-21T00:00:00Z')""")
    db.commit()
    if wal:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("UPDATE tracks SET title='WAL-only title' WHERE id=42")
        db.commit()
    else:
        db.close()
    return source, audio, db if wal else None


def source_signature(source):
    return {str(path): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in source.parent.iterdir() if path.is_file()}


def assert_projection(source, target):
    with closing(sqlite3.connect(source)) as before, closing(sqlite3.connect(target)) as after:
        tables = [row[0] for row in before.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for name in tables:
            if name in EXCLUDED_VALUE_TABLES or name == "schema_migrations":
                continue
            columns = [row[1] for row in before.execute(f'PRAGMA table_info("{name}")')]
            projection = ','.join(f'"{column}"' for column in columns)
            assert Counter(before.execute(f'SELECT {projection} FROM "{name}"').fetchall()) == Counter(after.execute(f'SELECT {projection} FROM "{name}"').fetchall()), name


@pytest.mark.parametrize("version", [1, 2, 3])
def test_deno_adoption_preserves_ids_dates_values_audio_and_publishes_exchange(tmp_path, version):
    source, audio, _ = fixture_source(tmp_path, version=version, cues=True)
    before, audio_before = source_signature(source), (audio.read_bytes(), audio.stat().st_mtime_ns)
    result = adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert source_signature(source) == before
    assert (audio.read_bytes(), audio.stat().st_mtime_ns) == audio_before
    assert result.dataset.identity_path is None
    assert_projection(source, result.dataset.catalog_path)
    with sqlite3.connect(result.dataset.catalog_path) as db:
        assert db.execute("SELECT rowid FROM track_search WHERE track_search MATCH 'Νυχτερινή'").fetchall() == [(42,)]
    assert result.archive_path.is_file()
    manifest = inspect_archive(result.archive_path, tmp_path / "verified")
    assert manifest.parent_snapshot_id is None
    assert_projection(source, tmp_path / "verified/backup/catalog.sqlite")
    receipt = json.loads((tmp_path / "new/deno-adoption.json").read_text())
    backup = Path(receipt["source_backup"])
    verify_backup(backup)
    with sqlite3.connect(backup / "catalog.sqlite") as db:
        assert db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == version
    imported = exchange.apply_import(exchange.prepare_import(result.archive_path, tmp_path / "web"), tmp_path / "web")
    assert_projection(source, imported.dataset.catalog_path)
    replay = adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert replay.no_op and replay.snapshot_id == result.snapshot_id


def test_preview_and_adoption_recover_wal_only_in_private_copies(tmp_path):
    source, _audio, writer = fixture_source(tmp_path, wal=True)
    try:
        before = source_signature(source)
        preview = adoption.preview_deno_source(source)
        assert preview.supported and preview.table_counts["tracks"] == 1
        result = adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
        assert source_signature(source) == before
        with sqlite3.connect(result.dataset.catalog_path) as db:
            assert db.execute("SELECT title FROM tracks WHERE id=42").fetchone()[0] == 'WAL-only title'
    finally:
        writer.close()


@pytest.mark.parametrize("mutation", ["ALTER TABLE tracks ADD COLUMN future_decision TEXT", "CREATE TABLE future_decisions(id INTEGER PRIMARY KEY)", "INSERT INTO schema_migrations VALUES(4,'2026-10-22')"])
def test_unknown_schema_refused_even_empty_without_source_changes(tmp_path, mutation):
    source, _, _ = fixture_source(tmp_path)
    with sqlite3.connect(source) as db:
        db.execute(mutation)
    before = source_signature(source)
    with pytest.raises(ValueError, match="σχήμα Deno|έκδοση"):
        adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert source_signature(source) == before
    assert not (tmp_path / "new/active.json").exists()


def test_stopped_precondition_existing_history_and_busy_destination_refused(tmp_path):
    source, _, _ = fixture_source(tmp_path)
    with pytest.raises(ValueError, match="require-stopped"):
        adoption.adopt_deno_source(source, tmp_path / "new")
    dataset = exchange.initialize_empty(tmp_path / "existing")
    with sqlite3.connect(dataset.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('keep local history')")
    with pytest.raises(FileExistsError):
        adoption.adopt_deno_source(source, tmp_path / "existing", require_stopped=True)
    with sqlite3.connect(dataset.catalog_path) as db:
        assert db.execute("SELECT name FROM tags").fetchall() == [('keep local history',)]
    with DatasetLease.acquire(tmp_path / "existing", "test"), pytest.raises(DatasetBusyError):
        adoption.adopt_deno_source(source, tmp_path / "existing", require_stopped=True)


def test_discovery_reads_only_known_os_app_data_name(tmp_path):
    source, _, _ = fixture_source(tmp_path)
    directory = tmp_path / "home/Library/Application Support/CrateMind"
    directory.mkdir(parents=True)
    known = directory / "cratemind.sqlite"
    known.write_bytes(source.read_bytes())
    (directory / "app.db").write_bytes(b"must not inspect checkout/web database")
    before = source_signature(known)
    previews = adoption.inspect_deno_sources(home=tmp_path / "home", platform="darwin", environ={})
    assert len(previews) == 1 and previews[0].source == known and previews[0].supported
    assert source_signature(known) == before


def test_corruption_low_disk_and_interrupted_pointer_leave_originals_intact(tmp_path, monkeypatch):
    source, _, _ = fixture_source(tmp_path)
    before = source_signature(source)
    original_backup = adoption.create_backup
    def no_space(*args, **kwargs):
        raise OSError("Insufficient free space")
    monkeypatch.setattr(adoption, "create_backup", no_space)
    with pytest.raises(OSError, match="space"):
        adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert not (tmp_path / "new/active.json").exists()
    monkeypatch.setattr(adoption, "create_backup", original_backup)
    original_pointer = exchange._pointer
    def interrupted(*args, **kwargs):
        raise OSError("interrupted publication")
    monkeypatch.setattr(exchange, "_pointer", interrupted)
    with pytest.raises(OSError, match="interrupted"):
        adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert not (tmp_path / "new/active.json").exists()
    monkeypatch.setattr(exchange, "_pointer", original_pointer)
    result = adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert result.archive_path.is_file()
    assert source_signature(source) == before
    corrupt = tmp_path / "corrupt.sqlite"
    corrupt.write_bytes(b"not sqlite")
    with pytest.raises(sqlite3.DatabaseError):
        adoption.preview_deno_source(corrupt)
    assert corrupt.read_bytes() == b"not sqlite"


def test_concurrent_source_change_refused_before_publication(tmp_path, monkeypatch):
    source, _, _ = fixture_source(tmp_path)
    original_copy = adoption._copy_values
    def changed(*args):
        original_copy(*args)
        with sqlite3.connect(source) as writer:
            writer.execute("UPDATE tracks SET title='concurrent edit' WHERE id=42")
    monkeypatch.setattr(adoption, "_copy_values", changed)
    with pytest.raises(ValueError, match="άλλαξε"):
        adoption.adopt_deno_source(source, tmp_path / "new", require_stopped=True)
    assert not (tmp_path / "new/active.json").exists()
    assert not (tmp_path / "new/deno-adoption.json").exists()


@pytest.mark.parametrize("destination", ["music/generated-metadata", "deno/nested"])
def test_destinations_inside_source_or_music_are_rejected_before_creation(tmp_path, destination):
    source, audio, _ = fixture_source(tmp_path)
    before = source_signature(source)
    music_before = source_signature(audio)
    target = tmp_path / destination
    with pytest.raises(ValueError, match="εκτός"):
        adoption.adopt_deno_source(source, target, require_stopped=True)
    assert not target.exists()
    assert source_signature(source) == before
    assert source_signature(audio) == music_before


def test_contract_pins_source_ddl_and_cli_is_explicit(tmp_path, capsys):
    contract = json.loads(adoption.CONTRACT_PATH.read_text())
    for relative, digest in contract["sources"].items():
        assert hashlib.sha256((REPOSITORY / relative).read_bytes()).hexdigest() == digest
    source, _, _ = fixture_source(tmp_path)
    assert cli(["inspect-deno", "--source", str(source)]) == 0
    assert json.loads(capsys.readouterr().out)[0]["supported"]
    assert cli(["adopt-deno", "--source", str(source), "--data-dir", str(tmp_path / "new"), "--require-stopped"]) == 0
    assert json.loads(capsys.readouterr().out)["archive_path"].endswith("onboarding.cmexchange")
