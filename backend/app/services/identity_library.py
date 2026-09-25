"""Read the additive CrateMind identity catalog, separate from file-backed tracks."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[2] / 'data' / 'identity.sqlite'


@contextmanager
def connect(path: Path | None = None):
    path = path or Path(os.environ.get('CRATEMIND_IDENTITY_DB_PATH', str(DEFAULT_DB)))
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    try:
        yield db
    finally:
        db.close()


def summary(db):
    row = db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()
    value = json.loads(row[0]) if row else {}
    from .collection_consolidation import active_rows
    value['source_observations']=db.execute('SELECT count(*) FROM entities').fetchone()[0]
    value['active_local_assets']=db.execute("SELECT count(*) FROM entities WHERE service='local' AND COALESCE(json_extract(metadata_json,'$.asset_lifecycle.state'),'')!='retired'").fetchone()[0]
    value['active_recordings']=db.execute("SELECT count(DISTINCT recording_id) FROM entities WHERE COALESCE(json_extract(metadata_json,'$.asset_lifecycle.state'),'')!='retired'").fetchone()[0]
    value['collections'] = len(active_rows(db))
    value['stored_collections'] = db.execute('SELECT count(*) FROM collections').fetchone()[0]
    return value


def item_row(row):
    item = dict(row)
    for key in ('metadata_json', 'normalized_json'):
        if key in item:
            item[key.removesuffix('_json')] = json.loads(item.pop(key))
    return item


def list_items(db, query='', service='', category='', limit=50, offset=0, mode='recordings'):
    from . import canonical_library
    if canonical_library.available(db):
        clauses, args = [], []
        if category=='retired':clauses.append("json_extract(e.metadata_json,'$.asset_lifecycle.state')='retired'");category=''
        elif mode!='sources':clauses.append("COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired'")
        if query:
            clauses.append("(c.title LIKE ? OR c.artist LIKE ? OR e.title LIKE ? OR e.artist LIKE ? OR e.id=? OR EXISTS(SELECT 1 FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id WHERE ra.recording_id=e.recording_id AND a.name LIKE ?))")
            args.extend(['%'+query+'%']*4+[query,'%'+query+'%'])
        if service:clauses.append('e.service=?');args.append(service)
        if category:clauses.append('e.status=?');args.append(category)
        where=' WHERE '+' AND '.join(clauses) if clauses else ''
        base=' FROM entities e JOIN canonical_recordings c ON c.recording_id=e.recording_id'
        total=db.execute(('SELECT count(DISTINCT e.recording_id)' if mode=='recordings' else 'SELECT count(*)')+base+where,args).fetchone()[0]
        rows=db.execute('SELECT e.id,e.service,c.title,c.artist,e.title AS source_title,e.artist AS source_artist,e.duration_ms,e.recording_id,e.status,e.local_track_id,e.permalink'+base+where+(' GROUP BY e.recording_id' if mode=='recordings' else '')+' ORDER BY c.title,e.id LIMIT ? OFFSET ?',[*args,limit,offset])
        return {'total':total,'items':[dict(r) for r in rows]}
    clauses, args = [], []
    if query:
        clauses.append('(title LIKE ? ESCAPE \'\\\' OR artist LIKE ? ESCAPE \'\\\' OR id=?)')
        value = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        args.extend([value, value, query])
    if service:
        clauses.append('service=?'); args.append(service)
    if category:
        clauses.append('status=?'); args.append(category)
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    total = db.execute('SELECT count(*) FROM entities' + where, args).fetchone()[0]
    rows = db.execute('SELECT id,service,title,artist,duration_ms,recording_id,status,local_track_id,permalink FROM entities' + where + ' ORDER BY title,id LIMIT ? OFFSET ?', [*args, limit, offset]).fetchall()
    return {'total': total, 'items': [dict(r) for r in rows]}


def detail(db, entity_id, candidate_id=""):
    row = db.execute('SELECT * FROM entities WHERE id=?', (entity_id,)).fetchone()
    if row is None:
        return None
    item = item_row(row)
    siblings = db.execute('SELECT id,service,title,artist,local_track_id,permalink,status,json_extract(metadata_json,"$.missing") AS missing FROM entities WHERE recording_id=? ORDER BY service,id', (item['recording_id'],)).fetchall()
    candidates = db.execute('''SELECT c.*, e.id AS other_id,e.title AS other_title,e.artist AS other_artist,e.service AS other_service
        FROM candidates c JOIN entities e ON e.id=CASE WHEN c.left_id=? THEN c.right_id ELSE c.left_id END
        WHERE c.left_id=? OR c.right_id=? ORDER BY CASE WHEN e.id=? THEN 0 ELSE 1 END,CASE c.class WHEN 'ACCEPTED' THEN 0 WHEN 'HIGH_CONFIDENCE' THEN 1 WHEN 'PROBABLE' THEN 2 WHEN 'AMBIGUOUS' THEN 3 ELSE 4 END,c.score DESC LIMIT 100''', (entity_id, entity_id, entity_id, candidate_id)).fetchall()
    memberships = db.execute('''SELECT c.id,c.name,c.service,c.kind,m.position,m.added_at FROM memberships m
        JOIN collections c ON c.id=m.collection_id WHERE m.entity_id=? ORDER BY c.name,m.position''', (entity_id,)).fetchall()
    from .provider_resolution import local_asset
    item['representations'] = []
    for r in siblings:
        representation=dict(r)
        if r['service']=='local':
            entity=db.execute('SELECT * FROM entities WHERE id=?',(r['id'],)).fetchone()
            representation.update(local_asset(entity))
        item['representations'].append(representation)
    if item['service']=='local':item['asset']=local_asset(row)
    item['candidates'] = [{**dict(r), 'evidence': json.loads(r['evidence_json'])} for r in candidates]
    for r in item['candidates']:
        del r['evidence_json']
    item['candidates']=[c for c in item['candidates'] if not json.loads(db.execute('SELECT metadata_json FROM entities WHERE id=?',(c['other_id'],)).fetchone()[0]).get('asset_lifecycle',{}).get('state')=='retired']
    from .collection_consolidation import memberships as active_memberships
    item['source_memberships'] = [dict(r) for r in memberships]
    item['memberships'] = active_memberships(db,item['recording_id'])
    from . import canonical_library
    if canonical_library.available(db):
        item['canonical'] = canonical_library.detail(db, item['recording_id'])
        for candidate in item['candidates']:
            acceptance = db.execute('SELECT acceptance_mode,accepted_at,method,confidence FROM identity_acceptances WHERE left_id=? AND right_id=? AND revoked_at IS NULL', (candidate['left_id'], candidate['right_id'])).fetchone()
            if acceptance:
                candidate['original_class'] = candidate['class']
                candidate['class'] = 'ACCEPTED'
                candidate['acceptance'] = dict(acceptance)
    return item


def collections(db):
    from .collection_consolidation import active_rows
    return [{k:r[k] for k in ('id','name','service','kind','track_count','aliases','source_services','source_accounts')} for r in active_rows(db)]


def collection(db, collection_id):
    from . import canonical_library
    if canonical_library.available(db):
        from .library_collections import collection as canonical_collection
        return canonical_collection(db, collection_id)
    # Legacy staging catalog support before canonical initialization.
    row = db.execute('SELECT * FROM collections WHERE id=?', (collection_id,)).fetchone()
    if not row:return None
    result=dict(row);result['provenance']=json.loads(result.pop('provenance_json'));result['entries']=[]
    for row in db.execute('SELECT m.position,m.added_at,e.* FROM memberships m JOIN entities e ON e.id=m.entity_id WHERE m.collection_id=? ORDER BY position',(collection_id,)):
        e=dict(row)
        e['local_assets']=[dict(a) for a in db.execute('SELECT id,local_track_id,title,json_extract(metadata_json,"$.missing") AS missing FROM entities WHERE recording_id=? AND service="local"',(e['recording_id'],))]
        result['entries'].append(e)
    return result
