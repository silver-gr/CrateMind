"""Identity v1 acceptance ledger and canonical DB metadata; no audio or network I/O."""
from __future__ import annotations
import hashlib
import json
import os
import sqlite3
from collections import defaultdict, Counter
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager
from . import identity_library, canonical_metadata
from .identity_matching import score_candidate, text_key

SCHEMA = '''
CREATE TABLE IF NOT EXISTS identity_acceptances(
 left_id TEXT NOT NULL,right_id TEXT NOT NULL,match_source TEXT NOT NULL,confidence REAL NOT NULL,
 method TEXT NOT NULL,evidence_json TEXT NOT NULL,accepted_at TEXT NOT NULL,
 acceptance_mode TEXT NOT NULL CHECK(acceptance_mode IN ('human','deterministic','auto_high_confidence')),
 revoked_at TEXT,PRIMARY KEY(left_id,right_id));
CREATE TABLE IF NOT EXISTS canonical_recordings(
 recording_id TEXT PRIMARY KEY,title TEXT,artist TEXT,version TEXT,release TEXT,
 state TEXT NOT NULL,proposal_json TEXT NOT NULL,evidence_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_artists(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalized_name TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS canonical_artist_name ON canonical_artists(normalized_name);
CREATE TABLE IF NOT EXISTS recording_artists(
 recording_id TEXT NOT NULL REFERENCES canonical_recordings(recording_id),artist_id TEXT NOT NULL REFERENCES canonical_artists(id),
 credit_order INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('primary','collaborator','featured','remixer')),
 PRIMARY KEY(recording_id,credit_order));
CREATE TABLE IF NOT EXISTS canonical_events(
 id INTEGER PRIMARY KEY,recording_id TEXT,action TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_patterns(pattern TEXT PRIMARY KEY,report_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_base_entities(entity_id TEXT PRIMARY KEY,recording_id TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_blocks(left_id TEXT,right_id TEXT,reason TEXT,PRIMARY KEY(left_id,right_id));
'''

def dump(v): return json.dumps(v,ensure_ascii=False,sort_keys=True)
def now(): return datetime.now(timezone.utc).isoformat()

@contextmanager
def connect(path=None):
    path=Path(path) if path is not None else identity_library.database_path()
    db=sqlite3.connect(path.resolve().as_uri()+'?mode=rw',uri=True,timeout=30)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        with db: yield db
    finally: db.close()

def available(db):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='canonical_recordings'").fetchone())

def set_credits(db,rid,rows):
    db.execute('DELETE FROM recording_artists WHERE recording_id=?',(rid,))
    for i,r in enumerate(rows):
        key=text_key(r['name'])
        aid=r.get('provider_uri') or 'artist:'+hashlib.sha256(key.encode()).hexdigest()[:24]
        db.execute('INSERT OR IGNORE INTO canonical_artists VALUES (?,?,?)',(aid,r['name'],key))
        db.execute('INSERT INTO recording_artists VALUES (?,?,?,?)',(rid,aid,i,r['role']))

def materialize(db):
    """Replay active acceptance edges. Revocation can split components again."""
    entities={r['id']:dict(r) for r in db.execute('SELECT * FROM entities')}
    parent={sid:sid for sid in entities}
    def find(x):
        while parent[x]!=x:
            parent[x]=parent[parent[x]];x=parent[x]
        return x
    for r in db.execute('SELECT * FROM identity_acceptances WHERE revoked_at IS NULL'):
        a,b=find(r['left_id']),find(r['right_id']);parent[max(a,b)]=min(a,b)
    groups=defaultdict(list)
    for sid,e in entities.items():
        rid=find(sid);groups[rid].append(e)
    db.execute('DELETE FROM recording_artists')
    previous={r['recording_id']:dict(r) for r in db.execute('SELECT * FROM canonical_recordings')}
    db.execute('DELETE FROM canonical_recordings')
    results,patterns=canonical_metadata.derive(groups)
    for rid,group in groups.items():
        value=results[rid];p=value['proposal']
        db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)',(rid,value['title'],'ACCEPTED' if len(group)>1 else 'PROVISIONAL'))
        for e in group:
            original=db.execute('SELECT status FROM canonical_base_entities WHERE entity_id=?',(e['id'],)).fetchone()[0]
            db.execute('UPDATE entities SET recording_id=?,status=? WHERE id=?',(rid,'ACCEPTED' if len(group)>1 else original,e['id']))
        # Preserve manual metadata decisions across replay only when component members are identical.
        old=previous.get(rid)
        if old and old['state'] in {'human','kept_local','rejected'}:
            old_ids={o['id'] for o in json.loads(old['evidence_json'])['observations']}
            if old_ids=={e['id'] for e in group}:
                db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',tuple(old[k] for k in ('recording_id','title','artist','version','release','state','proposal_json','evidence_json','updated_at')))
                event=db.execute('SELECT after_json FROM canonical_events WHERE recording_id=? AND action IN (\'accept\',\'bulk_accept\',\'edit\',\'keep_local\',\'reject\') ORDER BY id DESC LIMIT 1',(rid,)).fetchone()
                set_credits(db,rid,json.loads(event[0]).get('credits',[]) if event else [])
                continue
        db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',(rid,value['title'],value['artist'],p['version'],p['release'],value['state'],dump(p),dump(value),now()))
        rows=p['credits'] if value['state']=='derived' else canonical_metadata.credits(value['artist'],value['title'])
        set_credits(db,rid,rows)
    for pattern,report in patterns.items():
        report['applied_corroborated_recordings']=sum(v['state']=='derived' and pattern in v['validated_patterns'] for v in results.values())
        db.execute('INSERT OR REPLACE INTO canonical_patterns VALUES (?,?)',(pattern,dump(report)))
    old_summary=json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
    summary={**old_summary,'identity_policy':'v1','canonical_updated_at':now(),'coverage':{}}
    for service in ('local','spotify','soundcloud'):
        counts=Counter(); others=[s for s in ('local','spotify','soundcloud') if s!=service]
        for sid,e in entities.items():
            if e['service']!=service or service=='spotify' and not sid.startswith('spotify:track:'):continue
            services={x['service'] for x in groups[find(sid)]}-{service}
            counts['total']+=1
            for s in others:counts['resolved_to_'+s]+=s in services
            counts['resolved_to_both']+=len(services)==2
            counts['no_accepted_cross_source_link']+=not services
            status='ACCEPTED' if len(groups[find(sid)])>1 else e['status']
            counts['status_'+status]+=1
        summary['coverage'][service]=dict(counts)
    db.execute("UPDATE metadata SET value=? WHERE key='summary'",(dump(summary),))
    return {'recordings':len(groups),'canonical_states':dict(Counter(v['state'] for v in results.values())),
            'patterns':patterns,'coverage':summary['coverage'],
            'changed_local_metadata':sum((e['artist']!=results[rid]['artist'] or e['title']!=results[rid]['title']) for rid,group in groups.items() for e in group if e['service']=='local')}

def promote(db):
    db.executescript(SCHEMA)
    db.execute('INSERT OR IGNORE INTO canonical_base_entities SELECT id,recording_id,status FROM entities')
    entities={r['id']:dict(r) for r in db.execute('SELECT * FROM entities')}
    norm={sid:json.loads(e['normalized_json']) for sid,e in entities.items()}
    parent={sid:sid for sid in entities};members={sid:{sid} for sid in entities}
    def find(x):
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    def join(a,b):
        a,b=find(a),find(b)
        if a!=b:
            a,b=min(a,b),max(a,b);parent[b]=a;members[a]|=members.pop(b)
    def record(r,mode,method):
        db.execute('INSERT OR IGNORE INTO identity_acceptances VALUES (?,?,?,?,?,?,?,?,NULL)',(r['left_id'],r['right_id'],r['pair_type'],r['score'],method,r['evidence_json'],(json.loads(r['evidence_json']).get('anchor') or {}).get('original',{}).get('confirmed_at') or now(),mode))
    rows=[dict(r) for r in db.execute('SELECT * FROM candidates ORDER BY score DESC,left_id,right_id')]
    rejected={frozenset((r['left_id'],r['right_id'])) for r in rows if 'previously_rejected' in json.loads(r['evidence_json']).get('conflicts',[])}
    for r in rows:
        if r['class']=='ACCEPTED':
            e=json.loads(r['evidence_json']);anchor=e.get('anchor') or {}
            record(r,'human' if anchor.get('method','').endswith('manual_review') else 'deterministic',anchor.get('method') or 'corroborated_isrc')
    for r in db.execute('SELECT * FROM identity_acceptances WHERE revoked_at IS NULL'):join(r['left_id'],r['right_id'])
    promoted=0;blocked=Counter()
    for r in rows:
        if r['class']!='HIGH_CONFIDENCE':continue
        if db.execute('SELECT 1 FROM identity_acceptances WHERE left_id=? AND right_id=?',(r['left_id'],r['right_id'])).fetchone():continue
        e=json.loads(r['evidence_json']);reason=None
        if e.get('conflicts') or e.get('near_tie_review') or frozenset((r['left_id'],r['right_id'])) in rejected:reason='hard_guard_or_near_tie'
        elif e.get('score_without_neighborhood',0)<89 or e.get('title_similarity',0)<.9 or e.get('artist_similarity',0)<.8 or e.get('duration_delta_seconds') is None or e['duration_delta_seconds']>6:reason='insufficient_independent_evidence'
        a,b=find(r['left_id']),find(r['right_id'])
        if not reason and a!=b:
            for x in members[a]:
                for y in members[b]:
                    if frozenset((x,y)) in rejected:
                        reason='historical_rejection';break
                    nx,ny=norm[x],norm[y]
                    if nx.get('isrc_key') and ny.get('isrc_key') and nx['isrc_key']!=ny['isrc_key']:
                        reason='contradictory_isrc';break
                    evidence=score_candidate(nx,ny)['evidence']
                    if evidence['conflicts']:
                        reason='component_'+evidence['conflicts'][0];break
                if reason:break
        if reason:
            blocked[reason]+=1
            db.execute('INSERT OR REPLACE INTO canonical_blocks VALUES (?,?,?)',(r['left_id'],r['right_id'],reason))
            continue
        record(r,'auto_high_confidence','identity_v1_guarded_high_confidence');join(r['left_id'],r['right_id']);promoted+=1
    report=materialize(db)
    report.update({'new_promotions':promoted,'blocked':dict(blocked),'acceptances':dict(db.execute('SELECT acceptance_mode,count(*) FROM identity_acceptances WHERE revoked_at IS NULL GROUP BY acceptance_mode').fetchall())})
    db.execute('INSERT INTO canonical_events(action,after_json,created_at) VALUES (?,?,?)',('promotion_run',dump(report),now()))
    return report

def detail(db,rid):
    alias=db.execute('SELECT recording_id FROM entities WHERE id=?',(rid,)).fetchone()
    if alias:rid=alias[0]
    r=db.execute('SELECT * FROM canonical_recordings WHERE recording_id=?',(rid,)).fetchone()
    if not r:return None
    v=dict(r);v['proposal']=json.loads(v.pop('proposal_json'));v['evidence']=json.loads(v.pop('evidence_json'))
    v['credits']=[dict(r) for r in db.execute('SELECT a.id,a.name,ra.role,ra.credit_order FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id WHERE recording_id=? ORDER BY credit_order',(rid,))]
    from .provider_resolution import recording
    v.update(recording(db,rid))
    return v

def review(db,rid,action,payload=None):
    before=detail(db,rid)
    if not before:raise ValueError('Recording not found')
    rid=before['recording_id']
    if action=='keep_local' and not any(not a.get('retired') for a in before['local_assets']):raise ValueError('No active local metadata source is available.')
    p=before['proposal'];state='human'
    if action=='edit':
        p=payload or {}
        if not p.get('title') or not p.get('credits') or not any(c.get('role') in {'primary','collaborator'} for c in p['credits']) or any(c.get('role') not in canonical_metadata.ROLES or not c.get('name','').strip() for c in p['credits']):raise ValueError('Title and valid artist credits required')
        p={**p,'artist':canonical_metadata.display_credit(p['credits'])}
    elif action in {'keep_local','reject'}:
        locals=[o for o in before['evidence']['observations'] if o['service']=='local']
        fallback=locals[0] if locals else {'artist':before['artist'],'title':before['title']}
        p={**p,'artist':fallback['artist'],'title':fallback['title'],'credits':canonical_metadata.credits(fallback['artist'],fallback['title'])}
        p['version']=', '.join(canonical_metadata.version_terms(p['title']))
        if locals:
            source=db.execute('SELECT normalized_json FROM entities WHERE id=?',(locals[0]['id'],)).fetchone()
            p['release']=json.loads(source[0]).get('album')
        state='kept_local' if action=='keep_local' else 'rejected'
    elif action not in {'accept','bulk_accept'}:raise ValueError('Unknown action')
    if action in {'accept','bulk_accept'} and (not p.get('title') or not any(x.get('role') in {'primary','collaborator'} for x in p.get('credits',[]))):
        raise ValueError('Η πρόταση χρειάζεται τίτλο και κύριο καλλιτέχνη ή συνεργάτη. Επεξεργαστείτε πρώτα τα στοιχεία.')
    db.execute('UPDATE canonical_recordings SET title=?,artist=?,version=?,release=?,state=?,updated_at=? WHERE recording_id=?',(p['title'],p['artist'],p.get('version'),p.get('release'),state,now(),rid))
    set_credits(db,rid,p['credits'])
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(rid,action,dump(before),dump(p),now()))
    return detail(db,rid)

def revoke(db,left,right):
    r=db.execute('SELECT * FROM identity_acceptances WHERE left_id=? AND right_id=?',(left,right)).fetchone()
    if not r or r['acceptance_mode']!='auto_high_confidence':raise ValueError('Only automatic Identity v1 promotions can be reversed here')
    db.execute('UPDATE identity_acceptances SET revoked_at=? WHERE left_id=? AND right_id=?',(now(),left,right))
    db.execute('INSERT INTO canonical_events(action,before_json,created_at) VALUES (?,?,?)',('revoke_identity',dump(dict(r)),now()))
    result=materialize(db)
    from .identity_matching import refresh_entity_statuses
    refresh_entity_statuses(db)
    return result

def catalog_session_matches(session):
    if session is None:
        return True
    database = session.get_bind().url.database
    from ..config import get_settings
    expected = get_settings().db_file
    return bool(database and database != ':memory:' and Path(database).resolve() == expected.resolve())


def overlay(rows, session=None):
    """Bulk response projection; SQLModel tracks and tag-edit payload stay original."""
    if not rows or not catalog_session_matches(session):return rows
    try:
        with identity_library.connect() as db:
            if not available(db):return rows
            ids=dump(sorted({r['id'] for r in rows}))
            values={r['local_track_id']:dict(r) for r in db.execute(
                'SELECT e.local_track_id,c.recording_id,c.title,c.artist,c.state '
                'FROM entities e JOIN canonical_recordings c ON c.recording_id=e.recording_id '
                'WHERE '+identity_library.current_local_predicate('e')+
                ' AND e.local_track_id IN (SELECT value FROM json_each(?))', (ids,))}
            from .provider_resolution import bulk_soundcloud
            counters=bulk_soundcloud(db, {r['recording_id'] for r in values.values()})
            for row in rows:
                c=values.get(row['id'])
                if c:
                    row['original_artist']=row.get('artist');row['original_title']=row.get('title')
                    row['artist']=c['artist'];row['title']=c['title']
                    row['canonical_recording_id']=c['recording_id'];row['canonical_state']=c['state']
                    provider=counters.get(c['recording_id'])
                    counter=provider['popularity'] if provider else None
                    row['soundcloud_counter_source_id']=provider['id'] if provider else None
                    row['canonical_soundcloud']=c['recording_id'] in counters
                    row['soundcloud_playback_count']=(counter or {}).get('playback_count')
                    row['soundcloud_likes_count']=(counter or {}).get('likes_count')
    except sqlite3.OperationalError:pass
    return rows

def search_ids(terms,field='all',any_term=False,session=None):
    if not catalog_session_matches(session):return []
    try:
        with identity_library.connect() as db:
            if not available(db):return []
            db.create_function('cratemind_text',1,text_key,deterministic=True)
            fields=('artist','credits') if field=='artist' else ('release',) if field=='album' else ('title','artist','credits','release')
            haystack=" || ' ' || ".join(f"coalesce({column},'')" for column in fields)
            checks=[f"instr(cratemind_text({haystack}), ?) > 0" for _term in terms]
            condition=(' OR ' if any_term else ' AND ').join(checks) if checks else ('0' if any_term else '1')
            sql=('SELECT local_track_id FROM (SELECT e.local_track_id,c.title,c.artist,c.release,'
                 'group_concat(a.name," ") AS credits FROM entities e JOIN canonical_recordings c ON c.recording_id=e.recording_id '
                 'LEFT JOIN recording_artists ra ON ra.recording_id=c.recording_id '
                 'LEFT JOIN canonical_artists a ON a.id=ra.artist_id WHERE '+identity_library.current_local_predicate('e')+
                 ' GROUP BY e.id) WHERE '+condition)
            return [r['local_track_id'] for r in db.execute(sql,[text_key(t) for t in terms])]
    except sqlite3.OperationalError:return []
