"""Read the additive CrateMind identity catalog, separate from file-backed tracks."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[2] / 'data' / 'identity.sqlite'


def database_path(catalog_path: Path | str | None = None) -> Path:
    """Pair an identity projection with its catalog; never fall back to another library."""
    from ..config import get_settings
    settings = get_settings()
    if settings.dataset_root:
        from .active_dataset import resolve_active_dataset
        active = resolve_active_dataset(settings.dataset_root)
        # A missing partner has a deterministic path inside THIS generation.
        # Never consult the previous generation or a legacy environment value.
        return active.identity_path or active.generation_dir / "identity.absent.sqlite"
    explicit = os.environ.get('CRATEMIND_IDENTITY_DB_PATH')
    if explicit:
        return Path(explicit).expanduser().resolve()
    if catalog_path is None:
        catalog_path = get_settings().db_file
    return Path(catalog_path).expanduser().resolve().with_name('identity.sqlite')


def current_local_predicate(alias='e'):
    # Legacy redirects may retain another track's local_track_id. Only an exact
    # historical pointer, or a deliberately refreshed pointer, is current.
    return (f"{alias}.service='local' AND "
            f"COALESCE(json_extract({alias}.metadata_json,'$.asset_lifecycle.state'),'')!='retired' AND "
            f"(json_extract({alias}.metadata_json,'$.catalog_current')=1 OR "
            f"(json_type({alias}.metadata_json,'$.catalog_current') IS NULL AND "
            f"{alias}.id='local:'||{alias}.local_track_id))")


def current_local_entity(db, track_id, absolute_path=None):
    rows = db.execute('SELECT e.* FROM entities e WHERE e.local_track_id=? AND ' +
                      current_local_predicate(), (track_id,)).fetchall()
    if absolute_path is not None:
        rows = [r for r in rows if json.loads(r['metadata_json']).get('absolute_path') == str(absolute_path)]
    if len(rows) > 1:
        raise ValueError(f'Multiple current identity observations for local track {track_id}')
    return rows[0] if rows else None


@contextmanager
def connect(path: Path | None = None):
    path = Path(path) if path is not None else database_path()
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
    value['active_local_assets']=db.execute('SELECT count(*) FROM entities e WHERE '+current_local_predicate()).fetchone()[0]
    value['active_recordings']=db.execute("SELECT count(DISTINCT recording_id) FROM entities WHERE COALESCE(json_extract(metadata_json,'$.asset_lifecycle.state'),'')!='retired'").fetchone()[0]
    value['collections'] = len(active_rows(db))
    value['stored_collections'] = db.execute('SELECT count(*) FROM collections').fetchone()[0]
    from collections import Counter, defaultdict
    rows = db.execute("SELECT e.id,e.service,e.recording_id,e.status,e.local_track_id,e.metadata_json FROM entities e WHERE "
                      "(e.service!='local' AND COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired') OR (" + current_local_predicate() + ')').fetchall()
    services = defaultdict(set)
    for r in rows:
        services[r['recording_id']].add(r['service'])
    coverage = {}
    for service in ('local', 'spotify', 'soundcloud'):
        counts = Counter(total=0)
        for r in rows:
            if r['service'] != service or service == 'spotify' and not r['id'].startswith('spotify:track:'):
                continue
            others = services[r['recording_id']] - {service}
            counts['total'] += 1
            counts['status_' + r['status']] += 1
            for other in {'local', 'spotify', 'soundcloud'} - {service}:
                counts['resolved_to_' + other] += other in others
            counts['resolved_to_both'] += len(others) == 2
            counts['no_accepted_cross_source_link'] += not others
        coverage[service] = dict(counts)
    value['coverage'] = coverage
    value['entities'] = value['source_observations']
    value['active_recordings'] = len(services)
    classes = Counter()
    by_pair = defaultdict(Counter)
    current_ids = {r['id'] for r in rows}
    for candidate in db.execute('SELECT left_id,right_id,pair_type,class FROM candidates'):
        if candidate['left_id'] in current_ids and candidate['right_id'] in current_ids:
            classes[candidate['class']] += 1
            by_pair[candidate['pair_type']][candidate['class']] += 1
    value['candidate_pairs'] = sum(classes.values())
    value['classes'] = dict(classes)
    value['by_pair'] = {pair:dict(counts) for pair,counts in by_pair.items()}
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
        elif mode!='sources':clauses.append("((e.service!='local' AND COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired') OR ("+current_local_predicate()+'))')
        if query:
            clauses.append("(c.title LIKE ? OR c.artist LIKE ? OR e.title LIKE ? OR e.artist LIKE ? OR e.id=? OR EXISTS(SELECT 1 FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id WHERE ra.recording_id=e.recording_id AND a.name LIKE ?))")
            args.extend(['%'+query+'%']*4+[query,'%'+query+'%'])
        if service:clauses.append('e.service=?');args.append(service)
        if category:clauses.append('e.status=?');args.append(category)
        where=' WHERE '+' AND '.join(clauses) if clauses else ''
        base=' FROM entities e JOIN canonical_recordings c ON c.recording_id=e.recording_id'
        total=db.execute(('SELECT count(DISTINCT e.recording_id)' if mode=='recordings' else 'SELECT count(*)')+base+where,args).fetchone()[0]
        rows=db.execute('SELECT e.id,e.service,c.title,c.artist,e.title AS source_title,e.artist AS source_artist,e.duration_ms,e.recording_id,e.status,e.local_track_id,e.permalink'+base+where+(' GROUP BY e.recording_id' if mode=='recordings' else '')+' ORDER BY (trim(coalesce(c.title,""))=""),c.title,e.id LIMIT ? OFFSET ?',[*args,limit,offset])
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
    rows = db.execute('SELECT id,service,title,artist,duration_ms,recording_id,status,local_track_id,permalink FROM entities' + where + ' ORDER BY (trim(coalesce(title,""))=""),title,id LIMIT ? OFFSET ?', [*args, limit, offset]).fetchall()
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
    current_candidates = {r[0] for r in db.execute('SELECT e.id FROM entities e WHERE ' +
        current_local_predicate() + ' AND e.id IN (SELECT value FROM json_each(?))',
        (json.dumps([c['other_id'] for c in item['candidates'] if c['other_service']=='local']),))}
    visible_candidates = []
    for candidate in item['candidates']:
        if candidate['other_service']=='local' and candidate['other_id'] not in current_candidates:
            continue
        raw = json.loads(db.execute('SELECT metadata_json FROM entities WHERE id=?',(candidate['other_id'],)).fetchone()[0])
        if raw.get('asset_lifecycle',{}).get('state')!='retired' and raw.get('catalog_current') is not False:
            visible_candidates.append(candidate)
    item['candidates'] = visible_candidates
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
