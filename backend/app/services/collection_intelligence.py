"""Canonical set operations with stable first-occurrence ordering."""
import json
from . import library_completeness as completeness, library_collections

ORDER = 'Deduplicated by canonical recording. Intersection/difference preserve left order; union uses first occurrence across sources in selected order.'


def positions(db,cid):
    if not db.execute('SELECT 1 FROM collections WHERE id=?',(cid,)).fetchone():raise ValueError('Unknown collection')
    return [dict(r) for r in db.execute('''SELECT m.*,e.recording_id FROM memberships m JOIN entities e ON e.id=m.entity_id
        WHERE collection_id=? ORDER BY position''',(cid,))]


def algebra(db,collection_ids,operation='union',exclude_playable=False,save_name=None):
    if operation not in {'union','intersection','difference'}:raise ValueError('Invalid operation')
    if not collection_ids or len(collection_ids)>20:raise ValueError('Select 1–20 collections')
    groups=[positions(db,cid) for cid in collection_ids]
    sets=[{r['recording_id'] for r in group} for group in groups]
    allowed=set.union(*sets) if operation=='union' else set.intersection(*sets) if operation=='intersection' else sets[0].difference(set().union(*sets[1:]))
    catalog=completeness.index(db, recording_ids=allowed)
    if exclude_playable:allowed={rid for rid in allowed if not catalog[rid]['availability']['playable']}
    origins_by_recording={}
    for group in groups:
        for r in group:origins_by_recording.setdefault(r['recording_id'],[]).append({'collection_id':r['collection_id'],'position':r['position'],'entity_id':r['entity_id']})
    ordered=[];seen=set()
    for group in (groups if operation=='union' else groups[:1]):
        for r in group:
            rid=r['recording_id']
            if rid not in allowed or rid in seen:continue
            seen.add(rid)
            origins=origins_by_recording[rid]
            ordered.append({**catalog[rid],'entity_id':r['entity_id'],'origins':origins})
    overlap=None
    if len(sets)==2:
        shared=len(sets[0]&sets[1]);total=len(sets[0]|sets[1])
        overlap={'shared':shared,'only_left':len(sets[0]-sets[1]),'only_right':len(sets[1]-sets[0]),
                 'jaccard_percent':round(100*shared/total,1) if total else 0,'denominator':'unique canonical union'}
    result={'total':len(ordered),'items':ordered,'order_semantics':ORDER,'overlap':overlap}
    if save_name is not None:
        native=library_collections.create(db,save_name,entity_ids=[r['entity_id'] for r in ordered])
        provenance={'operation':operation,'source_collections':collection_ids,'exclude_playable':exclude_playable,'order_semantics':ORDER}
        db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({**native['provenance'],**provenance}),native['id']))
        for pos,r in enumerate(ordered):db.execute('UPDATE memberships SET source_json=? WHERE collection_id=? AND position=?',(json.dumps({'origins':r['origins'],'operation':operation}),native['id'],pos))
        result['saved_collection_id']=native['id']
    return result


def enrich_collection(db,result):
    if result is None:return None
    catalog=completeness.index(db, recording_ids={e['recording_id'] for e in result['entries']})
    counts={'positions':len(result['entries']),'playable_local':0,'remote_only':0,'local_unavailable':0,'unresolved':0}
    for e in result['entries']:
        v=catalog.get(e['recording_id'])
        if v:
            a=v['availability'];key='playable_local' if a['playable'] else 'local_unavailable' if a['has_local_asset'] else 'remote_only' if a['remote_only'] else 'unresolved'
            e.update(collection_family_count=v['collection_family_count'],raw_collection_occurrences=v['raw_collection_occurrences'],availability=key,canonical_availability=a,collection_count=v['collection_count'],unique_to_collection=v['collection_count']==1,providers=v['providers'])
        else:key='unresolved';e.update(availability=key,collection_count=0,unique_to_collection=False,providers=[])
        counts[key]+=1
    result['availability']=counts
    return result
