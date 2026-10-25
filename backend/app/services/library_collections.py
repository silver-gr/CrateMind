"""Imported collections are immutable; native collections own new membership rows."""
import json
import uuid
from datetime import datetime,timezone
from .provider_resolution import local_asset


def assets(db,recording_ids=None):
    from .identity_library import current_local_predicate
    result={};params=[];where=current_local_predicate()
    if recording_ids is not None:
        params=sorted({rid for rid in recording_ids if rid is not None})
        if not params:return result
        where+=' AND e.recording_id IN ('+','.join('?' for _ in params)+')'
    for row in db.execute('SELECT e.* FROM entities e WHERE '+where,params):
        asset=local_asset(row)
        if asset['current']:result.setdefault(row['recording_id'],[]).append(asset)
    return result


def availability(entries):
    playable=sum(any(a['playable'] for a in e['local_assets']) for e in entries)
    remote=sum(not e['local_assets'] for e in entries)
    return {'positions':len(entries),'playable_local':playable,'remote_only':remote,'local_unavailable':len(entries)-playable-remote}


def collection(db,collection_id):
    row=db.execute('SELECT * FROM collections WHERE id=?',(collection_id,)).fetchone()
    if not row:return None
    result=dict(row);result['provenance']=json.loads(result.pop('provenance_json'));result['editable']=row['kind']=='native'
    from .collection_consolidation import active_rows
    metadata=next((r for r in active_rows(db,collection_ids={collection_id}) if r['id']==collection_id),None)
    if metadata:
        result.update({key:metadata[key] for key in ('aliases','source_services','source_accounts','source_ids')})
    else:
        result.update(aliases=[row['name']],source_services=[row['service']],source_accounts=[str(result['provenance']['account'])] if result['provenance'].get('account') else [],source_ids=[collection_id])
    positions=db.execute('''SELECT m.position,m.entity_id AS id,m.added_at,m.source_json,e.title AS source_title,e.artist AS source_artist,e.service,e.status,e.recording_id,e.permalink,
        c.title,c.artist,c.state AS canonical_state FROM memberships m JOIN entities e ON e.id=m.entity_id
        LEFT JOIN canonical_recordings c ON c.recording_id=e.recording_id WHERE m.collection_id=? ORDER BY m.position''',(collection_id,)).fetchall()
    result['entries']=[];local=assets(db,recording_ids={row['recording_id'] for row in positions})
    for row in positions:
        e=dict(row);e['provenance']=json.loads(e.pop('source_json'));e['local_assets']=local.get(e['recording_id'],[])
        e['availability']='playable_local' if any(a['playable'] for a in e['local_assets']) else 'local_unavailable' if e['local_assets'] else 'remote_only'
        result['entries'].append(e)
    result['availability']=availability(result['entries'])
    return result


def list_collections(db,q='',service='',offset=0,limit=100,all_sources=False,account='',grouped=False):
    local=assets(db);playable={rid for rid,values in local.items() if any(v['playable'] for v in values)}
    remote={r['recording_id'] for r in db.execute("SELECT recording_id FROM entities WHERE id LIKE 'soundcloud:tracks:%' OR id LIKE 'spotify:track:%' OR id LIKE 'spotify:episode:%'")}
    counts={}
    for row in db.execute('SELECT m.collection_id,e.recording_id FROM memberships m JOIN entities e ON e.id=m.entity_id'):
        c=counts.setdefault(row['collection_id'],{'playable_local':0,'remote_only':0,'local_unavailable':0,'unresolved':0})
        rid=row['recording_id'];key='playable_local' if rid in playable else 'local_unavailable' if rid in local else 'remote_only' if rid in remote else 'unresolved';c[key]+=1
    rows=[]
    from .collection_consolidation import active_rows
    for row in active_rows(db,q,service,account,all_sources):
        c=dict(row);provenance=json.loads(c.pop('provenance_json'))
        c['provenance']=provenance;c['editable']=c['kind']=='native';c['availability']=counts.get(c['id'],{'playable_local':0,'remote_only':0,'local_unavailable':0,'unresolved':0});rows.append(c)
    collection_total=len(rows)
    if grouped and not all_sources:
        from .collection_consolidation import review_groups, projection
        overrides=projection(db)['overrides'];by_id={r['id']:r for r in rows};used=set();logical=[]
        for group in review_groups(db,include_hashes=False):
            if group['state']!='needs_review' or set(group['ids'])&overrides:continue
            ids=[cid for cid in group['ids'] if cid in by_id and cid not in used]
            if len(ids)<2:continue
            selected=group['selected'] if group['selected'] in ids else ids[0]
            logical.append({**by_id[selected],'related_variants':[by_id[cid] for cid in ids if cid!=selected],
                            'relationship_kind':group['relationship_kind']})
            used.update(ids)
        logical.extend(r for r in rows if r['id'] not in used)
        order={row['id']:i for i,row in enumerate(rows)}
        rows=sorted(logical,key=lambda r:min(order[cid] for cid in [r['id'],*(v['id'] for v in r.get('related_variants',[]))]))
    return {'items':rows[offset:offset+limit],'total':len(rows),'collection_total':collection_total}


def create(db,name,source_id=None,entity_ids=None,detailed=True):
    name=name.strip()
    if not name or len(name)>200:raise ValueError('Το όνομα πρέπει να έχει 1–200 χαρακτήρες.')
    if source_id and entity_ids:raise ValueError('Choose a source collection or explicit entries')
    rows=[]
    if source_id:
        if not db.execute('SELECT 1 FROM collections WHERE id=?',(source_id,)).fetchone():raise ValueError('Source collection not found')
        rows=[(r['entity_id'],r['added_at'],{'origin_collection':source_id,'origin_position':r['position'],'source_observation':json.loads(r['source_json'])}) for r in db.execute('SELECT * FROM memberships WHERE collection_id=? ORDER BY position',(source_id,))]
    else:
        for entity_id in entity_ids or []:
            if not db.execute('SELECT 1 FROM entities WHERE id=?',(entity_id,)).fetchone():raise ValueError('Unknown entity')
            rows.append((entity_id,None,{'selected_entity':entity_id}))
    cid='cratemind:collection:'+uuid.uuid4().hex
    stamp=datetime.now(timezone.utc).isoformat()
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)',(cid,name,'cratemind','native',len(rows),json.dumps({'created_at':stamp,'origin_collection':source_id,'ownership':'personal','publishing':'local_only'})))
    for pos,(eid,date,provenance) in enumerate(rows):db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)',(cid,pos,eid,date,json.dumps(provenance)))
    return collection(db,cid) if detailed else {'id':cid}


def append(db,cid,entity_ids):
    # Acquire the writer lock before reading the next position; no lost concurrent additions.
    if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
    row=db.execute('SELECT kind FROM collections WHERE id=?',(cid,)).fetchone()
    if not row or row['kind']!='native':raise ValueError('Μόνο οι συλλογές CrateMind μπορούν να αλλάξουν.')
    start=db.execute('SELECT COALESCE(MAX(position)+1,0) FROM memberships WHERE collection_id=?',(cid,)).fetchone()[0]
    for i,eid in enumerate(entity_ids):
        if not db.execute('SELECT 1 FROM entities WHERE id=?',(eid,)).fetchone():raise ValueError('Unknown entity')
        db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)',(cid,start+i,eid,datetime.now(timezone.utc).isoformat(),json.dumps({'selected_entity':eid})))
    db.execute('UPDATE collections SET track_count=(SELECT count(*) FROM memberships WHERE collection_id=?) WHERE id=?',(cid,cid))
    return collection(db,cid)
