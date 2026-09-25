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
    for a in groups[0]:
        for b in groups[1]:
            if a['id'] == b['id']: continue
            pair = (a['id'], b['id'], b['id'], a['id'])
            block = db.execute("SELECT reason FROM canonical_blocks WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)", pair).fetchone()
            if block and block[0] in {'human_rejection', 'historical_rejection', 'contradictory_isrc'}:
                hard.append(f"{a['id']} ↔ {b['id']}: {block[0]}")
            candidate = db.execute('SELECT evidence_json FROM candidates WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', pair).fetchone()
            if candidate and 'previously_rejected' in json.loads(candidate[0]).get('conflicts', []):
                hard.append(f"{a['id']} ↔ {b['id']}: historical_rejection")
            na, nb = json.loads(a['normalized_json']), json.loads(b['normalized_json'])
            conflicts = score_candidate(na, nb)['evidence']['conflicts']
            if na.get('isrc_key') and nb.get('isrc_key') and na['isrc_key'] != nb['isrc_key']:
                conflicts = [*conflicts, 'contradictory_isrc']
            hard.extend(f"{a['id']} ↔ {b['id']}: {x}" for x in conflicts)
    if any(not active(r) for r in rows): hard.append('Retired asset: select its surviving asset.')
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
        return {k:e[k] for k in ('id','title','artist','service','duration_ms','recording_id')} | {'path':raw.get('previous_absolute_path') if not active(e) else raw.get('absolute_path'), 'versions':norm.get('versions',[]), 'asset':local_asset(e) if e['service']=='local' else None}
    return {'left_id':left,'right_id':right,'token':token,'groups':[[describe(e) for e in g] for g in groups], 'hard_blocks':sorted(set(hard)), 'automatic_reasons':reasons, 'metadata_choices':[{'recording_id':r['recording_id'],'title':s['title'],'artist':s['artist'],'state':s['state']} for r,s in zip(rows,snapshots)]}


def link(db, left, right, token, metadata_from):
    db.execute('BEGIN IMMEDIATE')
    prior=db.execute("SELECT * FROM identity_acceptances WHERE ((left_id=? AND right_id=?) OR (left_id=? AND right_id=?)) AND revoked_at IS NULL",(left,right,right,left)).fetchone()
    if prior:return {'recording_id':db.execute('SELECT recording_id FROM entities WHERE id=?',(left,)).fetchone()[0], 'already_accepted':True}
    preview=comparison(db,left,right)
    if preview['token'] != token:raise ValueError('Comparison changed. Refresh before confirming.')
    if preview['hard_blocks']:raise ValueError('; '.join(preview['hard_blocks']))
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
    return {'recording_id':target,'already_accepted':False}


def refresh_evidence(db,rid):
    group=members(db,rid)
    derived,_=canonical_metadata.derive({rid:group})
    db.execute('UPDATE canonical_recordings SET evidence_json=?,proposal_json=?,updated_at=? WHERE recording_id=?',(canonical.dump(derived[rid]),canonical.dump(derived[rid]['proposal']),canonical.now(),rid))


def reject(db,left,right,token):
    db.execute('BEGIN IMMEDIATE')
    preview=comparison(db,left,right)
    if preview['token']!=token:raise ValueError('Comparison changed; refresh.')
    if preview['groups'][0][0]['recording_id']==preview['groups'][1][0]['recording_id']:raise ValueError('Undo the accepted identity edge before rejecting it.')
    db.execute("INSERT OR REPLACE INTO canonical_blocks VALUES (?,?,'human_rejection')",(left,right))
    db.execute('INSERT INTO canonical_events(action,after_json,created_at) VALUES (?,?,?)',('human_identity_rejection',canonical.dump(preview),canonical.now()))
    return {'rejected':True}


def undo(db,left,right):
    db.execute('BEGIN IMMEDIATE')
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
    return {'still_connected':any(left in c and right in c for c in components)}


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
        from pathlib import Path
        with sqlite3.connect(get_settings().db_file) as catalog:
            obsolete_id=int(entity_id.split(':')[1])
            audit=catalog.execute("SELECT before_json,after_json FROM audit_log WHERE action='merge_missing_duplicate' AND entity_id=? ORDER BY id DESC LIMIT 1",(obsolete_id,)).fetchone()
            if not audit:raise ValueError('Confirmed dedup deletion evidence is required; missing files are never automatically retired.')
            old=json.loads(audit[0]);decision=json.loads(audit[1])
            if survivor_id!=f"local:{decision['keep']}":raise ValueError('Survivor differs from the recorded dedup decision.')
            if Path(old['absolute_path']).exists():raise ValueError('The obsolete file still exists.')
            survivor=catalog.execute('SELECT absolute_path FROM tracks WHERE id=?',(decision['keep'],)).fetchone()
            if not survivor or not Path(survivor[0]).is_file():raise ValueError('Surviving file is unavailable.')
            if catalog.execute('SELECT 1 FROM tracks WHERE id=?',(obsolete_id,)).fetchone():raise ValueError('Catalog row still exists; retire it explicitly before the historical asset.')
        raw['asset_lifecycle']={'state':'retired','reason':'dedup_deleted','survivor_id':survivor_id,'original_path':old['absolute_path'],'retired_at':canonical.now()}
    db.execute('UPDATE entities SET metadata_json=? WHERE id=?',(canonical.dump(raw),entity_id))
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(row['recording_id'],'restore_asset_visibility' if restore else 'retire_duplicate_asset',canonical.dump(before),canonical.dump(raw),canonical.now()))
    return {'entity_id':entity_id,'retired':not restore,'restores_audio':False}
