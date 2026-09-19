from __future__ import annotations

import json

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
