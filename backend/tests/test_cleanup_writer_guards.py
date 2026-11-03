"""Live writers must not regrow what the working-library cleanup removes (synthetic fixtures only)."""
import json

from app.services import canonical_library as canonical, canonical_metadata, identity_compaction as ic, identity_sync, manual_identity
from tests.test_canonical import entity, put
from tests.test_identity_sync import local_row, prepared

NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
SPOTIFY = [f'spotify:track:{i}' for i in range(5)]


def provider_grid():
    """5 Spotify x 5 SoundCloud near-duplicates: every entity has 5 rows, so the top-3 rule leaves some rows out."""
    db = prepared()
    for i, name in enumerate(NAMES):
        put(db, entity(SPOTIFY[i], 'spotify', artist=name, title='Moon Garden'))
        put(db, entity(f'soundcloud:tracks:{i}', 'soundcloud', artist=NAMES[(i + 1) % 5] + ' X', title='Moon Garden Mix'))
    return db


def evidences(db):
    return [json.loads(r[0]) for r in db.execute('SELECT evidence_json FROM candidates')]


def sou_events(db):
    return [dict(r) for r in db.execute("SELECT * FROM canonical_events WHERE action='source_observation_update' ORDER BY id")]


def test_refresh_candidates_keeps_only_the_shortlist(monkeypatch):
    unpruned = provider_grid()
    monkeypatch.setattr(identity_sync, 'shortlist_prune', lambda db, ids: 0)
    assert identity_sync.refresh_candidates(unpruned, SPOTIFY) == 25
    monkeypatch.undo()
    expected = ic.shortlist_keep(unpruned, SPOTIFY)
    assert 0 < len(expected) < 25
    db = provider_grid()
    assert identity_sync.refresh_candidates(db, SPOTIFY) == 25
    assert {(r[0], r[1]) for r in db.execute('SELECT left_id,right_id FROM candidates')} == expected
    assert ic.shortlist_prune(db, SPOTIFY) == 0
    # A rescan re-scores and re-retrieves the pruned pairs, then prunes them again.
    assert identity_sync.refresh_candidates(db, SPOTIFY) == 25
    assert {(r[0], r[1]) for r in db.execute('SELECT left_id,right_id FROM candidates')} == expected


def test_refresh_candidates_stores_slim_evidence_on_insert_and_update():
    db = provider_grid()
    identity_sync.refresh_candidates(db, SPOTIFY)
    assert evidences(db) and not any(set(ic.SLIM_EVIDENCE_KEYS) & set(e) for e in evidences(db))
    fat = {**evidences(db)[0], **{k: 'x' for k in ic.SLIM_EVIDENCE_KEYS}}
    db.execute('UPDATE candidates SET evidence_json=?', (json.dumps(fat),))
    identity_sync.refresh_candidates(db, SPOTIFY)
    assert not any(set(ic.SLIM_EVIDENCE_KEYS) & set(e) for e in evidences(db))


def test_normalizer_only_change_updates_row_without_event():
    db = prepared()
    identity_sync.sync_local_rows(db, [local_row()])
    fresh = db.execute("SELECT normalized_json FROM entities WHERE id='local:1'").fetchone()[0]
    stale = {**json.loads(fresh), 'normalization_version': 3, 'title_variants': ['old'], 'artist_variants': ['old']}
    db.execute("UPDATE entities SET normalized_json=? WHERE id='local:1'", (json.dumps(stale),))
    report = identity_sync.sync_local_rows(db, [local_row()])
    assert report['updated'] == 1
    assert json.loads(db.execute("SELECT normalized_json FROM entities WHERE id='local:1'").fetchone()[0]) == json.loads(fresh)
    assert sou_events(db) == []


def test_semantic_normalized_change_writes_diff_event():
    db = prepared()
    identity_sync.sync_local_rows(db, [local_row()])
    normalized = json.loads(db.execute("SELECT normalized_json FROM entities WHERE id='local:1'").fetchone()[0])
    db.execute("UPDATE entities SET normalized_json=? WHERE id='local:1'", (json.dumps({**normalized, 'kind': 'long_form'}),))
    identity_sync.sync_local_rows(db, [local_row()])
    [event] = sou_events(db)
    assert event['before_json'] is None and event['recording_id'] == 'local:1'
    assert json.loads(event['after_json']) == {'format': 'diff-v1', 'entity_id': 'local:1', 'changed': {},
                                               'normalized_changed': {'kind': ['long_form', 'track']}}


def test_metadata_change_writes_diff_event_without_whole_rows():
    db = prepared()
    identity_sync.sync_local_rows(db, [local_row()])
    identity_sync.sync_local_rows(db, [local_row(play_count=3)])
    [event] = sou_events(db)
    assert event['before_json'] is None
    after = json.loads(event['after_json'])
    assert after == {'format': 'diff-v1', 'entity_id': 'local:1', 'changed': {'play_count': [None, 3]}, 'normalized_changed': {}}


def test_ensure_soundcloud_stores_slim_raw_metadata():
    db = prepared()
    track = {'id': 9, 'title': 'Song', 'artwork_url': 'https://i1.sndcdn.com/a.jpg', 'description': 'd', 'tag_list': 't',
             'waveform_url': 'https://wave', 'publisher_metadata': {'artist': 'Artist A'}, 'media': {'transcodings': ['x'] * 50},
             'duration': 30000, 'full_duration': 300000, 'downloadable': False,
             'user': {'username': 'u', 'badges': {}}}
    row = {'soundcloud_track_id': 9, 'title': 'Song', 'duration_ms': 300000, 'publisher_metadata_json': '{"artist":"Artist A"}',
           'raw_json': json.dumps({'kind': 'like', 'created_at': '2026-01-01', 'track': track}), 'fetched_at': '2026-01-01'}
    sid = identity_sync.ensure_soundcloud(db, row)
    metadata = json.loads(db.execute('SELECT metadata_json FROM entities WHERE id=?', (sid,)).fetchone()[0])
    assert 'raw_json' not in metadata
    assert metadata['raw_metadata'] == {k: track[k] for k in ic.SOUNDCLOUD_RAW_KEEP}
    assert metadata['title'] == 'Song' and metadata['publisher_metadata_json'] == row['publisher_metadata_json']


def test_parse_import_item_does_not_keep_the_api_item():
    from app.services.soundcloud import parse_import_item
    parsed = parse_import_item({'kind': 'like', 'created_at': '2026-01-01T00:00:00Z',
                                'track': {'id': 5, 'title': 'Song', 'artwork_url': 'https://a', 'media': {'x': 1},
                                          'publisher_metadata': {'artist': 'A'}}}, run_id='r', fetched_at='2026-01-02')
    assert parsed.values['raw_json'] == '{}'
    assert parsed.values['artwork_url'] == 'https://a' and json.loads(parsed.values['publisher_metadata_json']) == {'artist': 'A'}


def test_mirror_snapshot_references_the_identity_observation():
    db = prepared()
    remote = entity('soundcloud:tracks:9', 'soundcloud')
    remote['metadata_json'] = json.dumps({'availability': 'available', 'raw_metadata': {'artwork_url': 'https://a', 'media': {'x': 1}}})
    put(db, remote)
    snapshot = identity_sync._legacy_soundcloud_snapshot(db, {'soundcloud_track_id': 9})
    provenance = json.loads(snapshot.raw_json)
    assert set(provenance) == {'source_entity_id', 'source_observed_at', 'projection_created_at'}
    assert provenance['source_entity_id'] == 'soundcloud:tracks:9'


def stored(db, rid):
    row = db.execute('SELECT proposal_json,evidence_json FROM canonical_recordings WHERE recording_id=?', (rid,)).fetchone()
    return json.loads(row[0]), json.loads(row[1])


def expected(db, rid):
    value = canonical_metadata.derive({rid: manual_identity.members(db, rid)})[0][rid]
    assert 'proposal' in value and all('proposal' in o for o in value['observations'])
    return value['proposal'], ic.slim_canonical_evidence(value)


def no_proposal_copies(evidence):
    return 'proposal' not in evidence and evidence['observations'] and all('proposal' not in o for o in evidence['observations'])


def test_canonical_evidence_has_no_proposal_copies_at_every_writer():
    db = prepared()
    identity_sync.sync_local_rows(db, [local_row()])  # identity_sync._canonical_row
    proposal, evidence = stored(db, 'local:1')
    assert no_proposal_copies(evidence) and (proposal, evidence) == expected(db, 'local:1')
    manual_identity.refresh_evidence(db, 'local:1')
    proposal, evidence = stored(db, 'local:1')
    assert no_proposal_copies(evidence) and (proposal, evidence) == expected(db, 'local:1')
    put(db, entity('spotify:track:s', 'spotify'))
    canonical.promote(db)  # canonical_library.materialize
    for rid in ('local:1', 'spotify:track:s'):
        proposal, evidence = stored(db, rid)
        assert no_proposal_copies(evidence) and (proposal, evidence) == expected(db, rid)
