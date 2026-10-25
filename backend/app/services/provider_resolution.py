"""Canonical provider read model shared by Library, cards, review and collections."""
from __future__ import annotations
import json
import sqlite3
import errno
import os
import stat
from collections import deque
from pathlib import Path


def source(entity):
    e=dict(entity);raw=json.loads(e['metadata_json']);n=json.loads(e['normalized_json'])
    snapshot=raw.get('normalized_metadata') or {}
    original=raw.get('raw_metadata') or {}
    stats=raw.get('popularity') or {}
    sc=None
    if e['service']=='soundcloud':
        sc={**original,**snapshot,**stats,'soundcloud_track_id':int(e['id'].rsplit(':',1)[1]) if e['id'].rsplit(':',1)[1].isdigit() else None,
            'urn':e['id'],'title':e['title'],'permalink_url':e['permalink'],
            'uploader_username':snapshot.get('uploader_username') or raw.get('uploader'),
            'duration_ms':e['duration_ms'],'available':raw.get('availability')=='available',
            'fetched_at':raw.get('popularity_observed_at')}
    popularity=stats
    if e['service']=='spotify':
        popularity=[{'value':o.get('raw_metadata',{}).get('Popularity',o.get('raw_metadata',{}).get('Δημοτικότητα')),'archive':o.get('archive_sha256')} for o in raw.get('source_observations',[])]
    return {'id':e['id'],'recording_id':e['recording_id'],'service':e['service'],'url':e['permalink'],
            'artist':e['artist'],'title':e['title'],'release':n.get('album'),'popularity':popularity,
            'availability_observation':raw.get('availability','unknown'),'counter_source_id':e['id'],'soundcloud_snapshot':sc,'source_kind':e['service']+'_source'}


def file_evidence(path, root=None):
    """Diagnose the recorded path only; never infer that the audio exists nowhere."""
    if not path:return {'state':'unknown_no_path','verified_path_absent':False}
    path=Path(path)
    try:
        info=path.stat()
        if not stat.S_ISREG(info.st_mode):return {'state':'not_regular_file','verified_path_absent':False}
        if not os.access(path,os.R_OK):return {'state':'permission_denied','verified_path_absent':False}
        return {'state':'present','verified_path_absent':False}
    except OSError as error:
        if root:
            try:
                root_path=Path(root)
                if not stat.S_ISDIR(root_path.stat().st_mode):return {'state':'root_unavailable','verified_path_absent':False,'errno':error.errno}
                with os.scandir(root_path):pass
                if root_path.parent==Path('/Volumes') and not os.path.ismount(root_path):
                    return {'state':'root_unmounted','verified_path_absent':False,'errno':error.errno}
            except PermissionError:return {'state':'root_permission_denied','verified_path_absent':False,'errno':error.errno}
            except OSError:return {'state':'root_unavailable','verified_path_absent':False,'errno':error.errno}
        if error.errno in {errno.EACCES,errno.EPERM}:return {'state':'permission_denied','verified_path_absent':False,'errno':error.errno}
        if error.errno==errno.ENOENT:
            try:
                with os.scandir(path.parent):pass
                return {'state':'recorded_path_absent','verified_path_absent':True,'errno':error.errno}
            except FileNotFoundError:return {'state':'parent_path_absent','verified_path_absent':True,'errno':error.errno}
            except PermissionError:return {'state':'parent_permission_denied','verified_path_absent':False,'errno':error.errno}
            except OSError:return {'state':'unknown','verified_path_absent':False,'errno':error.errno}
        return {'state':'unknown','verified_path_absent':False,'errno':error.errno}


def local_asset(entity, check_files=True):
    e=dict(entity);raw=json.loads(e['metadata_json']);path=raw.get('absolute_path') or raw.get('file_path')
    lifecycle=raw.get('asset_lifecycle',{})
    retired=lifecycle.get('state')=='retired'
    current=bool(raw.get('catalog_current',e['id']==f"local:{e['local_track_id']}")) and not retired
    if raw.get('replaced_missing_catalog_id') is not None:
        path=raw.get('previous_absolute_path') or path
    flagged=bool(raw.get('missing')) or retired
    evidence=file_evidence(path,raw.get('volume_root')) if check_files else {'state':'not_checked','verified_path_absent':False}
    missing=flagged or (check_files and evidence['state']!='present')
    return {'id':e['id'],'recording_id':e['recording_id'],'local_track_id':e['local_track_id'],
            'title':e['title'],'artist':e['artist'],'missing':missing,'catalog_missing_flag':flagged,'file_evidence':evidence,
            'retired':retired,'current':current,'lifecycle':lifecycle,'path':str(path) if path else None,'playable':current and not missing and bool(path), 'availability_basis':'filesystem_and_catalog' if check_files else 'catalog',
            'audio_url':f"/api/tracks/{e['local_track_id']}/audio" if current and not missing and path else None}


def accepted_path(edges,start,target):
    adjacency={}
    for e in edges:
        if e.get('revoked_at'):continue
        adjacency.setdefault(e['left_id'],[]).append((e['right_id'],e))
        adjacency.setdefault(e['right_id'],[]).append((e['left_id'],e))
    queue=deque([(start,[])]);seen={start}
    while queue:
        node,path=queue.popleft()
        if node==target:return path
        for nxt,edge in adjacency.get(node,[]):
            if nxt not in seen:seen.add(nxt);queue.append((nxt,path+[edge]))
    return []


def recording(db,rid):
    entities=[dict(r) for r in db.execute('SELECT * FROM entities WHERE recording_id=? ORDER BY id',(rid,))]
    memberships=[dict(r) for r in db.execute('''SELECT c.id,c.name,c.service,c.kind,c.provenance_json,m.position,m.entity_id
        FROM memberships m JOIN collections c ON c.id=m.collection_id JOIN entities e ON e.id=m.entity_id
        WHERE e.recording_id=? ORDER BY c.name,m.position''',(rid,))]
    for m in memberships:m['provenance']=json.loads(m.pop('provenance_json'))
    edges=[dict(r) for r in db.execute('SELECT a.* FROM identity_acceptances a JOIN entities e ON e.id=a.left_id WHERE e.recording_id=?',(rid,))]
    providers=[];assets=[]
    for e in entities:
        if e['service']=='local':assets.append(local_asset(e))
        p=source(e);p['collections']=[m for m in memberships if m['entity_id']==e['id']]
        p['liked_in']=[m for m in p['collections'] if m['kind']=='likes']
        if p['soundcloud_snapshot']:
            p['soundcloud_snapshot']['liked_by_me']=bool(p['liked_in'])
        providers.append(p)
    from .library_completeness import derive
    from .collection_consolidation import memberships as active_memberships, projection
    active=active_memberships(db,rid);mapping=projection(db)['mapping']
    for provider in providers:
        provider['source_collections']=provider['collections']
        targets=set().union(*(mapping.get(m['id'],{m['id']}) for m in provider['source_collections'])) if provider['source_collections'] else set()
        provider['collections']=[m for m in active if m['id'] in targets]
    return {'recording_id':rid,'providers':providers,'local_assets':assets,'source_collection_memberships':memberships,'collection_memberships':active,'acceptances':edges,
            'availability':derive(assets,[p for p in providers if p['service'] in {'soundcloud','spotify'}])}


def soundcloud_card(bundle,local_id,source_id=None):
    providers=[p for p in bundle['providers'] if p['service']=='soundcloud']
    if not providers:return None
    p=providers[0]  # stable identity order; same choice as bulk Library counters
    path=accepted_path(bundle['acceptances'],source_id or f'local:{local_id}',p['id'])
    return {'track':p['soundcloud_snapshot'],'match':{'track_id':local_id,'soundcloud_track_id':p['soundcloud_snapshot']['soundcloud_track_id'],
            'confidence':min((e['confidence'] for e in path),default=0), 'method':'canonical_recording',
            'reasons':['Σύνδεση μέσω κανονικής ταυτότητας CrateMind']+[f"{e['left_id']} ↔ {e['right_id']} · {e['acceptance_mode']}" for e in path],
            'confirmed_at':max((e['accepted_at'] for e in path),default=None)},
            'recording_id':bundle['recording_id'],'counter_source_id':p['id'],'accepted_path':path}


def track_detail(session,track_id,legacy):
    from . import canonical_library,identity_library
    if not canonical_library.catalog_session_matches(session):return legacy
    try:
        with identity_library.connect() as db:
            if not canonical_library.available(db):return legacy
            e=identity_library.current_local_entity(db,track_id)
            if not e:return legacy
            canonical=canonical_library.detail(db,e['recording_id'])
            return {**legacy,'legacy_soundcloud':legacy.get('soundcloud'),
                    'soundcloud':soundcloud_card(canonical,track_id,e['id']), 'canonical':canonical}
    except sqlite3.OperationalError:return legacy


def bulk_soundcloud(db, recording_ids=None):
    result={}
    if recording_ids is not None and not recording_ids:return result
    scope='' if recording_ids is None else ' AND recording_id IN (SELECT value FROM json_each(?))'
    args=() if recording_ids is None else (json.dumps(sorted(set(recording_ids))),)
    # The list overlay needs only one deterministic provider and its counters.
    # Do not deserialize full normalized metadata/evidence for every provider.
    for r in db.execute('SELECT id,recording_id,json_extract(metadata_json,"$.popularity") AS popularity FROM entities WHERE service="soundcloud"'+scope+' ORDER BY id',args):
        if r['recording_id'] not in result:
            result[r['recording_id']]={'id':r['id'],'popularity':json.loads(r['popularity'] or '{}')}
    return result


def summary(session,legacy):
    from . import canonical_library,identity_library
    if not canonical_library.catalog_session_matches(session):return legacy
    try:
        with identity_library.connect() as db:
            if not canonical_library.available(db):return legacy
            value={**legacy,'legacy_confirmed_local_tracks':legacy['confirmed_local_tracks'],'resolution_basis':'canonical_recording'}
            value['snapshots']=db.execute('SELECT count(*) FROM entities WHERE service="soundcloud"').fetchone()[0]
            value['available']=db.execute("SELECT count(*) FROM entities WHERE service='soundcloud' AND json_extract(metadata_json,'$.availability')='available'").fetchone()[0]
            value['unavailable']=value['snapshots']-value['available']
            current=identity_library.current_local_predicate('e')
            value['confirmed_local_tracks']=db.execute("SELECT count(*) FROM entities e WHERE "+current+" AND EXISTS(SELECT 1 FROM entities s WHERE s.recording_id=e.recording_id AND s.service='soundcloud')").fetchone()[0]
            value['unmatched_soundcloud_tracks']=db.execute("SELECT count(*) FROM entities s WHERE service='soundcloud' AND json_extract(metadata_json,'$.availability')='available' AND NOT EXISTS(SELECT 1 FROM entities e WHERE e.recording_id=s.recording_id AND "+current+")").fetchone()[0]
            return value
    except sqlite3.OperationalError:return legacy
