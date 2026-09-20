"""Derived recording availability and personal recovery decisions. No acquisition I/O."""
import json
import re
import shlex
from datetime import datetime, timezone
from . import provider_resolution as providers

RECOVERY_SCHEMA = '''CREATE TABLE IF NOT EXISTS recording_recovery(
 recording_id TEXT PRIMARY KEY REFERENCES canonical_recordings(recording_id),
 state TEXT NOT NULL CHECK(state IN ('wanted','acquired','skipped','unavailable')),
 updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_events(
 id INTEGER PRIMARY KEY,recording_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);'''


def derive(local, remote):
    playable = any(a['playable'] for a in local)
    services = {p['service'] for p in remote if p['id'].startswith(('soundcloud:tracks:', 'spotify:track:', 'spotify:episode:'))}
    if playable: state = 'LOCAL_AND_REMOTE' if services else 'LOCAL_PLAYABLE'
    elif local: state = 'LOCAL_MISSING_FILE'
    elif services == {'soundcloud','spotify'}: state = 'REMOTE_ONLY_BOTH'
    elif services == {'soundcloud'}: state = 'REMOTE_ONLY_SOUNDCLOUD'
    elif services == {'spotify'}: state = 'REMOTE_ONLY_SPOTIFY'
    else: state = 'REMOTE_UNRESOLVED'
    return {'state':state,'playable':playable,'has_local_asset':bool(local),
            'missing_file':bool(local) and not playable,'remote_only':not local and bool(services),
            'unresolved':not local and not services,'providers':sorted(services),
            'local_association':'accepted' if local else 'none_accepted',
            'verified_recorded_paths_absent':bool(local) and all(a.get('file_evidence',{}).get('verified_path_absent',False) for a in local),
            'file_diagnostic_states':sorted({a.get('file_evidence',{}).get('state','unknown') for a in local})}


def index(db):
    """One bounded bulk projection. Filesystem existence is checked on each request."""
    result={}
    for r in db.execute('SELECT recording_id,title,artist FROM canonical_recordings'):
        result[r['recording_id']]={**dict(r),'local_assets':[],'providers':[],'collections':{},'likes':[], 'recovery_state':None,'credits':[]}
    for r in db.execute('SELECT * FROM entities ORDER BY id'):
        v=result.get(r['recording_id'])
        if v is None:continue
        if r['service']=='local':v['local_assets'].append(providers.local_asset(r))
        elif r['service'] in {'soundcloud','spotify'}:
            p=providers.source(r)
            v['providers'].append(p)
    for r in db.execute('SELECT ra.recording_id,a.name FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id'):
        if r['recording_id'] in result:result[r['recording_id']]['credits'].append(r['name'])
    collections={}
    for r in db.execute('SELECT id,name,service,kind,provenance_json FROM collections'):
        c=dict(r);provenance=json.loads(c.pop('provenance_json'));c['provenance']={k:provenance[k] for k in ('account','relationships','origin_collection') if k in provenance};collections[c['id']]=c
    for r in db.execute('SELECT DISTINCT e.recording_id,m.collection_id FROM memberships m JOIN entities e ON e.id=m.entity_id'):
        v=result.get(r['recording_id'])
        if v is None:continue
        c=collections[r['collection_id']]
        v['collections'][c['id']]=c
        if c['kind']=='likes':v['likes'].append(c)
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='recording_recovery'").fetchone():
        for r in db.execute('SELECT * FROM recording_recovery'):
            if r['recording_id'] in result:result[r['recording_id']]['recovery_state']=r['state']
    for v in result.values():
        v['availability']=derive(v['local_assets'],v['providers'])
        v['collection_count']=len(v['collections'])
        v['soundcloud_like']=any(c['service']=='soundcloud' for c in v['likes'])
        v['spotify_like']=any(c['service']=='spotify' for c in v['likes'])
        v['saved_playlist']=any(set(c['provenance'].get('relationships') or []) & {'saved','liked','liked/saved','saved_playlist_ownership_unknown'} for c in v['collections'].values())
    from .collection_lineage import decorate_counts
    decorate_counts(db,result)
    from .collection_consolidation import projection
    presentation=projection(db)
    for v in result.values():
        v['source_collections']=dict(v['collections'])
        v['collections']={cid:c for cid,c in v['collections'].items() if cid not in presentation['hidden']}
        v['active_collection_count']=len(v['collections'])
    return result


def numeric(value, expression):
    if not re.fullmatch(r'\d+\+?', expression):return False
    return value>=int(expression[:-1]) if expression.endswith('+') else value==int(expression)


def token_matches(row, token):
    """Shared concepts consumed by the existing DJ search parser and catalog UI."""
    if token in {'remote_only','local_playable','missing_file','soundcloud_like','spotify_like'}:
        return {'remote_only':row['availability']['remote_only'],'local_playable':row['availability']['playable'],
                'missing_file':row['availability']['missing_file'],'soundcloud_like':row['soundcloud_like'],'spotify_like':row['spotify_like']}[token]
    if token.startswith('collections:'):return numeric(row['collection_count'],token.partition(':')[2])
    return None


def matches(row, q):
    try:tokens=shlex.split(q)
    except ValueError:tokens=q.split()
    text=' '.join([row['title'] or '',row['artist'] or '',*row['credits']]).casefold()
    for t in tokens:
        neg=t.startswith('-');body=t[1:] if neg else t
        hit=token_matches(row,body)
        if hit is None:hit=body.removeprefix('artist:').casefold() in text
        if hit==neg:return False
    return True


def metrics(rows):
    values=list(rows.values())
    return {'known_recordings':len(values),'locally_playable':sum(v['availability']['playable'] for v in values),
            'local_missing_files':sum(v['availability']['missing_file'] for v in values),
            'remote_only':sum(v['availability']['remote_only'] for v in values),
            'unresolved':sum(v['availability']['unresolved'] for v in values),
            'soundcloud_likes_not_local':sum(v['soundcloud_like'] and not v['availability']['playable'] for v in values),
            'spotify_likes_not_local':sum(v['spotify_like'] and not v['availability']['playable'] for v in values),
            'in_recovery_queue':sum(v['recovery_state']=='wanted' and not v['availability']['playable'] for v in values)}


def browse(db,q='',scope='missing',provider='',account='',collection='',minimum=0,state='',origin='',saved=False,offset=0,availability='',limit=50,catalog=None):
    rows=catalog if catalog is not None else index(db);items=[]
    accounts=sorted({str(c['provenance'].get('account')) for v in rows.values() for c in v['likes'] if c['service']=='spotify' and c['provenance'].get('account')})
    from .collection_consolidation import projection
    collection_targets=projection(db)['mapping'].get(collection,{collection}) if collection else set()
    for v in rows.values():
        a=v['availability']
        if scope=='missing' and (a['playable'] or a['unresolved']):continue
        if scope=='playable' and not a['playable']:continue
        if scope=='unresolved' and not a['unresolved']:continue
        if availability and a['state']!=availability:continue
        if provider and provider not in a['providers']:continue
        if account and not any(c['service']=='spotify' and str(c['provenance'].get('account'))==account for c in v['likes']):continue
        if collection and not collection_targets.intersection(v['collections']):continue
        if v['collection_count']<minimum or (state and v['recovery_state']!=state):continue
        if origin=='missing_file' and not a['missing_file']:continue
        if origin=='never_local' and a['has_local_asset']:continue
        if saved and not v['saved_playlist']:continue
        if not matches(v,q):continue
        items.append(v)
    items.sort(key=lambda v:(-v['collection_count'],(v['artist'] or '').casefold(),v['recording_id']))
    return {'items':items[offset:] if limit is None else items[offset:offset+limit],'total':len(items),'metrics':metrics(rows),'spotify_accounts':accounts}


def recover(db,rid,state):
    if not db.execute('SELECT 1 FROM canonical_recordings WHERE recording_id=?',(rid,)).fetchone():raise ValueError('Unknown recording')
    if state not in {'wanted','acquired','skipped','unavailable'}:raise ValueError('Invalid recovery state')
    for statement in RECOVERY_SCHEMA.split(';'):
        if statement.strip():db.execute(statement)
    stamp=datetime.now(timezone.utc).isoformat()
    db.execute('INSERT INTO recording_recovery VALUES (?,?,?) ON CONFLICT(recording_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at',(rid,state,stamp))
    db.execute('INSERT INTO recovery_events(recording_id,state,created_at) VALUES (?,?,?)',(rid,state,stamp))
    return {'recording_id':rid,'state':state,'availability_changed':False}


def local_search_ids(session,token):
    from . import canonical_library,identity_library
    if not canonical_library.catalog_session_matches(session):return []
    with identity_library.connect() as db:
        return [a['local_track_id'] for v in index(db).values() if token_matches(v,token) for a in v['local_assets']]
