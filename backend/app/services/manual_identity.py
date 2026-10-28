"""Explicit human identity and asset lifecycle decisions; no source-file writes."""
import hashlib
import json
from . import canonical_library as canonical, canonical_metadata
from .identity_matching import score_candidate


def active(entity):
    return json.loads(entity['metadata_json']).get('asset_lifecycle', {}).get('state') != 'retired'


def members(db, rid):
    return [dict(r) for r in db.execute('SELECT * FROM entities WHERE recording_id=? ORDER BY id', (rid,))]


def comparison(db, left, right):
    rows = [db.execute('SELECT * FROM entities WHERE id=?', (sid,)).fetchone() for sid in (left, right)]
    if not all(rows): raise ValueError('Unknown source identity')
    groups = [members(db, r['recording_id']) for r in rows]
    hard = []
    hard_details = []
    for a in groups[0]:
        for b in groups[1]:
            if a['id'] == b['id']: continue
            pair = (a['id'], b['id'], b['id'], a['id'])
            block = db.execute("SELECT reason FROM canonical_blocks WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)", pair).fetchone()
            if block and block[0] in {'human_rejection', 'historical_rejection', 'contradictory_isrc'}:
                hard.append(f"{a['id']} ↔ {b['id']}: {block[0]}")
                hard_details.append({'left_id':a['id'],'right_id':b['id'],'conflict':block[0]})
            candidate = db.execute('SELECT evidence_json FROM candidates WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', pair).fetchone()
            if candidate and 'previously_rejected' in json.loads(candidate[0]).get('conflicts', []):
                hard.append(f"{a['id']} ↔ {b['id']}: historical_rejection")
                hard_details.append({'left_id':a['id'],'right_id':b['id'],'conflict':'historical_rejection'})
            na, nb = json.loads(a['normalized_json']), json.loads(b['normalized_json'])
            conflicts = score_candidate(na, nb)['evidence']['conflicts']
            if na.get('isrc_key') and nb.get('isrc_key') and na['isrc_key'] != nb['isrc_key']:
                conflicts = [*conflicts, 'contradictory_isrc']
            hard.extend(f"{a['id']} ↔ {b['id']}: {x}" for x in conflicts)
            hard_details.extend({'left_id':a['id'],'right_id':b['id'],'conflict':x} for x in conflicts)
    if any(not active(r) or json.loads(r['metadata_json']).get('catalog_current') is False for r in rows):
        hard.append('Retired or historical asset: select its current surviving asset.')
        hard_details.append({'conflict':'inactive_asset'})
    candidates = [dict(r) for r in db.execute('SELECT * FROM candidates WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', (left,right,right,left))]
    reasons = []
    for c in candidates:
        e = json.loads(c['evidence_json'])
        if e.get('near_tie_review'):
            ties = db.execute('SELECT DISTINCT e.recording_id FROM candidates c JOIN entities e ON e.id=CASE WHEN c.left_id=? THEN c.right_id ELSE c.left_id END WHERE (c.left_id=? OR c.right_id=?) AND c.score>=?',(left,left,left,c['score']-5)).fetchall()
            reasons.append('Near-tied source representations already share one recording.' if len(ties)==1 else 'Near-tied candidates require human review.')
        if c['class'] not in {'ACCEPTED','HIGH_CONFIDENCE'}: reasons.append('Automatic confidence/margin criteria were not met; human review is allowed.')
    snapshots = [dict(db.execute('SELECT * FROM canonical_recordings WHERE recording_id=?',(r['recording_id'],)).fetchone()) for r in rows]
    edges = [dict(r) for r in db.execute('SELECT * FROM identity_acceptances WHERE revoked_at IS NULL AND (left_id IN (SELECT id FROM entities WHERE recording_id IN (?,?)) OR right_id IN (SELECT id FROM entities WHERE recording_id IN (?,?)))',tuple(r['recording_id'] for r in rows)*2)]
    token = hashlib.sha256(canonical.dump([groups,snapshots,edges,sorted(set(hard))]).encode()).hexdigest()
    from .provider_resolution import local_asset
    def describe(e):
        raw=json.loads(e['metadata_json']);norm=json.loads(e['normalized_json'])
        return {k:e[k] for k in ('id','title','artist','service','duration_ms','recording_id')} | {'path':raw.get('previous_absolute_path') if not active(e) else raw.get('absolute_path'), 'versions':norm.get('versions',[]), 'asset':local_asset(e) if e['service']=='local' else None, 'isrc':norm.get('isrc') or norm.get('isrc_key') or None}
    choices = []
    for row, snapshot in zip(rows, snapshots):
        credits = [dict(r) for r in db.execute('SELECT a.name,ra.role,ra.credit_order FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id WHERE recording_id=? ORDER BY credit_order', (row['recording_id'],))]
        choices.append({k:snapshot[k] for k in ('recording_id','title','artist','version','release','state')} | {'credits':credits})
    display_keys = ('title','artist','version','release','credits')
    protected = [choice for choice in choices if choice['state'] in {'human','kept_local','rejected'}]
    recommended = (protected[0]['recording_id'] if len(protected)==1 else
                   choices[0]['recording_id'] if all(choices[0][key]==choices[1][key] for key in display_keys) else None)
    return {'left_id':left,'right_id':right,'token':token,'groups':[[describe(e) for e in g] for g in groups], 'hard_blocks':sorted(set(hard)), 'hard_block_details':hard_details, 'isrc_override':{'allowed':bool(hard_details) and {x['conflict'] for x in hard_details}=={'contradictory_isrc'},'conflict_class':'contradictory_isrc','conflicts':[x for x in hard_details if x['conflict']=='contradictory_isrc']}, 'automatic_reasons':reasons, 'metadata_choices':choices, 'recommended_metadata_id':recommended}


def link(db, left, right, token, metadata_from, isrc_override_reason='', *, mirror_legacy=True, refresh_matching=True):
    if not db.in_transaction: db.execute('BEGIN IMMEDIATE')
    prior=db.execute("SELECT * FROM identity_acceptances WHERE ((left_id=? AND right_id=?) OR (left_id=? AND right_id=?)) AND revoked_at IS NULL",(left,right,right,left)).fetchone()
    if prior:
        if mirror_legacy:
            from .identity_sync import record_mirror_intent
            record_mirror_intent(db,left,right)
        return {'recording_id':db.execute('SELECT recording_id FROM entities WHERE id=?',(left,)).fetchone()[0], 'already_accepted':True}
    preview=comparison(db,left,right)
    if preview['token'] != token:raise ValueError('Comparison changed. Refresh before confirming.')
    if preview['hard_blocks']:
        if not preview['isrc_override']['allowed'] or not isrc_override_reason.strip():
            raise ValueError('; '.join(preview['hard_blocks']))
        preview['isrc_override']={**preview['isrc_override'],'reason':isrc_override_reason.strip(),'confirmed_by':'human'}
    elif isrc_override_reason.strip():
        raise ValueError('An ISRC override applies only to a contradictory_isrc conflict.')
    rids=[g[0]['recording_id'] for g in preview['groups']]
    if metadata_from not in rids:raise ValueError('Choose which existing metadata to display; identity and metadata are separate.')
    target=metadata_from
    before={'groups':{rid:[e['id'] for e in members(db,rid)] for rid in set(rids)},'metadata_from':target}
    db.execute('INSERT INTO identity_acceptances VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(left_id,right_id) DO UPDATE SET revoked_at=NULL,accepted_at=excluded.accepted_at,acceptance_mode=excluded.acceptance_mode,method=excluded.method,evidence_json=excluded.evidence_json',
               (left,right,'human_identity',100,'manual_identity_confirmation',canonical.dump(preview),canonical.now(),'human'))
    for rid in set(rids):db.execute("UPDATE entities SET recording_id=?,status='ACCEPTED' WHERE recording_id=?",(target,rid))
    # Keep original canonical rows/events as provenance and stale-ID aliases.
    refresh_evidence(db,target)
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(target,'human_identity_link',canonical.dump(before),canonical.dump({'left_id':left,'right_id':right,'recording_id':target}),canonical.now()))
    if mirror_legacy:
        from .identity_sync import record_mirror_intent
        record_mirror_intent(db,left,right)
    if refresh_matching:
        from .identity_matching import refresh_entity_statuses, refresh_near_ties
        refresh_near_ties(db)
        refresh_entity_statuses(db)
    return {'recording_id':target,'already_accepted':False}


def refresh_evidence(db,rid):
    group=members(db,rid)
    derived,_=canonical_metadata.derive({rid:group})
    db.execute('UPDATE canonical_recordings SET evidence_json=?,proposal_json=?,updated_at=? WHERE recording_id=?',(canonical.dump(derived[rid]),canonical.dump(derived[rid]['proposal']),canonical.now(),rid))


def reject(db,left,right,token):
    if not db.in_transaction: db.execute('BEGIN IMMEDIATE')
    preview=comparison(db,left,right)
    if preview['token']!=token:raise ValueError('Comparison changed; refresh.')
    if preview['groups'][0][0]['recording_id']==preview['groups'][1][0]['recording_id']:raise ValueError('Undo the accepted identity edge before rejecting it.')
    db.execute("INSERT OR REPLACE INTO canonical_blocks VALUES (?,?,'human_rejection')",(left,right))
    db.execute('INSERT INTO canonical_events(action,after_json,created_at) VALUES (?,?,?)',('human_identity_rejection',canonical.dump(preview),canonical.now()))
    from .identity_sync import refresh_candidates
    from .identity_matching import refresh_entity_statuses, refresh_near_ties
    refresh_candidates(db,[left,right])
    refresh_near_ties(db)
    refresh_entity_statuses(db)
    return {'rejected':True}


def undo(db,left,right):
    if not db.in_transaction: db.execute('BEGIN IMMEDIATE')
    edge=db.execute('SELECT * FROM identity_acceptances WHERE left_id=? AND right_id=?',(left,right)).fetchone()
    if not edge or edge['method']!='manual_identity_confirmation':raise ValueError('This control only undoes manual identity links created here.')
    if edge['revoked_at']:return {'already_undone':True}
    rid=db.execute('SELECT recording_id FROM entities WHERE id=?',(left,)).fetchone()[0]
    group=members(db,rid);ids={e['id'] for e in group}
    event=db.execute("SELECT before_json FROM canonical_events WHERE action='human_identity_link' AND json_extract(after_json,'$.left_id')=? AND json_extract(after_json,'$.right_id')=? ORDER BY id DESC LIMIT 1",(left,right)).fetchone()
    original=json.loads(event[0])['groups']
    db.execute('UPDATE identity_acceptances SET revoked_at=? WHERE left_id=? AND right_id=?',(canonical.now(),left,right))
    adj={sid:set() for sid in ids}
    for e in db.execute('SELECT left_id,right_id FROM identity_acceptances WHERE revoked_at IS NULL'):
        if e[0] in ids and e[1] in ids:adj[e[0]].add(e[1]);adj[e[1]].add(e[0])
    components=[];seen=set()
    for sid in sorted(ids):
        if sid in seen:continue
        todo=[sid];component=set()
        while todo:
            x=todo.pop()
            if x in component:continue
            component.add(x);todo.extend(adj[x]-component)
        seen|=component;components.append(component)
    for component in components:
        newrid=rid if rid in component else next((old for old,oldids in original.items() if old in component),min(component))
        for sid in component:
            base=db.execute('SELECT status FROM canonical_base_entities WHERE entity_id=?',(sid,)).fetchone()
            db.execute('UPDATE entities SET recording_id=?,status=? WHERE id=?',(newrid,'ACCEPTED' if len(component)>1 else base[0],sid))
        refresh_evidence(db,newrid)
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(rid,'undo_human_identity',canonical.dump(dict(edge)),canonical.dump({'components':[sorted(c) for c in components]}),canonical.now()))
    still_connected = any(left in component and right in component for component in components)
    if not still_connected:
        from .identity_sync import record_mirror_intent
        record_mirror_intent(db,left,right,operation='remove')
    from .identity_sync import refresh_candidates
    refresh_candidates(db,[left,right])
    from .identity_matching import refresh_entity_statuses, refresh_near_ties
    refresh_near_ties(db)
    refresh_entity_statuses(db)
    return {'still_connected':still_connected}


def retire(db,entity_id,survivor_id=None,restore=False):
    db.execute('BEGIN IMMEDIATE')
    row=db.execute("SELECT * FROM entities WHERE id=? AND service='local'",(entity_id,)).fetchone()
    if not row:raise ValueError('Unknown local asset')
    raw=json.loads(row['metadata_json']);before=dict(raw)
    if restore:
        raw.pop('asset_lifecycle',None)
    else:
        from ..config import get_settings
        import sqlite3
        from .library_paths import resolve_source_path
        with sqlite3.connect(get_settings().db_file) as catalog:
            obsolete_id=int(entity_id.split(':')[1])
            audit=catalog.execute("SELECT before_json,after_json FROM audit_log WHERE action='merge_missing_duplicate' AND entity_id=? ORDER BY id DESC LIMIT 1",(obsolete_id,)).fetchone()
            if not audit:raise ValueError('Confirmed dedup deletion evidence is required; missing files are never automatically retired.')
            old=json.loads(audit[0]);decision=json.loads(audit[1])
            if survivor_id!=f"local:{decision['keep']}":raise ValueError('Survivor differs from the recorded dedup decision.')
            try:
                old_path = resolve_source_path(old['absolute_path'])
            except OSError as exc:
                raise ValueError('The original root is unavailable; retirement cannot be verified.') from exc
            if old_path.exists():raise ValueError('The obsolete file still exists.')
            survivor=catalog.execute('SELECT absolute_path FROM tracks WHERE id=?',(decision['keep'],)).fetchone()
            try:
                survivor_available = survivor and resolve_source_path(survivor[0]).is_file()
            except OSError:
                survivor_available = False
            if not survivor_available:raise ValueError('Surviving file is unavailable.')
            if catalog.execute('SELECT 1 FROM tracks WHERE id=?',(obsolete_id,)).fetchone():raise ValueError('Catalog row still exists; retire it explicitly before the historical asset.')
        raw['asset_lifecycle']={'state':'retired','reason':'dedup_deleted','survivor_id':survivor_id,'original_path':old['absolute_path'],'retired_at':canonical.now()}
    db.execute('UPDATE entities SET metadata_json=? WHERE id=?',(canonical.dump(raw),entity_id))
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(row['recording_id'],'restore_asset_visibility' if restore else 'retire_duplicate_asset',canonical.dump(before),canonical.dump(raw),canonical.now()))
    return {'entity_id':entity_id,'retired':not restore,'restores_audio':False}
