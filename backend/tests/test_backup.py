from __future__ import annotations

import json
import sqlite3

import pytest

from app.models import ArtistProfile, Track
from app.services import backup


def test_json_backup_includes_artist_profiles_and_version(db, tmp_path):
    db.add(Track(absolute_path="/lib/a.wav", artist="ATYYA", artist_normalized="atyya", missing=False))
    db.add(ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=1))
    db.commit()

    dest = tmp_path / "backup.json"
    backup.export_json(db, dest)

    payload = json.loads(dest.read_text(encoding="utf-8"))
    assert payload["version"] == 2
    assert payload["artist_profiles"][0]["normalized_name"] == "atyya"


def test_json_export_companion_restores_identity_and_failure_preserves_json(db, tmp_path, monkeypatch):
    identity = tmp_path / 'identity.sqlite'
    with sqlite3.connect(identity) as connection:
        connection.execute('CREATE TABLE decisions(value TEXT)')
        connection.execute("INSERT INTO decisions VALUES ('keep separate')")
    dest = tmp_path / 'backup.json'
    backup.export_json(db, dest)
    payload = json.loads(dest.read_text())
    companion = dest.parent / payload['application_backup']['directory']
    restored = backup.restore_backup(companion, tmp_path / 'restored')
    with sqlite3.connect(restored / 'identity.sqlite') as connection:
        assert connection.execute('SELECT value FROM decisions').fetchone() == ('keep separate',)
    original = dest.read_bytes()
    monkeypatch.setattr(backup.os, 'replace', lambda *args: (_ for _ in ()).throw(OSError('failed JSON publish')))
    with pytest.raises(OSError, match='failed JSON publish'):
        backup.export_json(db, dest)
    assert dest.read_bytes() == original
    backup.verify_backup(companion)
    assert not list(tmp_path.glob('.export-*'))
