import json
import sqlite3
from pathlib import Path

import pytest

from app.services import canonical_library as canonical, identity_library, manual_identity
from app.services.identity_matching import normalized_item, score_candidate
from tests.test_canonical import fixture_db, entity, put


def prepared():
    db = fixture_db()
    db.executescript(canonical.SCHEMA)
    return db


def local_row(track_id=1, **changes):
    return {'id': track_id, 'title': 'Song', 'artist': 'Artist A', 'duration': 300,
            'file_name': 'Song.mp3', 'absolute_path': '/library/Song.mp3', 'missing': 0, **changes}


def test_database_path_pairs_alternate_catalog(tmp_path, monkeypatch):
    monkeypatch.delenv('CRATEMIND_IDENTITY_DB_PATH', raising=False)
    assert identity_library.database_path(tmp_path / 'alternate.sqlite') == tmp_path / 'identity.sqlite'
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH', str(tmp_path / 'explicit.sqlite'))
    assert identity_library.database_path(tmp_path / 'alternate.sqlite') == tmp_path / 'explicit.sqlite'


def test_incremental_sync_preserves_human_metadata_and_history():
    from app.services.identity_sync import sync_local_rows
    db = prepared()
    report = sync_local_rows(db, [local_row()])
    assert report['active_local_ids'] == {1: 'local:1'}
    db.execute("UPDATE canonical_recordings SET title='Human title',state='human' WHERE recording_id='local:1'")
    before = db.execute('SELECT * FROM recording_artists').fetchall()
    db.execute("INSERT INTO canonical_blocks VALUES ('local:1','remote:1','human_rejection')")
    report = sync_local_rows(db, [local_row(title='New tag', missing=1)])
    assert report['updated'] == 1
    assert db.execute("SELECT title FROM canonical_recordings WHERE recording_id='local:1'").fetchone()[0] == 'Human title'
    assert db.execute('SELECT * FROM recording_artists').fetchall() == before
    assert json.loads(db.execute('SELECT metadata_json FROM entities').fetchone()[0])['missing'] == 1
    assert db.execute('SELECT reason FROM canonical_blocks').fetchone()[0] == 'human_rejection'
    assert sync_local_rows(db, [local_row(title='New tag', missing=1)])['updated'] == 0


def test_retired_numeric_id_reuse_preserves_original_observation():
    from app.services.identity_sync import sync_local_rows
    db = prepared()
    sync_local_rows(db, [local_row()])
    raw = {**local_row(), 'asset_lifecycle': {'state': 'retired', 'survivor_id': 'local:99'}}
    db.execute('UPDATE entities SET metadata_json=? WHERE id=?', (json.dumps(raw), 'local:1'))
    report = sync_local_rows(db, [local_row(absolute_path='/new/Song.mp3')])
    sid = report['active_local_ids'][1]
    assert sid != 'local:1'
    old = db.execute("SELECT * FROM entities WHERE id='local:1'").fetchone()
    assert json.loads(old['metadata_json'])['asset_lifecycle']['state'] == 'retired'
    assert db.execute('SELECT recording_id FROM entities WHERE id=?', (sid,)).fetchone()[0] != old['recording_id']
    assert sync_local_rows(db, [local_row(absolute_path='/new/Song.mp3')])['active_local_ids'][1] == sid


def test_near_tie_uses_distinct_current_components_and_clears_obsolete_flag():
    from app.services.identity_matching import refresh_near_ties
    db = prepared()
    for sid, service in [('local:1','local'), ('sc:1','soundcloud'), ('sc:2','soundcloud')]:
        put(db, entity(sid, service))
    for sid in ('sc:1', 'sc:2'):
        a = normalized_item({'id': 'local:1', 'service':'local','title':'Song','artist':'Artist A','duration_ms':300000})
        b = normalized_item({'id': sid, 'service':'soundcloud','title':'Song','artist':'Artist A','duration_ms':300000})
        result = score_candidate(a,b)
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', ('local:1',sid,'local:soundcloud',result['score'],result['class'],json.dumps(result['evidence'])))
    refresh_near_ties(db)
    assert all(json.loads(r[0]).get('near_tie_review') for r in db.execute('SELECT evidence_json FROM candidates'))
    db.execute("UPDATE entities SET recording_id='sc:1' WHERE id='sc:2'")
    refresh_near_ties(db)
    assert all(not json.loads(r[0]).get('near_tie_review') for r in db.execute('SELECT evidence_json FROM candidates'))
    assert {r[0] for r in db.execute('SELECT class FROM candidates')} == {'HIGH_CONFIDENCE'}


def test_isrc_override_requires_reason_and_cannot_override_rejection():
    db = prepared()
    for sid, service, isrc in [('local:1','local','AAA'),('spotify:track:x','spotify','BBB')]:
        put(db,entity(sid,service,isrc=isrc))
    canonical.promote(db);db.commit()
    preview = manual_identity.comparison(db,'local:1','spotify:track:x')
    assert preview['isrc_override']['allowed']
    with pytest.raises(ValueError,match='contradictory_isrc'):
        manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1')
    db.rollback()
    result = manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1','Provider ISRC is incorrect')
    db.commit()
    assert result['recording_id'] == 'local:1'
    evidence = json.loads(db.execute('SELECT evidence_json FROM identity_acceptances').fetchone()[0])
    assert evidence['isrc_override']['reason'] == 'Provider ISRC is incorrect'
    manual_identity.undo(db,'local:1','spotify:track:x');db.commit()
    preview = manual_identity.comparison(db,'local:1','spotify:track:x')
    manual_identity.reject(db,'local:1','spotify:track:x',preview['token']);db.commit()
    preview = manual_identity.comparison(db,'local:1','spotify:track:x')
    assert not preview['isrc_override']['allowed']
    with pytest.raises(ValueError,match='human_rejection'):
        manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1','A reason')


def installed_identity(tmp_path, monkeypatch):
    path = tmp_path / 'identity.sqlite'
    source = prepared(); source.commit()
    with sqlite3.connect(path) as destination:
        source.backup(destination)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH', str(path))
    return path


def soundcloud_pair(session):
    from app.models import Track, SoundCloudTrack, SoundCloudMatchCandidate
    track = Track(id=1, title='Song', artist='Artist A', duration=300, absolute_path='/library/Song.mp3', file_name='Song.mp3')
    snapshot = SoundCloudTrack(soundcloud_track_id=9,title='Song',duration_ms=300000,publisher_metadata_json='{"artist":"Artist A"}',raw_json='{}',fetched_at='2026-01-01')
    candidate = SoundCloudMatchCandidate(track_id=1,soundcloud_track_id=9,score=.99,reasons_json='[]',evaluated_at='2026-01-01')
    session.add(track); session.add(snapshot); session.commit()
    session.add(candidate); session.commit()
    return track,snapshot


def test_acceptance_mirror_failure_is_explicit_and_replayable(db, tmp_path, monkeypatch):
    from app.services import soundcloud
    from app.services.identity_sync import replay_mirror_intents
    from app.models import TrackSoundCloudMatch
    path = installed_identity(tmp_path,monkeypatch)
    soundcloud_pair(db)
    original_commit = db.commit
    def failing_commit():
        raise RuntimeError('injected catalog commit failure')
    monkeypatch.setattr(db,'commit',failing_commit)
    with pytest.raises(ValueError,match='mirror failed'):
        soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)
    with identity_library.connect(path) as authority:
        assert authority.execute('SELECT count(*) FROM identity_acceptances WHERE revoked_at IS NULL').fetchone()[0] == 1
        assert authority.execute("SELECT count(*) FROM canonical_events WHERE action='legacy_soundcloud_mirror_intent'").fetchone()[0] == 1
    assert db.get(TrackSoundCloudMatch,1) is None
    monkeypatch.setattr(db,'commit',original_commit)
    assert replay_mirror_intents(db,path)['applied'] == 1
    assert db.get(TrackSoundCloudMatch,1).soundcloud_track_id == 9
    assert replay_mirror_intents(db,path)['applied'] == 0
    assert soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)['status'] == 'accepted'
    with identity_library.connect(path) as authority:
        assert authority.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0] == 1


def test_broken_explicit_identity_never_silently_accepts(db,tmp_path,monkeypatch):
    from app.services import soundcloud
    from app.models import TrackSoundCloudMatch
    soundcloud_pair(db)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(tmp_path/'missing.sqlite'))
    with pytest.raises(ValueError,match='unavailable'):
        soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)
    assert db.get(TrackSoundCloudMatch,1) is None


def test_absent_paired_identity_keeps_legacy_acceptance(db,monkeypatch):
    from app.services import soundcloud
    from app.models import TrackSoundCloudMatch
    monkeypatch.delenv('CRATEMIND_IDENTITY_DB_PATH',raising=False)
    soundcloud_pair(db)
    assert soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)['status'] == 'accepted'
    assert db.get(TrackSoundCloudMatch,1).soundcloud_track_id == 9


def test_revoked_decision_cancels_pending_mirror_and_is_not_reimported(db,tmp_path,monkeypatch):
    from app.services.identity_sync import prepare_soundcloud_acceptance,replay_mirror_intents,reconcile_confirmed_links
    path=installed_identity(tmp_path,monkeypatch); track,snapshot=soundcloud_pair(db)
    prepare_soundcloud_acceptance(db,track,snapshot)
    with canonical.connect(path) as authority:
        manual_identity.undo(authority,'local:1','soundcloud:tracks:9')
    result=replay_mirror_intents(db,path)
    assert result['applied']==1  # the undo removal is replayed; the old accept is cancelled
    assert result['cancelled']==1
    catalog_path=Path(db.get_bind().url.database)
    with sqlite3.connect(catalog_path) as catalog:
        catalog.row_factory=sqlite3.Row
        catalog.execute("INSERT INTO track_soundcloud_matches VALUES (1,9,99,'manual_review','[]','2026-01-01','2026-01-01')")
        with canonical.connect(path) as authority:
            report=reconcile_confirmed_links(authority,catalog)
            assert report['protected']==1
            assert authority.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2


def test_identity_commit_failure_leaves_catalog_unaccepted(db,tmp_path,monkeypatch):
    from contextlib import contextmanager
    from app.services import soundcloud
    from app.models import TrackSoundCloudMatch
    path=installed_identity(tmp_path,monkeypatch);soundcloud_pair(db)
    @contextmanager
    def fail_authority(*args,**kwargs):
        connection=sqlite3.connect(path);connection.row_factory=sqlite3.Row
        try:
            yield connection
            raise RuntimeError('injected identity commit failure')
        finally:
            connection.rollback();connection.close()
    monkeypatch.setattr(canonical,'connect',fail_authority)
    with pytest.raises(RuntimeError,match='identity commit failure'):
        soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)
    assert db.get(TrackSoundCloudMatch,1) is None
    with identity_library.connect(path) as authority:
        assert authority.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==0


def test_current_summary_is_not_the_imported_coverage_cache():
    from app.services.identity_sync import sync_local_rows
    db=prepared()
    sync_local_rows(db,[local_row(),local_row(2,absolute_path='/library/Other.mp3')])
    db.execute("UPDATE metadata SET value=? WHERE key='summary'",(json.dumps({'coverage':{'local':{'total':9000}}}),))
    assert identity_library.summary(db)['coverage']['local']['total']==2
    sync_local_rows(db,[local_row()],full_snapshot=True)
    assert identity_library.summary(db)['coverage']['local']['total']==1
    assert identity_library.summary(db)['source_observations']==2


def test_confirmed_link_reconcile_preserves_human_metadata_and_rejections(db,tmp_path,monkeypatch):
    from app.services.identity_sync import sync_catalog,sync_local_rows,ensure_soundcloud
    from app.models import TrackSoundCloudMatch
    path=installed_identity(tmp_path,monkeypatch);track,snapshot=soundcloud_pair(db)
    catalog_path=Path(db.get_bind().url.database)
    with canonical.connect(path) as authority:
        sync_local_rows(authority,[json.loads(track.model_dump_json())])
        ensure_soundcloud(authority,json.loads(snapshot.model_dump_json()))
        authority.execute("UPDATE canonical_recordings SET title='Human title',state='human' WHERE recording_id='local:1'")
    db.add(TrackSoundCloudMatch(track_id=1,soundcloud_track_id=9,confidence=99,method='manual_review',reasons_json='[]',matched_at='2026-01-01',confirmed_at='2026-01-01'));db.commit()
    assert sync_catalog(catalog_path,path)['confirmed_links']['accepted']==1
    with identity_library.connect(path) as authority:
        assert authority.execute("SELECT title FROM canonical_recordings WHERE recording_id='local:1'").fetchone()[0]=='Human title'
        assert authority.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==1
    assert sync_catalog(catalog_path,path)['confirmed_links']['accepted']==0


def test_new_sync_candidates_retain_rejected_evidence():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    remote=entity('spotify:track:x','spotify');put(db,remote)
    db.execute("INSERT INTO canonical_blocks VALUES ('local:1','spotify:track:x','human_rejection')")
    sync_local_rows(db,[local_row(title='Song!')])
    result=db.execute('SELECT class,evidence_json FROM candidates').fetchone()
    assert result[0]=='CONFLICT'
    assert 'previously_rejected' in json.loads(result[1])['conflicts']
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==0


def test_reused_numeric_redirect_cannot_inherit_survivor_identity():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    db.execute("UPDATE entities SET local_track_id=99 WHERE id='local:1'")
    report=sync_local_rows(db,[local_row()])
    sid=report['active_local_ids'][1]
    assert sid!='local:1'
    assert identity_library.current_local_entity(db,1)['id']==sid
    assert db.execute("SELECT recording_id FROM entities WHERE id='local:1'").fetchone()[0]=='local:1'


def test_reasoned_override_does_not_bypass_version_or_performer_conflicts():
    db=prepared()
    for row in (entity('local:1','local',isrc='AAA'),entity('spotify:track:x','spotify',title='Song (Live)',isrc='BBB')):
        put(db,row)
    canonical.promote(db);db.commit()
    preview=manual_identity.comparison(db,'local:1','spotify:track:x')
    assert not preview['isrc_override']['allowed']
    with pytest.raises(ValueError,match='version_mismatch'):
        manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1','Provider ISRC incorrect')
    db.rollback()


def test_metadata_recommendation_compares_version_release_and_credits():
    db=prepared()
    for row in (entity('local:1','local'),entity('spotify:track:x','spotify')):
        put(db,row)
    canonical.promote(db);db.commit()
    assert manual_identity.comparison(db,'local:1','spotify:track:x')['recommended_metadata_id']=='local:1'
    db.execute("UPDATE canonical_recordings SET release='Different release' WHERE recording_id='spotify:track:x'")
    assert manual_identity.comparison(db,'local:1','spotify:track:x')['recommended_metadata_id'] is None
    db.execute("UPDATE canonical_recordings SET state='human' WHERE recording_id='local:1'")
    assert manual_identity.comparison(db,'local:1','spotify:track:x')['recommended_metadata_id']=='local:1'


def test_mirror_ack_failure_remains_replayable_without_duplicate_decision(db,tmp_path,monkeypatch):
    from app.services import identity_sync, soundcloud
    from app.models import TrackSoundCloudMatch
    path=installed_identity(tmp_path,monkeypatch);soundcloud_pair(db)
    original=identity_sync._event
    def failing_ack(connection,action,*args,**kwargs):
        if action=='legacy_soundcloud_mirror_applied':
            raise RuntimeError('injected acknowledgment failure')
        return original(connection,action,*args,**kwargs)
    monkeypatch.setattr(identity_sync,'_event',failing_ack)
    with pytest.raises(ValueError,match='acknowledgment failed'):
        soundcloud.accept_candidate(db,track_id=1,soundcloud_track_id=9)
    assert db.get(TrackSoundCloudMatch,1).soundcloud_track_id==9
    monkeypatch.setattr(identity_sync,'_event',original)
    assert identity_sync.replay_mirror_intents(db,path)['applied']==1
    with identity_library.connect(path) as authority:
        assert authority.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==1
        assert authority.execute("SELECT count(*) FROM canonical_events WHERE action='legacy_soundcloud_mirror_intent'").fetchone()[0]==1


def test_sync_leaves_source_memberships_and_human_credits_intact():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    db.execute("INSERT INTO collections VALUES ('source:list','Original','spotify','snapshot',2,'{}')")
    db.execute("INSERT INTO memberships VALUES ('source:list',1,'local:1',NULL,'{\"original\":true}')")
    db.execute("INSERT INTO memberships VALUES ('source:list',2,'local:1',NULL,'{\"repeat\":true}')")
    canonical.review(db,'local:1','edit',{'title':'Human title','credits':[{'name':'Chosen artist','role':'primary'}]})
    memberships=[tuple(r) for r in db.execute('SELECT * FROM memberships ORDER BY position')]
    artists=[tuple(r) for r in db.execute('SELECT * FROM recording_artists')]
    sync_local_rows(db,[local_row(title='Changed tag',missing=1)])
    assert [tuple(r) for r in db.execute('SELECT * FROM memberships ORDER BY position')]==memberships
    assert [tuple(r) for r in db.execute('SELECT * FROM recording_artists')]==artists
    assert canonical.detail(db,'local:1')['title']=='Human title'


def test_ordinary_derived_metadata_tracks_current_tags():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    sync_local_rows(db,[local_row(title='New song')])
    assert db.execute("SELECT title FROM canonical_recordings WHERE recording_id='local:1'").fetchone()[0]=='New song'


def test_default_sync_uses_only_the_fixture_catalog_sibling(db,tmp_path,monkeypatch):
    from app.services.identity_sync import sync_session
    monkeypatch.delenv('CRATEMIND_IDENTITY_DB_PATH',raising=False)
    monkeypatch.setattr(identity_library,'DEFAULT_DB',tmp_path/'forbidden-live-identity.sqlite')
    assert sync_session(db)['identity_installed'] is False
    assert not identity_library.DEFAULT_DB.exists()


def test_routine_identity_list_excludes_history_sources_view_keeps_it():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row(),local_row(2,absolute_path='/library/Other.mp3')])
    sync_local_rows(db,[local_row()],full_snapshot=True)
    assert identity_library.list_items(db)['total']==1
    assert identity_library.list_items(db,mode='sources')['total']==2


def test_unified_acceptance_projects_missing_legacy_snapshot_without_fabricating_counters(db,tmp_path,monkeypatch):
    from app.models import Track,SoundCloudTrack,TrackSoundCloudMatch
    from app.services.identity_sync import sync_local_rows,replay_mirror_intents
    path=installed_identity(tmp_path,monkeypatch)
    track=Track(id=1,title='Song',artist='Artist A',duration=300,absolute_path='/library/Song.mp3');db.add(track);db.commit()
    with canonical.connect(path) as authority:
        sync_local_rows(authority,[json.loads(track.model_dump_json())])
        remote=entity('soundcloud:tracks:9','soundcloud')
        remote['metadata_json']=json.dumps({'availability':'unknown','popularity':{'likes_count':42}})
        put(authority,remote)
        canonical.promote(authority)
    with canonical.connect(path) as authority:
        preview=manual_identity.comparison(authority,'local:1','soundcloud:tracks:9')
        manual_identity.link(authority,'local:1','soundcloud:tracks:9',preview['token'],'local:1')
    assert db.get(SoundCloudTrack,9) is None
    assert replay_mirror_intents(db,path)['applied']==1
    snapshot=db.get(SoundCloudTrack,9)
    assert snapshot.title=='Song' and snapshot.likes_count==42 and snapshot.playback_count is None
    assert snapshot.available is False
    provenance=json.loads(snapshot.raw_json)
    assert provenance['source_entity_id']=='soundcloud:tracks:9'
    assert provenance['source_observed_at'] is None and provenance['projection_created_at']
    assert db.get(TrackSoundCloudMatch,1).soundcloud_track_id==9
    assert replay_mirror_intents(db,path)['applied']==0


def test_replay_reserves_catalog_then_identity_and_serializes_concurrent_undo(db,tmp_path,monkeypatch):
    from contextlib import contextmanager
    from app.services import identity_sync
    path=installed_identity(tmp_path,monkeypatch);track,snapshot=soundcloud_pair(db)
    identity_sync.prepare_soundcloud_acceptance(db,track,snapshot)
    catalog_path=Path(db.get_bind().url.database)
    original_connect=canonical.connect
    @contextmanager
    def checked_connect(*args,**kwargs):
        with sqlite3.connect(catalog_path,timeout=0) as competing:
            with pytest.raises(sqlite3.OperationalError,match='locked'):
                competing.execute('BEGIN IMMEDIATE')
        with original_connect(*args,**kwargs) as authority:
            yield authority
    monkeypatch.setattr(canonical,'connect',checked_connect)
    original_commit=db.commit
    def checked_commit():
        with sqlite3.connect(path,timeout=0) as competing:
            with pytest.raises(sqlite3.OperationalError,match='locked'):
                competing.execute("UPDATE identity_acceptances SET revoked_at='concurrent undo'")
        original_commit()
    monkeypatch.setattr(db,'commit',checked_commit)
    assert identity_sync.replay_mirror_intents(db,path)['applied']==1
    monkeypatch.setattr(canonical,'connect',original_connect)
    monkeypatch.setattr(db,'commit',original_commit)
    with canonical.connect(path) as authority:
        manual_identity.undo(authority,'local:1','soundcloud:tracks:9')
    assert identity_sync.replay_mirror_intents(db,path)['applied']==1
    from app.models import TrackSoundCloudMatch
    assert db.get(TrackSoundCloudMatch,1) is None


def test_replay_does_not_commit_or_rollback_callers_pending_changes(db,tmp_path,monkeypatch):
    from app.services.identity_sync import prepare_soundcloud_acceptance,replay_mirror_intents
    path=installed_identity(tmp_path,monkeypatch);track,snapshot=soundcloud_pair(db)
    prepare_soundcloud_acceptance(db,track,snapshot)
    track.title='Pending user edit';db.add(track)
    with pytest.raises(ValueError,match='pending catalog changes'):
        replay_mirror_intents(db,path)
    assert track.title=='Pending user edit' and track in db.dirty
    db.rollback()


def test_undo_drops_trusted_candidate_anchor_on_later_sync():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    put(db,entity('spotify:track:x','spotify'));canonical.promote(db);db.commit()
    preview=manual_identity.comparison(db,'local:1','spotify:track:x')
    manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1');db.commit()
    sync_local_rows(db,[local_row(title='Song!')]);db.commit()
    assert db.execute('SELECT class FROM candidates').fetchone()[0]=='ACCEPTED'
    manual_identity.undo(db,'local:1','spotify:track:x');db.commit()
    sync_local_rows(db,[local_row(title='Song!!')]);db.commit()
    candidate=db.execute('SELECT * FROM candidates').fetchone()
    assert candidate['class']!='ACCEPTED'
    assert not (json.loads(candidate['evidence_json']).get('anchor') or {}).get('trusted')
    assert db.execute('SELECT count(*) FROM identity_acceptances WHERE revoked_at IS NULL').fetchone()[0]==0


def test_pending_mirror_cannot_reuse_retired_source_at_same_numeric_id_and_path(db,tmp_path,monkeypatch):
    from app.models import TrackSoundCloudMatch
    from app.services.identity_sync import prepare_soundcloud_acceptance,replay_mirror_intents,sync_local_rows
    path=installed_identity(tmp_path,monkeypatch);track,snapshot=soundcloud_pair(db)
    prepare_soundcloud_acceptance(db,track,snapshot)
    with canonical.connect(path) as authority:
        raw=json.loads(authority.execute("SELECT metadata_json FROM entities WHERE id='local:1'").fetchone()[0])
        raw['asset_lifecycle']={'state':'retired'}
        authority.execute("UPDATE entities SET metadata_json=? WHERE id='local:1'",(json.dumps(raw),))
        report=sync_local_rows(authority,[json.loads(track.model_dump_json())])
        assert report['active_local_ids'][1]!='local:1'
    assert replay_mirror_intents(db,path)['cancelled']==1
    assert db.get(TrackSoundCloudMatch,1) is None


def test_pending_mirror_refreshes_cached_catalog_path_after_reserving_writer(db,tmp_path,monkeypatch):
    from app.models import TrackSoundCloudMatch
    from app.services.identity_sync import prepare_soundcloud_acceptance,replay_mirror_intents
    path=installed_identity(tmp_path,monkeypatch);track,snapshot=soundcloud_pair(db)
    prepare_soundcloud_acceptance(db,track,snapshot)
    with sqlite3.connect(db.get_bind().url.database) as catalog:
        catalog.execute("UPDATE tracks SET absolute_path='/other/Song.mp3' WHERE id=1")
    assert track.absolute_path=='/library/Song.mp3'  # stale caller identity map
    assert replay_mirror_intents(db,path)['cancelled']==1
    assert db.get(TrackSoundCloudMatch,1) is None


def test_identity_detail_hides_historical_candidate_without_losing_source_membership():
    from app.services.identity_sync import sync_local_rows
    db=prepared();sync_local_rows(db,[local_row()])
    put(db,entity('spotify:track:x','spotify'));canonical.promote(db);db.commit()
    sync_local_rows(db,[local_row(title='Song!')]);db.commit()
    assert identity_library.detail(db,'spotify:track:x')['candidates']
    sync_local_rows(db,[],full_snapshot=True);db.commit()
    assert identity_library.detail(db,'spotify:track:x')['candidates']==[]
    assert db.execute('SELECT count(*) FROM entities').fetchone()[0]==2


def test_legacy_redirect_is_excluded_from_new_candidate_retrieval():
    from app.services.identity_sync import refresh_candidates
    db=prepared()
    for sid,service in [('local:1','local'),('local:old','local'),('spotify:track:x','spotify')]:
        put(db,entity(sid,service))
    # Legacy redirects retain the surviving numeric ID without a current marker.
    assert db.execute("SELECT local_track_id FROM entities WHERE id='local:old'").fetchone()[0]==1
    refresh_candidates(db,['spotify:track:x'])
    pairs={frozenset((r[0],r[1])) for r in db.execute('SELECT left_id,right_id FROM candidates')}
    assert pairs=={frozenset(('local:1','spotify:track:x'))}
    assert db.execute("SELECT count(*) FROM entities WHERE id='local:old'").fetchone()[0]==1


def test_legacy_redirect_cannot_manufacture_near_tie_for_current_asset():
    from app.services.identity_matching import refresh_near_ties
    db=prepared()
    for sid,service in [('local:1','local'),('local:old','local'),('spotify:track:x','spotify')]:
        put(db,entity(sid,service))
    for sid in ('local:1','local:old'):
        left=json.loads(db.execute('SELECT normalized_json FROM entities WHERE id=?',(sid,)).fetchone()[0])
        right=json.loads(db.execute("SELECT normalized_json FROM entities WHERE id='spotify:track:x'").fetchone()[0])
        result=score_candidate(left,right)
        result['evidence'].update(near_tie_review=True,near_tie_original_class=result['class'])
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',(sid,'spotify:track:x','local:spotify',result['score'],'AMBIGUOUS',json.dumps(result['evidence'])))
    old_before=tuple(db.execute("SELECT * FROM candidates WHERE left_id='local:old'").fetchone())
    assert refresh_near_ties(db)==1
    current=db.execute("SELECT class,evidence_json FROM candidates WHERE left_id='local:1'").fetchone()
    assert current['class']=='HIGH_CONFIDENCE'
    assert not json.loads(current['evidence_json']).get('near_tie_review')
    assert tuple(db.execute("SELECT * FROM candidates WHERE left_id='local:old'").fetchone())==old_before
    assert refresh_near_ties(db)==0


def test_identity_detail_filters_legacy_redirect_candidate_but_preserves_source_history():
    db=prepared()
    for sid,service in [('local:1','local'),('local:old','local'),('spotify:track:x','spotify')]:
        put(db,entity(sid,service))
    for sid in ('local:1','local:old'):
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',(sid,'spotify:track:x','local:spotify',95,'AMBIGUOUS','{}'))
    canonical.promote(db)
    detail=identity_library.detail(db,'spotify:track:x')
    assert [candidate['other_id'] for candidate in detail['candidates']]==['local:1']
    assert identity_library.detail(db,'local:old')['id']=='local:old'
    assert identity_library.list_items(db,mode='sources')['total']==3


def test_near_tie_refresh_uses_constant_selects_and_projected_entity_fields():
    from app.services.identity_matching import refresh_near_ties
    db=prepared();put(db,entity('local:1','local'))
    for index in range(60):
        sid=f'spotify:track:{index}';put(db,entity(sid,'spotify'))
        evidence={'conflicts':[]}
        category='HIGH_CONFIDENCE' if index<20 else 'CONFLICT'
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('local:1',sid,'local:spotify',95,category,json.dumps(evidence)))
    statements=[];db.set_trace_callback(statements.append)
    refresh_near_ties(db)
    db.set_trace_callback(None)
    selects=[statement for statement in statements if statement.lstrip().upper().startswith('SELECT')]
    assert len(selects)<=2
    assert not any('SELECT * FROM entities' in statement for statement in selects)
    assert refresh_near_ties(db)==0


def test_unchanged_sync_skips_global_annotation_refresh(monkeypatch):
    from app.services import identity_sync
    db=prepared();identity_sync.sync_local_rows(db,[local_row()])
    calls=[];status_calls=[]
    monkeypatch.setattr(identity_sync,'refresh_near_ties',lambda connection: calls.append(connection) or 0)
    monkeypatch.setattr(identity_sync,'refresh_entity_statuses',lambda connection: status_calls.append(connection) or 0)
    report=identity_sync.sync_local_rows(db,[local_row()])
    assert report['updated']==report['added']==report['superseded']==0
    assert report['near_ties_refreshed']==report['statuses_refreshed']==0
    assert calls==status_calls==[]
    identity_sync.sync_local_rows(db,[],full_snapshot=True)
    assert calls==status_calls==[db]


def test_optimized_annotation_refresh_matches_full_catalog_reference_exactly():
    from app.services.identity_matching import annotate_near_ties,refresh_near_ties
    db=prepared()
    sources=[('local:1','local'),('local:old','local'),('local:2','local'),
             ('spotify:track:a','spotify'),('spotify:track:b','spotify'),
             ('soundcloud:tracks:1','soundcloud'),('soundcloud:tracks:2','soundcloud')]
    for sid,service in sources:
        put(db,entity(sid,service))
    db.execute("UPDATE entities SET local_track_id=2 WHERE id='local:2'")
    db.execute("UPDATE entities SET recording_id='spotify:track:a' WHERE id='spotify:track:b'")
    variants=[('HIGH_CONFIDENCE',{}),('PROBABLE',{}),('AMBIGUOUS',{'near_tie_review':True}),
              ('AMBIGUOUS',{'near_tie_review':True,'near_tie_original_class':'HIGH_CONFIDENCE'}),
              ('CONFLICT',{'conflicts':['previously_rejected']}),('ACCEPTED',{}),
              ('CONFLICT',{'near_tie_review':False}),('CONFLICT',{'near_tie_original_class':None})]
    index=0
    for left,left_service in sources:
        for right,right_service in sources:
            if left>=right or left_service==right_service:
                continue
            category,extras=variants[index%len(variants)];index+=1
            evidence={'conflicts':[],**extras}
            db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',(left,right,left_service+':'+right_service,95-(index%3),category,json.dumps(evidence)))
    db.commit();reference=sqlite3.connect(':memory:');reference.row_factory=sqlite3.Row;db.backup(reference)
    # Reference the former full-read algorithm, including unchanged-byte rules.
    entities={row['id']:dict(row) for row in reference.execute('SELECT * FROM entities')}
    current={row[0] for row in reference.execute('SELECT e.id FROM entities e WHERE '+identity_library.current_local_predicate())}
    results=[];original={}
    for row in reference.execute('SELECT * FROM candidates'):
        result=dict(row);evidence=json.loads(result.pop('evidence_json'))
        a,b=(entities[result[key]] for key in ('left_id','right_id'))
        if any((item['service']=='local' and item['id'] not in current) or
               json.loads(item['metadata_json']).get('asset_lifecycle',{}).get('state')=='retired' or
               json.loads(item['metadata_json']).get('catalog_current') is False for item in (a,b)):
            continue
        original[(result['left_id'],result['right_id'])]=(result['class'],dict(evidence))
        if evidence.get('near_tie_review') and not evidence.get('near_tie_original_class'):
            refreshed=score_candidate(json.loads(a['normalized_json']),json.loads(b['normalized_json']),evidence.get('anchor'),evidence.get('collection_context'))
            result['class']=refreshed['class'] if 'previously_rejected' not in evidence.get('conflicts',[]) else 'CONFLICT'
        result['evidence']=evidence;results.append(result)
    annotate_near_ties(results,{sid:item['recording_id'] for sid,item in entities.items()},
                       {sid:item['service'] for sid,item in entities.items()})
    expected_changed=0
    for result in results:
        before_class,before_evidence=original[(result['left_id'],result['right_id'])]
        if before_class!=result['class'] or before_evidence!=result['evidence']:
            reference.execute('UPDATE candidates SET class=?,evidence_json=? WHERE left_id=? AND right_id=?',
                              (result['class'],json.dumps(result['evidence'],ensure_ascii=False,sort_keys=True),result['left_id'],result['right_id']))
            expected_changed+=1
    assert expected_changed>0
    assert refresh_near_ties(db)==expected_changed
    snapshot=lambda connection:[tuple(row) for row in connection.execute('SELECT * FROM candidates ORDER BY left_id,right_id')]
    assert snapshot(db)==snapshot(reference)
    assert refresh_near_ties(db)==0
    reference.close()


def test_new_current_candidate_updates_confidence_badge_filter_and_summary():
    from app.services.identity_sync import sync_local_rows
    db=prepared();put(db,entity('spotify:track:x','spotify'));canonical.promote(db)
    report=sync_local_rows(db,[local_row()])
    assert report['statuses_refreshed']>0
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='HIGH_CONFIDENCE'
    assert identity_library.list_items(db,query='Song',service='local',category='HIGH_CONFIDENCE')['total']==1
    assert identity_library.summary(db)['coverage']['local']['status_HIGH_CONFIDENCE']==1
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==0


def test_status_only_refresh_clears_obsolete_ambiguity_and_preserves_historical_status():
    from app.services.identity_matching import refresh_entity_statuses,refresh_near_ties
    db=prepared()
    for sid,service in [('local:1','local'),('local:old','local'),('sc:1','soundcloud'),('sc:2','soundcloud')]:
        put(db,entity(sid,service))
    db.execute("UPDATE entities SET status='PROBABLE' WHERE id='local:old'")
    for sid in ('sc:1','sc:2'):
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('local:1',sid,'local:soundcloud',95,'HIGH_CONFIDENCE','{}'))
    refresh_near_ties(db);refresh_entity_statuses(db)
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='AMBIGUOUS'
    db.execute("UPDATE entities SET recording_id='sc:1' WHERE id='sc:2'")
    refresh_near_ties(db);assert refresh_entity_statuses(db)>0
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='HIGH_CONFIDENCE'
    assert db.execute("SELECT status FROM entities WHERE id='local:old'").fetchone()[0]=='PROBABLE'
    assert refresh_entity_statuses(db)==0


def test_rejected_and_revoked_identity_status_does_not_claim_acceptance():
    from app.services.identity_sync import sync_local_rows
    db=prepared();put(db,entity('spotify:track:x','spotify'));canonical.promote(db)
    sync_local_rows(db,[local_row()]);db.commit()
    base=[tuple(row) for row in db.execute('SELECT * FROM canonical_base_entities ORDER BY entity_id')]
    preview=manual_identity.comparison(db,'local:1','spotify:track:x')
    manual_identity.link(db,'local:1','spotify:track:x',preview['token'],'local:1');db.commit()
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='ACCEPTED'
    manual_identity.undo(db,'local:1','spotify:track:x');db.commit()
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='AMBIGUOUS'
    preview=manual_identity.comparison(db,'local:1','spotify:track:x')
    manual_identity.reject(db,'local:1','spotify:track:x',preview['token']);db.commit()
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='CONFLICT'
    assert [tuple(row) for row in db.execute('SELECT * FROM canonical_base_entities ORDER BY entity_id')]==base


def test_isrc_candidate_without_canonical_acceptance_has_high_confidence_status():
    from app.services.identity_sync import sync_local_rows
    db=prepared();put(db,entity('spotify:track:x','spotify',isrc='AAA'));canonical.promote(db)
    sync_local_rows(db,[local_row(isrc='AAA')])
    assert db.execute('SELECT class FROM candidates').fetchone()[0]=='ACCEPTED'
    assert db.execute("SELECT status FROM entities WHERE id='local:1'").fetchone()[0]=='HIGH_CONFIDENCE'
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==0


def test_status_only_noop_uses_constant_queries_and_leaves_source_evidence_untouched():
    from app.services.identity_matching import refresh_entity_statuses
    db=prepared()
    for sid,service in [('local:1','local'),('local:old','local'),('spotify:track:x','spotify')]:
        put(db,entity(sid,service))
    db.execute("INSERT INTO candidates VALUES ('local:1','spotify:track:x','local:spotify',95,'HIGH_CONFIDENCE','{}')")
    db.execute("UPDATE entities SET status='NO_CANDIDATE' WHERE id='local:1'")
    assert refresh_entity_statuses(db)>0
    before=[tuple(row) for row in db.execute('SELECT id,recording_id,metadata_json,normalized_json FROM entities ORDER BY id')]
    statements=[];db.set_trace_callback(statements.append)
    assert refresh_entity_statuses(db)==0
    db.set_trace_callback(None)
    assert sum(statement.lstrip().upper().startswith('SELECT') for statement in statements)==4
    assert not any(statement.lstrip().upper().startswith('UPDATE') for statement in statements)
    assert [tuple(row) for row in db.execute('SELECT id,recording_id,metadata_json,normalized_json FROM entities ORDER BY id')]==before


def test_fast_sync_batches_unchanged_observations_and_skips_normalization(monkeypatch):
    from app.services import identity_sync
    authority = prepared()
    rows = [local_row(i,absolute_path=f'/library/{i}.mp3') for i in range(1,101)]
    identity_sync.sync_local_rows(authority,rows,refresh_candidates=False)
    calls = []
    original = identity_sync._local_item
    def normalize(row,*args):
        calls.append(row['id'])
        return original(row,*args)
    monkeypatch.setattr(identity_sync,'_local_item',normalize)
    # Full synchronization retains explicit re-derivation semantics.
    identity_sync.sync_local_rows(authority,rows,full_snapshot=True)
    assert len(calls) == 100
    calls.clear()
    queries = []
    authority.set_trace_callback(queries.append)
    before = authority.total_changes
    report = identity_sync.sync_local_rows(authority,rows,full_snapshot=True,rederive_unchanged=False)
    authority.set_trace_callback(None)
    assert report['unchanged'] == 100
    assert report['added'] == report['updated'] == report['superseded'] == 0
    assert calls == []
    assert authority.total_changes == before
    observations = [query for query in queries if query.startswith("SELECT * FROM entities WHERE service='local'")]
    assert len(observations) == 1
    # A raw catalog change is still synchronized even if its file stayed unchanged.
    rows[0]['missing'] = 1
    report = identity_sync.sync_local_rows(authority,rows,full_snapshot=True,rederive_unchanged=False)
    assert calls == [1]
    assert report['updated'] == 1 and report['unchanged'] == 99


def test_batched_sync_refreshes_overlapping_historical_pointers():
    from app.services.identity_sync import sync_local_rows
    authority = prepared()
    sync_local_rows(authority,[local_row()])
    # A legacy redirect shares another row's current numeric pointer. Handling
    # row1 supersedes that pointer; row2 must observe the new state immediately.
    authority.execute("UPDATE entities SET local_track_id=2,metadata_json=json_set(metadata_json,'$.id',2,'$.absolute_path','/library/Other.mp3') WHERE id='local:1'")
    rows = [local_row(),local_row(2,absolute_path='/library/Other.mp3')]
    result = sync_local_rows(authority,rows,refresh_candidates=False,rederive_unchanged=False)
    assert result['active_local_ids'][1] != 'local:1'
    assert result['active_local_ids'][2] != 'local:1'
    assert json.loads(authority.execute("SELECT metadata_json FROM entities WHERE id='local:1'").fetchone()[0])['catalog_current'] is False


def test_batched_sync_keeps_repeated_row_semantics():
    from app.services.identity_sync import sync_local_rows
    authority = prepared()
    result = sync_local_rows(authority,[local_row(),local_row(title='Last title')],refresh_candidates=False,rederive_unchanged=False)
    assert result['added'] == 1 and result['updated'] == 1
    assert authority.execute("SELECT title FROM entities WHERE id='local:1'").fetchone()[0] == 'Last title'


def test_fast_scan_retries_interrupted_identity_installation(db,tmp_path,monkeypatch):
    from app.models import Track
    from app.services import identity_sync,scanner
    from tests.conftest import make_wav
    from sqlmodel import select
    path = installed_identity(tmp_path,monkeypatch)
    root = tmp_path/'lib'
    make_wav(root/'Artist - Song.wav')
    monkeypatch.setattr(scanner.ffprobe_reader,'read_stream',lambda *_: {'duration':300})
    refresh = identity_sync.refresh_candidates
    attempts = []
    def once(authority,ids):
        if ids:
            attempts.append(list(ids))
            if len(attempts) == 1:
                raise RuntimeError('interrupted identity sync')
        return refresh(authority,ids)
    monkeypatch.setattr(identity_sync,'refresh_candidates',once)
    with pytest.raises(RuntimeError,match='identity synchronization failed'):
        scanner.scan(db,[root],mode='delta')
    assert db.exec(select(Track)).one().title == 'Song'
    with sqlite3.connect(path) as authority:
        assert authority.execute('SELECT count(*) FROM entities').fetchone()[0] == 0
    stats = scanner.scan(db,[root],mode='delta')
    assert stats['unchanged'] == 1 and stats['identity']['added'] == 1
    repeat = scanner.scan(db,[root],mode='delta')
    assert repeat['identity']['unchanged'] == 1
    assert len(attempts) == 2
