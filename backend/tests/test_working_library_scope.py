"""One everyday-library definition: live entities only, ID-only placeholders counted apart from known recordings."""
import json
from app.services import (canonical_queue, identity_library, library_collections, library_completeness as completeness,
                          recovery_prioritization as recovery)
from .test_canonical import entity, put
from .test_stabilization import catalog


def recording(db, rid, members, title, state='derived'):
    for e in members:
        put(db, e)
        db.execute('UPDATE entities SET recording_id=? WHERE id=?', (rid, e['id']))
    db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)', (rid, title, 'Artist', '', '', state, '{}', '{}', 'now'))


def library(tmp_path):
    db = catalog(tmp_path)  # local:1 = current local + Spotify + SoundCloud, in a SoundCloud Likes collection
    stale = entity('local:old', 'local', title='Ghost')  # legacy redirect: neither current nor retired
    recording(db, 'rec:redirect', [stale], 'Ghost')
    blank = entity('spotify:track:blank', 'spotify', title='', artist='')
    recording(db, 'spotify:track:blank', [blank], '', 'review')
    recording(db, 'soundcloud:tracks:555', [entity('soundcloud:tracks:555', 'soundcloud', title='Remote Song')], 'Remote Song')
    retired = entity('local:9', 'local', title='History')
    retired['metadata_json'] = json.dumps({'asset_lifecycle': {'state': 'retired'}})
    old = entity('local:8', 'local', title='History')
    old['metadata_json'] = json.dumps({'catalog_current': False})
    recording(db, 'rec:history', [entity('spotify:track:hist', 'spotify', title='History'), retired, old], 'History')
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)', ('likes', 'Liked Songs', 'spotify', 'likes', 2, '{"account":"me"}'))
    for pos, eid in enumerate(('spotify:track:blank', 'soundcloud:tracks:555')):
        db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)', ('likes', pos, eid, '2026-01-01', '{}'))
    return db


def test_live_predicate_matches_summary_and_list(tmp_path):
    db = library(tmp_path)
    live = {r[0] for r in db.execute('SELECT e.id FROM entities e WHERE ' + identity_library.live_entity_predicate())}
    assert live == {'local:1', 'spotify:track:one', 'soundcloud:tracks:123', 'spotify:track:blank', 'soundcloud:tracks:555', 'spotify:track:hist'}
    assert identity_library.placeholder_ids(db) == {'spotify:track:blank'}
    assert identity_library.placeholder_ids(db, ['local:1']) == set()
    db.execute("UPDATE canonical_recordings SET title=NULL,state='human' WHERE recording_id='spotify:track:blank'")
    assert identity_library.placeholder_ids(db) == {'spotify:track:blank'}  # a manual state uses the stored title as is


def test_known_excludes_redirects_and_placeholders(tmp_path):
    db = library(tmp_path)
    rows = completeness.index(db)
    assert 'rec:redirect' not in rows
    placeholder = rows['spotify:track:blank']['availability']
    assert placeholder['unresolved'] and not placeholder['remote_only'] and placeholder['state'] == 'REMOTE_UNRESOLVED'
    assert rows['soundcloud:tracks:555']['availability']['state'] == 'REMOTE_ONLY_SOUNDCLOUD'
    assert rows['local:1']['availability']['state'] == 'LOCAL_AND_REMOTE'
    assert rows['rec:history']['availability']['state'] == 'REMOTE_ONLY_SPOTIFY'
    metrics = completeness.metrics(rows)
    assert metrics['known_recordings'] == 3 and metrics['unresolved'] == 1 and metrics['remote_only'] == 2
    assert metrics['spotify_likes_not_local'] == 1  # the titled remote Like; the placeholder Like is not a known song
    assert {v['recording_id'] for v in completeness.browse(db)['items']} == {'soundcloud:tracks:555', 'rec:history'}
    assert [v['recording_id'] for v in completeness.browse(db, scope='unresolved')['items']] == ['spotify:track:blank']


def test_unified_summary_and_list_hide_placeholders(tmp_path):
    db = library(tmp_path)
    summary = identity_library.summary(db)
    assert summary['active_recordings'] == 3 and summary['unresolved_placeholders'] == 1
    listed = {r['recording_id'] for r in identity_library.list_items(db)['items']}
    assert listed == {'local:1', 'soundcloud:tracks:555', 'rec:history'}
    assert identity_library.list_items(db)['total'] == 3
    unresolved = identity_library.list_items(db, category='unresolved')
    assert unresolved['total'] == 1 and unresolved['items'][0]['recording_id'] == 'spotify:track:blank'
    assert identity_library.list_items(db, mode='sources')['total'] == db.execute('SELECT count(*) FROM entities').fetchone()[0]


def test_review_queue_ignores_historical_local_rows_and_placeholders(tmp_path):
    db = library(tmp_path)
    result = canonical_queue.list_items(db, view='all')
    ids = {r['recording_id'] for r in result['items']}
    assert ids == {'local:1', 'soundcloud:tracks:555', 'rec:history'} and result['unresolved_placeholders'] == 1
    history = next(r for r in result['items'] if r['recording_id'] == 'rec:history')['review_flags']
    assert history['provider_only'] and not history['local_only']
    assert result['counts']['provider_only'] == 2


def test_collection_counters_count_placeholders_as_unresolved(tmp_path):
    db = library(tmp_path)
    likes = next(r for r in library_collections.list_collections(db, all_sources=True)['items'] if r['id'] == 'likes')
    assert likes['availability'] == {'playable_local': 0, 'remote_only': 1, 'local_unavailable': 0, 'unresolved': 1}


def test_recovery_recommendations_skip_placeholders_but_keep_explicit_access(tmp_path):
    db = library(tmp_path)
    assert 'spotify:track:blank' not in {v['recording_id'] for v in recovery.view(db, preset='discovery')['items']}
    assert [v['recording_id'] for v in recovery.view(db, preset='favourites')['items']] == ['soundcloud:tracks:555']
    explicit = recovery.view(db, preset='discovery', filters={'scope': 'unresolved'})
    assert [v['recording_id'] for v in explicit['items']] == ['spotify:track:blank']
    completeness.recover(db, 'spotify:track:blank', 'wanted')
    assert [v['recording_id'] for v in recovery.view(db)['items']] == ['spotify:track:blank']
