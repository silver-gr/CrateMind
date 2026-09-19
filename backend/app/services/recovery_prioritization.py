"""Explicit intent and transparent recommendation presets; no acquisition side effects."""
import json
import sqlite3
from collections import Counter
from urllib.parse import urlencode
from pathlib import Path
from . import library_completeness as completeness,library_collections

PRESETS={'wanted','favourites','cross_provider','strong_interest','lost_files','discovery'}
SORTS={'families','raw_collections','wanted','soundcloud_plays','soundcloud_likes','artist'}


def qualifies(v,preset,minimum_families):
    a=v['availability']
    if preset=='wanted':return v['recovery_state']=='wanted' and not a['playable']
    if preset=='favourites':return (v['soundcloud_like'] or v['spotify_like']) and not a['playable']
    if preset=='cross_provider':return v['soundcloud_like'] and v['spotify_like'] and not a['playable']
    if preset=='strong_interest':return a['remote_only'] and v['collection_family_count']>=minimum_families
    if preset=='lost_files':return a['missing_file']
    return True


def dj_statuses(db,catalog):
    from .identity_library import DEFAULT_DB
    filename=db.execute('PRAGMA database_list').fetchone()[2]
    if not filename or Path(filename).resolve()!=DEFAULT_DB.resolve():return
    # Read only the primary catalog paired with this identity snapshot.
    path=DEFAULT_DB.parent/'cratemind.sqlite'
    if not path.is_file():return
    try:
        with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True) as local:
            statuses=dict(local.execute('SELECT track_id,personal_status FROM track_dj_profile'))
        for v in catalog.values():v['dj_personal_statuses']=sorted({statuses[a['local_track_id']] for a in v['local_assets'] if statuses.get(a['local_track_id'])})
    except sqlite3.OperationalError:return


def local_candidates(db,items):
    """Read frozen candidate evidence; no rescoring, acceptance, or asset attachment."""
    targets={v['recording_id']:v for v in items if v['availability']['remote_only']}
    if not targets:return
    active={frozenset((r['left_id'],r['right_id'])) for r in db.execute('SELECT left_id,right_id FROM identity_acceptances WHERE revoked_at IS NULL')}
    revoked={frozenset((r['left_id'],r['right_id'])) for r in db.execute('SELECT left_id,right_id FROM identity_acceptances WHERE revoked_at IS NOT NULL')}
    blocks={frozenset((r['left_id'],r['right_id'])):r['reason'] for r in db.execute('SELECT * FROM canonical_blocks')}
    evidence={rid:[] for rid in targets}
    for r in db.execute("""SELECT c.*,a.id AS local_entity_id,a.local_track_id,a.title AS local_title,a.artist AS local_artist,
            b.id AS provider_entity_id,b.recording_id FROM candidates c
            JOIN entities a ON (a.id=c.left_id OR a.id=c.right_id) AND a.service='local'
            JOIN entities b ON b.id=CASE WHEN a.id=c.left_id THEN c.right_id ELSE c.left_id END
            WHERE b.service!='local' AND a.recording_id!=b.recording_id"""):
        rid=r['recording_id'];pair=frozenset((r['left_id'],r['right_id']))
        if rid not in targets or pair in active:continue
        e=json.loads(r['evidence_json']);block=blocks.get(pair)
        guarded=r['class']=='CONFLICT' or bool(e.get('conflicts')) or pair in revoked or bool(block and block not in {'insufficient_independent_evidence','hard_guard_or_near_tie'})
        evidence[rid].append({'local_entity_id':r['local_entity_id'],'local_track_id':r['local_track_id'],
            'title':r['local_title'],'artist':r['local_artist'],'provider_entity_id':r['provider_entity_id'],
            'class':r['class'],'score':r['score'],'guarded':guarded,'block_reason':block,'revoked':pair in revoked,
            'review_url':'/unified?'+urlencode({'id':r['provider_entity_id'],'candidate':r['local_entity_id']})})
    for rid,v in targets.items():
        rows=evidence[rid]
        plausible={r['local_entity_id'] for r in rows if not r['guarded'] and r['class'] in {'HIGH_CONFIDENCE','PROBABLE'}}
        ambiguous={r['local_entity_id'] for r in rows if not r['guarded'] and r['class']=='AMBIGUOUS'}-plausible
        ranked=sorted(rows,key=lambda r:(r['guarded'],{'HIGH_CONFIDENCE':0,'PROBABLE':1,'AMBIGUOUS':2}.get(r['class'],3),-r['score']))
        v['local_candidate_evidence']={'plausible_local_files':len(plausible),'ambiguous_local_files':len(ambiguous),
            'candidate_pairs':len(rows),'guarded_pairs':sum(r['guarded'] for r in rows),'items':ranked[:5],
            'basis':'Existing HIGH_CONFIDENCE/PROBABLE proposals without recorded hard contradictions; AMBIGUOUS shown separately. Not accepted associations.'}


def view(db,preset='wanted',minimum_families=3,sort='families',offset=0,filters=None,save_name=None):
    if preset not in PRESETS or sort not in SORTS:raise ValueError('Invalid recovery preset or sort')
    catalog=completeness.index(db)
    dj_statuses(db,catalog)
    # Reuse the existing catalog predicates, with no pagination until the final ordering.
    args={**(filters or {}),'scope':(filters or {}).get('scope','all'),'offset':0,'limit':None,'catalog':catalog}
    result=completeness.browse(db,**args)
    values=[v for v in result['items'] if qualifies(v,preset,minimum_families)]
    def counters(v,key):
        stats=[p['popularity'].get(key) for p in v['providers'] if p['service']=='soundcloud' and isinstance(p['popularity'],dict)]
        values=[x for x in stats if isinstance(x,(int,float))]
        return min(values) if values else None
    def order(v):
        if sort=='families':key=-v['collection_family_count']
        elif sort=='raw_collections':key=-v['collection_count']
        elif sort=='wanted':key=0 if v['recovery_state']=='wanted' else 1
        elif sort in {'soundcloud_plays','soundcloud_likes'}:
            value=counters(v,'playback_count' if sort=='soundcloud_plays' else 'likes_count');key=(value is None,value or 0)
        else:key=(v['artist'] or '').casefold()
        return key,(v['artist'] or '').casefold(),v['recording_id']
    values.sort(key=order)
    local_candidates(db,values[offset:offset+50])
    result.update(items=values[offset:offset+50],total=len(values),preset=preset,
                  intent='explicit_wanted' if preset=='wanted' else 'catalog_discovery' if preset=='discovery' else 'recommendation_only',
                  sort_basis=sort,minimum_families=minimum_families)
    if save_name is not None:
        # Explicitly saving a query snapshots its current results, without setting any wanted states.
        representatives={}
        for r in db.execute('SELECT id,recording_id FROM entities ORDER BY id'):representatives.setdefault(r['recording_id'],r['id'])
        collection=library_collections.create(db,save_name,entity_ids=[representatives[v['recording_id']] for v in values])
        provenance={**collection['provenance'],'recovery_query':{'preset':preset,'minimum_families':minimum_families,'sort':sort,'filters':filters or {}},'acquisition_intent':'not_implied','snapshot':True}
        db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps(provenance),collection['id']))
        origins={}
        for r in db.execute('SELECT e.recording_id,m.collection_id,m.position,m.entity_id FROM memberships m JOIN entities e ON e.id=m.entity_id WHERE m.collection_id!=?',(collection['id'],)):
            origins.setdefault(r['recording_id'],[]).append({'collection_id':r['collection_id'],'position':r['position'],'entity_id':r['entity_id']})
        for position,v in enumerate(values):
            db.execute('UPDATE memberships SET source_json=? WHERE collection_id=? AND position=?',(json.dumps({'origins':origins.get(v['recording_id'],[]),'recovery_query_snapshot':True}),collection['id'],position))
        result['saved_collection_id']=collection['id']
    return result
