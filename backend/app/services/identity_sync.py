"""Incremental identity maintenance and replayable catalog mirrors.

Only the two SQLite catalogs are written. Source audio and source memberships
are immutable here; accepted components and human metadata are never rebuilt.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path

from . import canonical_library as canonical, canonical_metadata, identity_library
from .identity_matching import CandidateIndex, normalized_item, refresh_entity_statuses, refresh_near_ties, score_candidate


def _event(db, action, before=None, after=None, recording_id=None):
    return db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',
                      (recording_id, action, canonical.dump(before) if before is not None else None,
                       canonical.dump(after) if after is not None else None, canonical.now())).lastrowid


def _canonical_row(db, sid):
    row = dict(db.execute('SELECT * FROM entities WHERE id=?', (sid,)).fetchone())
    rid = row['recording_id']
    db.execute('INSERT OR IGNORE INTO canonical_base_entities VALUES (?,?,?)', (sid, rid, row['status']))
    existing = db.execute('SELECT * FROM canonical_recordings WHERE recording_id=?', (rid,)).fetchone()
    if existing and (existing['state'] in {'human','kept_local','rejected'} or
                     db.execute("SELECT 1 FROM canonical_events WHERE recording_id=? AND action='human_identity_link' LIMIT 1", (rid,)).fetchone()):
        from .manual_identity import refresh_evidence
        refresh_evidence(db, rid)
        return
    group = [dict(r) for r in db.execute('SELECT * FROM entities WHERE recording_id=?', (rid,))]
    derived, _ = canonical_metadata.derive({rid: group})
    value = derived[rid]; proposal = value['proposal']
    db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)', (rid, value['title'], 'PROVISIONAL'))
    db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,version=excluded.version,release=excluded.release,state=excluded.state,proposal_json=excluded.proposal_json,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at',
               (rid, value['title'], value['artist'], proposal['version'], proposal['release'], value['state'],
                canonical.dump(proposal), canonical.dump(value), canonical.now()))
    canonical.set_credits(db, rid, proposal['credits'] if value['state'] == 'derived' else canonical_metadata.credits(value['artist'], value['title']))


def _local_item(row, sid, previous=None):
    previous = previous or {}
    item = {**previous, 'id': sid, 'service': 'local', 'kind': 'track', 'local_track_id': row['id']}
    for key in ('title', 'artist', 'file_name', 'album', 'label', 'genre', 'year', 'bpm', 'isrc'):
        if key in row:
            item[key] = row[key]
    item['duration_ms'] = row.get('duration') * 1000 if row.get('duration') is not None else None
    if (item['duration_ms'] or 0) >= 1200000 or re.search(r'\bdj\s*(?:mix|set)\b', item.get('title') or '', re.I):
        item['kind'] = 'long_form'
    item.pop('raw', None)
    return normalized_item(item)


def _store_observation(db, item, raw, existing=None):
    sid = item['id']
    encoded_raw = canonical.dump(raw); encoded_norm = canonical.dump(item)
    if existing:
        if json.loads(existing['metadata_json']) == raw and json.loads(existing['normalized_json']) == item:
            return False
        db.execute('UPDATE entities SET title=?,artist=?,duration_ms=?,metadata_json=?,normalized_json=? WHERE id=?',
                   (item.get('title'), item.get('artist'), item.get('duration_ms'), encoded_raw, encoded_norm, sid))
        _event(db, 'source_observation_update', dict(existing), {'entity_id': sid, 'metadata': raw, 'normalized': item}, existing['recording_id'])
    else:
        db.execute('INSERT INTO recordings VALUES (?,?,?)', (sid, item.get('title'), 'PROVISIONAL'))
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                   (sid, item['service'], item.get('title'), item.get('artist'), item.get('duration_ms'),
                    item.get('local_track_id'), item.get('permalink'), sid, 'NO_CANDIDATE', encoded_raw, encoded_norm))
        _event(db, 'source_observation_added', after={'entity_id': sid}, recording_id=sid)
    _canonical_row(db, sid)
    return True


def refresh_candidates(db, changed_ids):
    """Retrieve changed observations against the current index without merging them."""
    if not changed_ids:
        return 0
    entities = {r['id']: dict(r) for r in db.execute(
                    "SELECT e.* FROM entities e WHERE e.service!='local' OR (" +
                    identity_library.current_local_predicate() + ')')
                if json.loads(r['metadata_json']).get('asset_lifecycle', {}).get('state') != 'retired'
                and json.loads(r['metadata_json']).get('catalog_current') is not False}
    index = CandidateIndex([json.loads(r['normalized_json']) for r in entities.values()])
    changed = 0
    for sid in sorted(set(changed_ids) & entities.keys()):
        item = index.items[sid]
        old = db.execute('SELECT left_id,right_id FROM candidates WHERE left_id=? OR right_id=?', (sid, sid)).fetchall()
        other_ids = set(index.retrieve(item)) | {r[1] if r[0] == sid else r[0] for r in old}
        for other in sorted(other_ids & entities.keys() - {sid}):
            if item['service'] == index.items[other]['service']:
                continue
            a, b = sorted((sid, other))
            previous = db.execute('SELECT * FROM candidates WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', (a,b,b,a)).fetchone()
            if previous:
                a,b = previous['left_id'], previous['right_id']
            old_evidence = json.loads(previous['evidence_json']) if previous else {}
            ledger = db.execute('SELECT * FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', (a,b,b,a)).fetchone()
            acceptance = ledger if ledger and not ledger['revoked_at'] else None
            block = db.execute('SELECT reason FROM canonical_blocks WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', (a,b,b,a)).fetchone()
            anchor = old_evidence.get('anchor')
            if ledger and ledger['revoked_at']:
                anchor = None
            if acceptance:
                anchor = {'trusted': True, 'method': acceptance['method']}
            elif (block and block[0] in {'human_rejection','historical_rejection'}) or 'previously_rejected' in old_evidence.get('conflicts', []):
                anchor = {'status': 'rejected'}
            result = score_candidate(index.items[a], index.items[b], anchor, old_evidence.get('collection_context'))
            if ledger and ledger['revoked_at']:
                result['evidence']['revoked_identity_decision'] = True
                if result['class'] in {'ACCEPTED','HIGH_CONFIDENCE'}:
                    result['class'] = 'AMBIGUOUS'
            if old_evidence.get('historical_provenance'):
                result['evidence']['historical_provenance'] = old_evidence['historical_provenance']
            if previous:
                db.execute('UPDATE candidates SET score=?,class=?,evidence_json=? WHERE left_id=? AND right_id=?',
                           (result['score'], result['class'], canonical.dump(result['evidence']), a,b))
            else:
                db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',
                           (a,b,':'.join(sorted((item['service'], index.items[other]['service']))),result['score'],result['class'],canonical.dump(result['evidence'])))
            changed += 1
    return changed


def ensure_local_indexes(db):
    """Materialize the shared indexes without replaying any identity data."""
    db.execute('CREATE INDEX IF NOT EXISTS entities_local_track_id ON entities(local_track_id)')
    db.execute('CREATE INDEX IF NOT EXISTS entities_recording_service ON entities(recording_id,service,id)')


def sync_local_rows(db, rows, *, full_snapshot=False, refresh_candidates=True, rederive_unchanged=True):
    """Caller owns transaction. A partial batch never infers absent catalog rows."""
    ensure_local_indexes(db)
    if not canonical.available(db):
        raise ValueError('Identity catalog requires canonical initialization before incremental synchronization.')
    rows = [dict(r) for r in rows]
    report = {'added': 0, 'updated': 0, 'unchanged': 0, 'superseded': 0, 'active_local_ids': {}, 'candidates_refreshed': 0, 'statuses_refreshed': 0}
    changed = []
    # One scoped read replaces a local-observation query for every track. Exact
    # legacy IDs can point at a different surviving numeric ID, so index each
    # observation under both pointers just as the previous OR predicate did.
    track_ids = {row['id'] for row in rows}
    observations = {}
    overlapping_pointers = set()
    seen_ids = set()
    if track_ids:
        source_ids = [f'local:{track_id}' for track_id in track_ids]
        for candidate in db.execute(
                "SELECT * FROM entities WHERE service='local' AND (local_track_id IN (SELECT value FROM json_each(?)) "
                "OR id IN (SELECT value FROM json_each(?))) ORDER BY id", (canonical.dump(sorted(track_ids)),canonical.dump(source_ids))):
            pointers = {candidate['local_track_id']}
            suffix = candidate['id'].removeprefix('local:')
            if candidate['id'].startswith('local:') and suffix.isdigit():
                pointers.add(int(suffix))
            relevant = pointers & track_ids
            if len(relevant) > 1:
                overlapping_pointers.update(relevant)
            for pointer in relevant:
                observations.setdefault(pointer,[]).append(candidate)
    for row in rows:
        track_id = row['id']; path = row.get('absolute_path')
        candidates = observations.get(track_id,[])
        if track_id in overlapping_pointers or track_id in seen_ids:
            # A historical redirect can be superseded while handling another
            # row in this batch. Read that uncommon ambiguity fresh rather than
            # reusing its stale pre-batch pointer. Repeated input IDs do likewise.
            candidates = db.execute("SELECT * FROM entities WHERE service='local' AND (local_track_id=? OR id=?) ORDER BY id", (track_id,f'local:{track_id}')).fetchall()
        seen_ids.add(track_id)
        current = None
        for candidate in candidates:
            raw = json.loads(candidate['metadata_json'])
            retired = raw.get('asset_lifecycle', {}).get('state') == 'retired'
            # Redirect observations may share a surviving numeric ID, but their
            # original path and exact source ID remain historical evidence.
            exact_pointer = candidate['id'] == f'local:{track_id}' or raw.get('catalog_current') is True
            if not retired and candidate['local_track_id'] == track_id and exact_pointer and raw.get('absolute_path') in (None, path) and raw.get('catalog_current') is not False:
                if current is not None:
                    raise ValueError(f'Multiple current observations for catalog track {track_id}; repair the pointer before synchronization.')
                current = candidate
            elif raw.get('catalog_current') is not False and (exact_pointer or retired):
                before = dict(raw); raw['catalog_current'] = False
                db.execute('UPDATE entities SET metadata_json=? WHERE id=?', (canonical.dump(raw), candidate['id']))
                _event(db, 'catalog_pointer_superseded', before, {'entity_id':candidate['id'], 'metadata':raw}, candidate['recording_id'])
                report['superseded'] += 1
        if current:
            sid = current['id']; raw = {**json.loads(current['metadata_json']), **row, 'catalog_current': True}
            previous = json.loads(current['normalized_json'])
            if not rederive_unchanged and raw == json.loads(current['metadata_json']):
                report['unchanged'] += 1
                report['active_local_ids'][track_id] = sid
                continue
        else:
            sid = f'local:{track_id}'
            if db.execute('SELECT 1 FROM entities WHERE id=?', (sid,)).fetchone():
                digest = hashlib.sha256(str(path).encode()).hexdigest()[:16]
                sid += ':' + digest
                suffix = 1
                while db.execute('SELECT 1 FROM entities WHERE id=?', (sid,)).fetchone():
                    sid = f'local:{track_id}:{digest}:{suffix}'; suffix += 1
            raw = {**row, 'catalog_current': True}; previous = {}
        item = _local_item(row, sid, previous)
        if _store_observation(db, item, raw, current):
            report['updated' if current else 'added'] += 1
            changed.append(sid)
        report['active_local_ids'][track_id] = sid
    if full_snapshot:
        current_ids = set(report['active_local_ids'].values())
        for row in db.execute('SELECT e.* FROM entities e WHERE ' + identity_library.current_local_predicate()).fetchall():
            if row['id'] not in current_ids:
                raw = json.loads(row['metadata_json']); before = dict(raw); raw['catalog_current'] = False
                db.execute('UPDATE entities SET metadata_json=? WHERE id=?', (canonical.dump(raw),row['id']))
                _event(db,'catalog_pointer_absent',before,{'entity_id':row['id'],'metadata':raw},row['recording_id'])
                report['superseded'] += 1
    if refresh_candidates:
        report['candidates_refreshed'] = globals()['refresh_candidates'](db, changed)
        report['near_ties_refreshed'] = refresh_near_ties(db) if changed or report['superseded'] else 0
        if changed or report['superseded']:
            report['statuses_refreshed'] = refresh_entity_statuses(db)
    return report


def ensure_soundcloud(db, snapshot):
    row = dict(snapshot)
    remote_id = row['soundcloud_track_id']; sid = f'soundcloud:tracks:{remote_id}'
    existing = db.execute('SELECT * FROM entities WHERE id=?', (sid,)).fetchone()
    # Staging source observations are retained intact; only create a provider
    # observation when the current catalog introduces a previously unseen ID.
    if existing:
        return sid
    publisher = json.loads(row.get('publisher_metadata_json') or '{}')
    item = normalized_item({'id':sid,'service':'soundcloud','title':row.get('title'),
                            'artist':publisher.get('artist'), 'uploader':row.get('uploader_username'),
                            'duration_ms':row.get('full_duration_ms') or row.get('duration_ms'),
                            'isrc':publisher.get('isrc'), 'genre':row.get('genre'), 'label':row.get('label_name'),
                            'kind':'track','permalink':row.get('permalink_url')})
    _store_observation(db,item,row)
    return sid


def _identity_path(catalog_path, identity_path=None):
    path = Path(identity_path) if identity_path is not None else identity_library.database_path(catalog_path)
    if not path.exists():
        if identity_path is not None or os.environ.get('CRATEMIND_IDENTITY_DB_PATH'):
            raise ValueError(f'Configured identity catalog is unavailable: {path}')
        return None
    return path


def sync_catalog(catalog_path, identity_path=None, track_ids=None, *, reconcile_confirmed=True, rederive_unchanged=True):
    """Repair only the paired catalogs. Safe to replay; never creates an identity DB."""
    path = _identity_path(catalog_path, identity_path)
    if path is None:
        return {'identity_installed':False,'added':0,'updated':0,'active_local_ids':{}}
    with sqlite3.connect(Path(catalog_path).resolve().as_uri()+'?mode=ro',uri=True) as catalog:
        catalog.row_factory = sqlite3.Row
        query = 'SELECT * FROM tracks'; args = []
        if track_ids is not None:
            track_ids = list(set(track_ids))
            if not track_ids:
                return {'identity_installed':True,'added':0,'updated':0,'active_local_ids':{}}
            query += ' WHERE id IN ('+','.join('?' for _ in track_ids)+')'; args = track_ids
        rows = catalog.execute(query,args).fetchall()
        with canonical.connect(path) as db:
            db.execute('BEGIN IMMEDIATE')
            report = sync_local_rows(db,rows,full_snapshot=track_ids is None,rederive_unchanged=rederive_unchanged)
            report['identity_installed'] = True
            if reconcile_confirmed:
                report['confirmed_links'] = reconcile_confirmed_links(db,catalog,report['active_local_ids'])
        return report


def sync_session(session, track_ids=None, *, rederive_unchanged=True):
    """Scanner hook after the catalog transaction commits."""
    database = session.get_bind().url.database
    if not database or database == ':memory:':
        if os.environ.get('CRATEMIND_IDENTITY_DB_PATH'):
            raise ValueError('A file-backed catalog is required for the configured identity catalog.')
        return {'identity_installed':False,'active_local_ids':{}}
    return sync_catalog(database,track_ids=track_ids,rederive_unchanged=rederive_unchanged)


def record_mirror_intent(db, left, right, *, operation='accept'):
    """Persist mirror evidence in the same transaction as the identity decision."""
    rows = [db.execute('SELECT * FROM entities WHERE id=?',(sid,)).fetchone() for sid in (left,right)]
    if {r['service'] for r in rows} != {'local','soundcloud'}:
        return None
    local = next(r for r in rows if r['service']=='local')
    remote = next(r for r in rows if r['service']=='soundcloud')
    match = re.fullmatch(r'soundcloud:tracks:(\d+)',remote['id'])
    if not match:
        return None
    acceptance = db.execute('SELECT * FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', (left,right,right,left)).fetchone()
    if not acceptance:
        raise ValueError('An authoritative acceptance is required before mirroring a link.')
    payload = {'left_id':acceptance['left_id'],'right_id':acceptance['right_id'],
               'accepted_at':acceptance['accepted_at'],'operation':operation,
               'track_id':local['local_track_id'],'soundcloud_track_id':int(match[1]),
               'absolute_path':json.loads(local['metadata_json']).get('absolute_path'),
               'confidence':acceptance['confidence'],'method':'manual_review'}
    # The acceptance timestamp distinguishes a genuinely renewed decision from
    # a retry, including two decisions concerning the same pair.
    prior = db.execute("SELECT id FROM canonical_events WHERE action='legacy_soundcloud_mirror_intent' AND after_json=?", (canonical.dump(payload),)).fetchone()
    return prior[0] if prior else _event(db,'legacy_soundcloud_mirror_intent',after=payload,recording_id=local['recording_id'])


def reconcile_confirmed_links(db, catalog, active_local_ids=None):
    """Import explicit legacy human evidence, while honoring later authority decisions."""
    from . import manual_identity
    active_local_ids = active_local_ids or {}
    report = {'accepted':0,'already_consistent':0,'protected':0,'unavailable':0,'accepted_pairs':[],'protected_pairs':[]}
    if not catalog.execute("SELECT 1 FROM sqlite_master WHERE name='track_soundcloud_matches'").fetchone():
        return report
    query = "SELECT * FROM track_soundcloud_matches WHERE confirmed_at IS NOT NULL"
    for match in catalog.execute(query):
        match = dict(match); local = identity_library.current_local_entity(db,match['track_id'])
        if not local:
            report['unavailable'] += 1; continue
        if active_local_ids and match['track_id'] not in active_local_ids:
            continue
        remote = catalog.execute('SELECT * FROM soundcloud_tracks WHERE soundcloud_track_id=?',(match['soundcloud_track_id'],)).fetchone()
        if not remote:
            report['unavailable'] += 1; continue
        right = ensure_soundcloud(db,remote); left = local['id']
        prior = db.execute('SELECT * FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)',(left,right,right,left)).fetchone()
        if prior and prior['revoked_at']:
            report['protected'] += 1
            report['protected_pairs'].append({'left_id':left,'right_id':right,'reasons':['revoked_acceptance']})
            continue
        preview = manual_identity.comparison(db,left,right)
        if preview['hard_blocks']:
            report['protected'] += 1
            report['protected_pairs'].append({'left_id':left,'right_id':right,'reasons':preview['hard_blocks']})
            continue
        if local['recording_id'] == db.execute('SELECT recording_id FROM entities WHERE id=?',(right,)).fetchone()[0]:
            report['already_consistent'] += 1; continue
        # Preserve the local component's display metadata and its human credits.
        manual_identity.link(db,left,right,preview['token'],local['recording_id'],mirror_legacy=False,refresh_matching=False)
        db.execute('UPDATE identity_acceptances SET match_source=?,method=?,accepted_at=?,evidence_json=? WHERE left_id=? AND right_id=?',
                   ('legacy_soundcloud_confirmation','legacy_confirmed_manual_review',match['confirmed_at'],
                    canonical.dump({'legacy_confirmation':match,'comparison':preview}),left,right))
        report['accepted'] += 1
        report['accepted_pairs'].append({'left_id':left,'right_id':right,'recording_id':local['recording_id']})
    if report['accepted']:
        report['near_ties_refreshed'] = refresh_near_ties(db)
        report['statuses_refreshed'] = refresh_entity_statuses(db)
    return report


def _session_catalog_path(session):
    database = session.get_bind().url.database
    if not database or database == ':memory:':
        if os.environ.get('CRATEMIND_IDENTITY_DB_PATH'):
            raise ValueError('The configured identity catalog requires a paired file-backed catalog.')
        return None
    return Path(database)


def prepare_soundcloud_acceptance(session, track, snapshot):
    """Commit authority+mirror intent first; caller then replays the catalog mirror."""
    from . import manual_identity
    catalog_path = _session_catalog_path(session)
    if catalog_path is None:
        return None
    path = _identity_path(catalog_path)
    if path is None:
        return None
    with canonical.connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        synced = sync_local_rows(db,[json.loads(track.model_dump_json())],refresh_candidates=False)
        left = synced['active_local_ids'][track.id]
        right = ensure_soundcloud(db,json.loads(snapshot.model_dump_json()))
        preview = manual_identity.comparison(db,left,right)
        manual_identity.link(db,left,right,preview['token'],preview['groups'][0][0]['recording_id'])
        record_mirror_intent(db,left,right)
    return path


def _legacy_soundcloud_snapshot(db, payload):
    """Project an existing authority observation only when the legacy FK needs it."""
    from ..models import SoundCloudTrack
    from .provider_resolution import source
    from .soundcloud import parse_import_item, sanitize_raw_json
    sid = f"soundcloud:tracks:{payload['soundcloud_track_id']}"
    entity = db.execute("SELECT * FROM entities WHERE id=? AND service='soundcloud'", (sid,)).fetchone()
    if not entity:
        raise ValueError('The accepted SoundCloud source observation is unavailable.')
    raw = json.loads(entity['metadata_json'])
    snapshot = source(entity)['soundcloud_snapshot']
    projection_time = canonical.now()
    observed_at = snapshot.get('fetched_at') or raw.get('fetched_at')
    parsed = parse_import_item({**snapshot, 'id':payload['soundcloud_track_id']},
                               run_id='identity_mirror', fetched_at=observed_at or projection_time)
    values = parsed.values if parsed else {'soundcloud_track_id':payload['soundcloud_track_id'],
                                           'title':entity['title'],'permalink_url':entity['permalink'],
                                           'duration_ms':entity['duration_ms'],'fetched_at':observed_at or projection_time}
    # An archived identity observation is not a fresh availability probe. Unknown
    # availability remains conservative, and absent popularity stays NULL.
    values['available'] = raw.get('availability') == 'available' or raw.get('available') is True
    values['raw_json'] = canonical.dump(sanitize_raw_json({'source_entity_id':sid,'identity_source':raw,
                                                          'source_observed_at':observed_at,
                                                          'projection_created_at':projection_time}))
    return SoundCloudTrack(**values)


def _reserve_catalog_mirror(session):
    if session.new or session.dirty or session.deleted:
        raise ValueError('Commit pending catalog changes before replaying identity decisions.')
    connection = session.connection()
    driver = connection.connection.driver_connection
    if driver.in_transaction:
        raise ValueError('Commit the current catalog transaction before replaying identity decisions.')
    connection.exec_driver_sql('BEGIN IMMEDIATE')


def _replay_mirror_intent(session, db, event):
    from sqlmodel import select
    from ..models import Track, SoundCloudTrack, TrackSoundCloudMatch, SoundCloudMatchCandidate
    payload = json.loads(event['after_json'])
    acceptance = db.execute('SELECT * FROM identity_acceptances WHERE left_id=? AND right_id=?',(payload['left_id'],payload['right_id'])).fetchone()
    track = session.get(Track,payload['track_id'],populate_existing=True)
    current_local = identity_library.current_local_entity(db,payload['track_id'],track.absolute_path if track else None)
    local_sid = next((sid for sid in (payload['left_id'],payload['right_id']) if sid.startswith('local:')),None)
    valid_pointer = bool(current_local and current_local['id']==local_sid)
    valid_path = track and (not payload.get('absolute_path') or track.absolute_path == payload['absolute_path'])
    live_acceptance = bool(acceptance and not acceptance['revoked_at'] and acceptance['accepted_at']==payload['accepted_at'])
    removing = payload.get('operation') == 'remove'
    valid = bool(valid_pointer and valid_path and (not live_acceptance if removing else live_acceptance))
    if valid and not removing:
        entities = [db.execute('SELECT recording_id FROM entities WHERE id=?',(sid,)).fetchone() for sid in (payload['left_id'],payload['right_id'])]
        valid = all(entities) and entities[0][0]==entities[1][0]
    if not valid:
        _event(db,'legacy_soundcloud_mirror_cancelled',after={'intent_id':event['id'],'reason':'decision_revoked_or_observation_changed'})
        return 'cancelled'
    existing = session.get(TrackSoundCloudMatch,payload['track_id'])
    try:
        if removing:
            if existing and existing.soundcloud_track_id==payload['soundcloud_track_id']:
                session.delete(existing)
            candidate = session.get(SoundCloudMatchCandidate,(payload['track_id'],payload['soundcloud_track_id']))
            if candidate:
                candidate.status='rejected';candidate.decided_at=canonical.now();session.add(candidate)
        else:
            if not session.get(SoundCloudTrack,payload['soundcloud_track_id']):
                snapshot = _legacy_soundcloud_snapshot(db, payload)
                session.add(snapshot)
                session.flush()
            if existing is None:
                existing=TrackSoundCloudMatch(track_id=payload['track_id'],soundcloud_track_id=payload['soundcloud_track_id'],confidence=payload['confidence'],method=payload['method'],reasons_json=canonical.dump(['canonical_identity_confirmation']),matched_at=payload['accepted_at'],confirmed_at=payload['accepted_at'])
            else:
                existing.soundcloud_track_id=payload['soundcloud_track_id'];existing.confidence=payload['confidence']
                existing.method=payload['method'];existing.matched_at=payload['accepted_at'];existing.confirmed_at=payload['accepted_at']
            session.add(existing)
            for candidate in session.exec(select(SoundCloudMatchCandidate).where(SoundCloudMatchCandidate.track_id==payload['track_id'])).all():
                candidate.status='accepted' if candidate.soundcloud_track_id==payload['soundcloud_track_id'] else 'rejected'
                candidate.decided_at=payload['accepted_at'];session.add(candidate)
        session.commit()
    except Exception as exc:
        session.rollback()
        # Authority and pending evidence were committed before this call.
        # Never report a successful link while the mirror remains stale.
        raise ValueError('Identity decision saved; catalog mirror failed. Retry to reconcile the pending decision.') from exc
    try:
        _event(db,'legacy_soundcloud_mirror_applied',after={'intent_id':event['id']})
    except Exception as exc:
        raise ValueError('Catalog mirror saved; identity acknowledgment failed. Retry to reconcile the pending decision.') from exc
    return 'applied'


def replay_mirror_intents(session, identity_path=None):
    """Replay with catalog→identity lock order, preserving unrelated caller work."""
    catalog_path = _session_catalog_path(session)
    if catalog_path is None:
        return {'applied':0,'cancelled':0}
    path = _identity_path(catalog_path,identity_path)
    if path is None:
        return {'applied':0,'cancelled':0}
    result = {'applied':0,'cancelled':0}
    pending = "SELECT i.id,i.after_json FROM canonical_events i WHERE i.action='legacy_soundcloud_mirror_intent' AND NOT EXISTS(SELECT 1 FROM canonical_events done WHERE done.action IN ('legacy_soundcloud_mirror_applied','legacy_soundcloud_mirror_cancelled') AND json_extract(done.after_json,'$.intent_id')=i.id)"
    with identity_library.connect(path) as db:
        intent_ids = [r[0] for r in db.execute(pending+' ORDER BY i.id')]
    for intent_id in intent_ids:
        # Reserve in the same order as paired backups. Every iteration releases
        # both locks before another catalog reservation; never invert the order.
        _reserve_catalog_mirror(session)
        try:
            with canonical.connect(path) as db:
                db.execute('BEGIN IMMEDIATE')
                event = db.execute(pending+' AND i.id=?', (intent_id,)).fetchone()
                if event:
                    outcome = _replay_mirror_intent(session,db,event)
                    result[outcome] += 1
            # Cancellation or another replay may need no catalog write. Release
            # only the reservation made above; caller changes were rejected.
            if session.connection().connection.driver_connection.in_transaction:
                session.rollback()
        except Exception:
            session.rollback()
            raise
    return result


def reject_soundcloud_identity(session, track, snapshot):
    """Persist a pending candidate rejection in authority before legacy commit."""
    from . import manual_identity
    catalog_path = _session_catalog_path(session)
    if catalog_path is None:
        return
    path = _identity_path(catalog_path)
    if path is None:
        return
    with canonical.connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        synced=sync_local_rows(db,[json.loads(track.model_dump_json())],refresh_candidates=False)
        left=synced['active_local_ids'][track.id];right=ensure_soundcloud(db,json.loads(snapshot.model_dump_json()))
        preview=manual_identity.comparison(db,left,right)
        if preview['groups'][0][0]['recording_id']==preview['groups'][1][0]['recording_id']:
            raise ValueError('Undo the accepted canonical identity before rejecting this candidate.')
        manual_identity.reject(db,left,right,preview['token'])


def verify_soundcloud_acceptance(session, track_id, soundcloud_track_id, identity_path):
    from ..models import TrackSoundCloudMatch
    mirror = session.get(TrackSoundCloudMatch, track_id)
    with identity_library.connect(identity_path) as db:
        local = identity_library.current_local_entity(db, track_id)
        right = f'soundcloud:tracks:{soundcloud_track_id}'
        accepted = local and db.execute("SELECT 1 FROM identity_acceptances WHERE ((left_id=? AND right_id=?) OR (left_id=? AND right_id=?)) AND revoked_at IS NULL", (local['id'],right,right,local['id'])).fetchone()
    if not accepted or not mirror or mirror.soundcloud_track_id != soundcloud_track_id:
        raise ValueError('The identity decision changed before its catalog mirror completed. Refresh the comparison.')
