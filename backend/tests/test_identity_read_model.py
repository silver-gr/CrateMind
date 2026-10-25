"""Requested pages must not parse or probe unrelated catalog records."""
from contextlib import nullcontext
import json

from app.services import canonical_library, identity_library, library_completeness
from app.services import collection_intelligence, library_collections, provider_resolution
from .test_canonical import entity, put
from .test_stabilization import catalog


def _unrelated(db):
    other = entity("soundcloud:tracks:999", "soundcloud", title="Other")
    other["metadata_json"] = json.dumps({"popularity": {"playback_count": 99}})
    put(db, other)
    db.execute("INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)",
               (other["id"], "Other", "Elsewhere", "", "", "derived", "{}", "{}", "now"))
    return other["id"]


def test_track_overlay_only_resolves_requested_recordings(tmp_path, monkeypatch):
    db = catalog(tmp_path)
    _unrelated(db)
    monkeypatch.setattr(identity_library, "connect", lambda: nullcontext(db))
    parsed = []
    original = provider_resolution.source

    def observe(row):
        parsed.append(row["id"])
        return original(row)

    monkeypatch.setattr(provider_resolution, "source", observe)
    rows = canonical_library.overlay([{"id": 1, "artist": "raw", "title": "raw"}])
    assert rows[0]["title"] == "Song"
    assert rows[0]["original_title"] == "raw"
    assert rows[0]["soundcloud_playback_count"] == 1234
    assert rows[0]["soundcloud_counter_source_id"] == "soundcloud:tracks:123"
    assert set(parsed) <= {"soundcloud:tracks:123"}


def test_empty_overlay_does_not_open_identity_catalog(monkeypatch):
    def unexpected():
        raise AssertionError("empty page must not query identity")

    monkeypatch.setattr(identity_library, "connect", unexpected)
    assert canonical_library.overlay([]) == []


def test_collection_enrichment_only_resolves_its_recordings(tmp_path, monkeypatch):
    db = catalog(tmp_path)
    _unrelated(db)
    detail = library_collections.collection(db, "import")
    parsed = []
    original = provider_resolution.source

    def observe(row):
        parsed.append(row["id"])
        return original(row)

    monkeypatch.setattr(provider_resolution, "source", observe)
    enriched = collection_intelligence.enrich_collection(db, detail)
    assert enriched["availability"]["playable_local"] == 3
    assert "soundcloud:tracks:999" not in parsed


def test_scoped_completeness_matches_full_projection(tmp_path):
    db = catalog(tmp_path)
    _unrelated(db)
    full = library_completeness.index(db)
    scoped = library_completeness.index(db, recording_ids=["local:1"])
    assert scoped == {"local:1": full["local:1"]}
    assert library_completeness.index(db, recording_ids=[]) == {}


def test_provider_confirmation_uses_current_source_identity_after_id_reuse(tmp_path, monkeypatch):
    db = catalog(tmp_path)
    db.execute("UPDATE entities SET id='local:1:new',metadata_json=json_set(metadata_json,'$.catalog_current',json('true')) WHERE id='local:1'")
    db.execute("UPDATE identity_acceptances SET left_id='local:1:new' WHERE left_id='local:1'")
    monkeypatch.setattr(identity_library, "connect", lambda *args: nullcontext(db))
    detail = provider_resolution.track_detail(None, 1, {'soundcloud': None})
    assert detail['soundcloud']['match']['confidence'] == 93
    assert len(detail['soundcloud']['accepted_path']) == 2
    assert detail['soundcloud']['accepted_path'][0]['left_id'] == 'local:1:new'


def test_historical_redirect_cannot_play_a_different_current_track(tmp_path):
    db = catalog(tmp_path)
    row = dict(db.execute("SELECT * FROM entities WHERE id='local:1'").fetchone())
    row['id'] = 'local:old'
    asset = provider_resolution.local_asset(row)
    assert asset['current'] is False
    assert asset['playable'] is False
    assert asset['audio_url'] is None
    assert asset['file_evidence']['state'] == 'present'
    assert library_completeness.derive([asset], [])['state'] == 'REMOTE_UNRESOLVED'


def test_unified_browsing_starts_with_named_recordings(tmp_path):
    db = catalog(tmp_path)
    unknown = _unrelated(db)
    db.execute('UPDATE canonical_recordings SET title=NULL WHERE recording_id=?', (unknown,))
    rows = identity_library.list_items(db)['items']
    assert [row['recording_id'] for row in rows] == ['local:1', unknown]
