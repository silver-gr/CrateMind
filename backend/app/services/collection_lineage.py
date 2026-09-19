"""Additive collection provenance. Correspondence never changes recording identity."""
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import hashlib
import itertools
import json
import re
import unicodedata
from datetime import datetime, timezone

SCHEMA='''CREATE TABLE IF NOT EXISTS collection_relationships(
 id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES collections(id),destination_id TEXT NOT NULL REFERENCES collections(id),
 relation TEXT NOT NULL,status TEXT NOT NULL,confidence REAL NOT NULL,evidence_json TEXT NOT NULL,
 decision_mode TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(source_id,destination_id));
CREATE TABLE IF NOT EXISTS collection_relationship_events(
 id INTEGER PRIMARY KEY,relationship_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);'''
RELATIONS={'exact_copy_of','migrated_from','likely_migrated_from','merged_from','descendant_of','possible_version_of','unrelated'}
HISTORY=[
 'User confirmed: all Account-1 Likes transferred to Account 2; many Account-1 playlists transferred, with possible same-name merges.',
 'User confirmed: SoundCloud playlists transferred to Account 2 with omissions, wrong substitutions and repeated runs.',
 'April 10 and September 9, 2026 timestamp clusters are observations, not verified migration origins.'
]


def init(db):
    for sql in SCHEMA.split(';'):
        if sql.strip():db.execute(sql)


def name_key(name):
    text=unicodedata.normalize('NFKC',name or '').casefold()
    text=re.sub(r'\.csv$','',text)
    text=re.sub(r'\s*\(\d+\)$','',text)
    return ' '.join(re.findall(r'[^\W_]+',text))


def observations(db):
    values={}
    for r in db.execute('SELECT * FROM collections ORDER BY id'):
        c=dict(r);c['provenance']=json.loads(c.pop('provenance_json'));c['key']=name_key(c['name']);c['positions']=[];values[c['id']]=c
    for r in db.execute('''SELECT m.collection_id,m.position,m.entity_id,m.added_at,e.recording_id,e.title,e.artist
        FROM memberships m JOIN entities e ON e.id=m.entity_id ORDER BY m.collection_id,m.position'''):
        values[r['collection_id']]['positions'].append(dict(r))
    for c in values.values():
        c['sequence']=[p['recording_id'] for p in c['positions']]
        c['multiset']=Counter(c['sequence']);c['days']=Counter(p['added_at'][:10] for p in c['positions'] if p['added_at'])
    return values


def route(a,b):
    return b['service']=='spotify' and b['provenance'].get('account')=='account2' and (a['service']=='soundcloud' or (a['service']=='spotify' and a['provenance'].get('account')=='account1'))


def summary(a,b):
    x=a['sequence'];y=b['sequence'];shared=sum((a['multiset']&b['multiset']).values())
    return {'source_positions':len(x),'destination_positions':len(y),'shared_positions':shared,
            'missing_positions':len(x)-shared,'destination_only_positions':len(y)-shared,
            'exact_ordered':bool(x) and x==y,'exact_multiset':bool(x) and a['multiset']==b['multiset'],
            'normalized_name_equal':a['key']==b['key'],'known_route':route(a,b),
            'source_timestamp_days':dict(a['days']),'destination_timestamp_days':dict(b['days']),
            'source_sequence_sha256':hashlib.sha256(json.dumps(x).encode()).hexdigest(),
            'destination_sequence_sha256':hashlib.sha256(json.dumps(y).encode()).hexdigest(),
            'dates_do_not_establish_origin':True}


def candidate(a,b):
    e=summary(a,b);n=e['source_positions'];m=e['destination_positions'];shared=e['shared_positions']
    if not n or not m:return None
    relation='possible_version_of';status='proposed';confidence=.4
    native_origin=b['provenance'].get('origin_collection')==a['id']
    if e['exact_ordered'] and ((e['normalized_name_equal'] and min(n,m)>=2) or native_origin):
        relation='migrated_from' if e['known_route'] else 'exact_copy_of'
        status='accepted';confidence=1.0
        e['direction_basis']='known provider/account route' if e['known_route'] else 'explicit native origin' if native_origin else 'equivalent observations; representative direction is not chronology'
        e['acceptance_basis']='exact canonical ordered sequence plus name and known route' if e['known_route'] else 'exact observation-equivalence, not proof of independent selection or chronology'
    elif e['exact_multiset'] and e['normalized_name_equal']:
        relation='likely_migrated_from' if e['known_route'] else 'possible_version_of';confidence=.95
    elif shared>=3 and e['normalized_name_equal'] and shared/n>=.7 and shared/m>=.7:
        relation='likely_migrated_from' if e['known_route'] else 'possible_version_of';confidence=round(min(shared/n,shared/m),3)
        if e['known_route'] and b['sequence'][:n]==a['sequence'] and m>n:
            head=[p['added_at'] for p in b['positions'][:n]];tail=[p['added_at'] for p in b['positions'][n:]]
            e['exact_source_prefix']=True
            e['later_additions']=bool(all(head) and all(tail) and min(tail)>max(head))
            if e['later_additions']:
                relation='descendant_of';status='accepted';confidence=.99;e['acceptance_basis']='full ordered source prefix and later dated additions on user-confirmed route'
    elif e['normalized_name_equal'] and not shared:
        relation='unrelated';confidence=.0
        e['interpretation']='same-name content conflict; not proof of historical unrelatedness'
    elif shared>=3 and shared/max(n,m)>=.5:
        relation='likely_migrated_from' if e['known_route'] else 'possible_version_of';confidence=round(shared/max(n,m),3)
    else:return None
    if shared==n and m>n:
        match=SequenceMatcher(None,a['sequence'],b['sequence'],autojunk=False)
        e['ordered_subsequence']=sum(block.size for block in match.get_matching_blocks())==n
        if e['ordered_subsequence']:
            e['structural_extension']=True
            if status!='accepted':relation='descendant_of'
    e['imperfect']=0<shared<min(n,m) or (0<shared<n)
    return relation,status,confidence,e


def infer(db):
    """Rebuild automatic evidence only; preserve all human decisions and immutable observations."""
    init(db);values=observations(db);pairs=set();by_name=defaultdict(list);by_exact=defaultdict(list)
    for c in values.values():
        by_name[c['key']].append(c['id'])
        if c['sequence']:by_exact[tuple(c['sequence'])].append(c['id'])
        origin=c['provenance'].get('origin_collection')
        if origin in values:pairs.add((origin,c['id']))
    # Canonical overlap retrieves renamed migrations; title equality is not required for proposals.
    inverted=defaultdict(list)
    for c in values.values():
        for rid in set(c['sequence']):inverted[rid].append(c['id'])
    overlap=Counter()
    for group in inverted.values():
        for x,y in itertools.combinations(sorted(group),2):overlap[x,y]+=1
    for (x,y),shared in overlap.items():
        a,b=values[x],values[y]
        if shared>=3 and shared/max(len(set(a['sequence'])),len(set(b['sequence'])))>=.5:
            if route(b,a):x,y=y,x
            elif not route(a,b) and len(a['sequence'])>len(b['sequence']):x,y=y,x
            pairs.add((x,y))
    for group in list(by_name.values())+list(by_exact.values()):
        for x,y in itertools.combinations(group,2):
            a,b=values[x],values[y]
            if a['provenance'].get('origin_collection')==b['id']:x,y=y,x
            elif b['provenance'].get('origin_collection')==a['id']:pass
            elif route(b,a):x,y=y,x
            elif not route(a,b) and len(a['sequence'])>len(b['sequence']):x,y=y,x
            pairs.add((x,y))
    found={}
    for x,y in sorted(pairs):
        result=candidate(values[x],values[y])
        if result:found[x,y]=result
    # Same-name concatenation must exactly consume two non-empty distinct source sequences.
    for group in by_name.values():
        src=[values[cid] for cid in group if values[cid]['service']=='spotify' and values[cid]['provenance'].get('account')=='account1' and values[cid]['sequence']]
        dst=[values[cid] for cid in group if values[cid]['service']=='spotify' and values[cid]['provenance'].get('account')=='account2']
        for b in dst:
            proofs=[(a,z) for a,z in itertools.permutations(src,2) if a['sequence']!=z['sequence'] and a['sequence']+z['sequence']==b['sequence']]
            # Multiple explanations remain proposed; do not pick an arbitrary parent pair.
            for a,z in proofs:
                for parent in (a,z):
                    e=summary(parent,b);e['merge_sources']=[a['id'],z['id']];e['exact_concatenation']=True;e['alternative_explanations']=len(proofs)
                    found[parent['id'],b['id']]=('merged_from','accepted' if len(proofs)==1 else 'proposed',1.0,e)
    # Unlike named playlists, each account's Likes is one identified system collection.
    # The user explicitly confirmed this transfer; current differences do not erase history.
    liked_sources=[c for c in values.values() if c['kind']=='likes' and c['service']=='spotify' and c['provenance'].get('account')=='account1']
    liked_destinations=[c for c in values.values() if c['kind']=='likes' and c['service']=='spotify' and c['provenance'].get('account')=='account2']
    if len(liked_sources)==len(liked_destinations)==1:
        a,b=liked_sources[0],liked_destinations[0];e=summary(a,b)
        e['user_confirmed_history']='All Spotify Account-1 Likes were transferred into Account 2.'
        e['current_snapshot_equality_not_claimed']=True
        found[a['id'],b['id']]=('migrated_from','accepted',1.0,e)
    stamp=datetime.now(timezone.utc).isoformat()
    # Source snapshots may be refreshed in future: retire obsolete inferred links, never silently retain them.
    for old in db.execute("SELECT * FROM collection_relationships WHERE decision_mode='inferred' AND status!='retired'").fetchall():
        if (old['source_id'],old['destination_id']) not in found:
            db.execute('UPDATE collection_relationships SET status="retired",updated_at=? WHERE id=?',(stamp,old['id']))
            db.execute('INSERT INTO collection_relationship_events(relationship_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(old['id'],'retire',json.dumps(dict(old)),json.dumps({'status':'retired'}),stamp))
    for (x,y),(relation,status,confidence,evidence) in found.items():
        rid=hashlib.sha256((x+'\0'+y).encode()).hexdigest()
        old=db.execute('SELECT * FROM collection_relationships WHERE id=?',(rid,)).fetchone()
        if old and old['decision_mode']=='human':continue
        value=(rid,x,y,relation,status,confidence,json.dumps(evidence,sort_keys=True),'inferred',stamp)
        if old and tuple(old)[1:8]==value[1:8]:continue
        db.execute('INSERT OR REPLACE INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',value)
        db.execute('INSERT INTO collection_relationship_events(relationship_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(rid,'infer',json.dumps(dict(old)) if old else None,json.dumps(dict(zip(['id','source_id','destination_id','relation','status','confidence','evidence_json','decision_mode','updated_at'],value))),stamp))
    return report(db)


def relationships(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_relationships'").fetchone():return []
    rows=[]
    for r in db.execute('SELECT * FROM collection_relationships ORDER BY id'):
        v=dict(r);v['evidence']=json.loads(v.pop('evidence_json'));rows.append(v)
    return rows


def report(db):
    links=relationships(db);active=[r for r in links if r['status']!='retired']
    return {'relationships':len(active),'exact_copies':sum(r['relation']=='exact_copy_of' and r['status']=='accepted' for r in active),
            'confirmed_migrations':sum(r['relation']=='migrated_from' and r['status']=='accepted' for r in active),
            'likely_migrations':sum(r['relation']=='likely_migrated_from' for r in active),
            'descendants':sum(r['relation']=='descendant_of' for r in active),
            'accepted_descendants':sum(r['relation']=='descendant_of' and r['status']=='accepted' for r in active),
            'merge_edges':sum(r['relation']=='merged_from' and r['status']=='accepted' for r in active),
            'merge_destinations':len({r['destination_id'] for r in active if r['relation']=='merged_from' and r['status']=='accepted'}),
            'imperfect_transfers':sum(r['evidence'].get('imperfect',False) and r['evidence'].get('known_route',False) for r in active),
            'unresolved_relationships':sum(r['status']=='proposed' for r in active),'historical_facts':HISTORY}


def decorate_counts(db,catalog):
    """Count distinct evidenced roots per recording. A merge retains BOTH independent parents."""
    all_links=relationships(db)
    blocked={(r['source_id'],r['destination_id']) for r in all_links if r['decision_mode']=='human' and (r['status']!='accepted' or r['relation']=='unrelated')}
    links=[r for r in all_links if r['status']=='accepted' and r['relation']!='unrelated']
    parents=defaultdict(list)
    for r in links:parents[r['destination_id']].append(r['source_id'])
    # Explicit native copy/algebra origins are factual derivation, including collections saved after the last analysis.
    derived=defaultdict(lambda:defaultdict(set))
    for r in db.execute("SELECT e.recording_id,m.collection_id,m.source_json FROM memberships m JOIN entities e ON e.id=m.entity_id JOIN collections c ON c.id=m.collection_id WHERE c.service='cratemind'"):
        provenance=json.loads(r['source_json'] or '{}')
        if provenance.get('origin_collection'):derived[r['recording_id']][r['collection_id']].add(provenance['origin_collection'])
        for origin in provenance.get('origins',[]):
            if origin.get('collection_id'):derived[r['recording_id']][r['collection_id']].add(origin['collection_id'])
    raw=Counter(r['recording_id'] for r in db.execute('SELECT e.recording_id FROM memberships m JOIN entities e ON e.id=m.entity_id'))
    for rid,v in catalog.items():
        memberships=set(v['collections']);memo={}
        def roots(cid,path):
            if cid in path:return {min(path|{cid})}  # review rejects cycles; legacy protection only
            if cid in memo:return memo[cid]
            ps=[p for p in set(parents[cid])|derived[rid][cid] if p in memberships and p!=cid and (p,cid) not in blocked]
            memo[cid]=set().union(*(roots(p,path|{cid}) for p in ps)) if ps else {cid}
            return memo[cid]
        families=set().union(*(roots(cid,set()) for cid in memberships)) if memberships else set()
        v.update(raw_collection_occurrences=raw[rid],source_collection_count=len(memberships),collection_family_count=len(families),collection_family_roots=sorted(families))
    return catalog


def decide(db,rid,action,relation=None):
    init(db);old=db.execute('SELECT * FROM collection_relationships WHERE id=?',(rid,)).fetchone()
    if not old:raise ValueError('Unknown relationship')
    if action not in {'accept','reject','reset'}:raise ValueError('Invalid action')
    kind=relation or old['relation']
    if kind not in RELATIONS:raise ValueError('Invalid relationship')
    if action=='accept' and kind!='unrelated':
        adjacency=defaultdict(list)
        for r in relationships(db):
            if r['id']!=rid and r['status']=='accepted' and r['relation']!='unrelated':adjacency[r['source_id']].append(r['destination_id'])
        seen=set();todo=[old['destination_id']]
        while todo:
            x=todo.pop()
            if x==old['source_id']:raise ValueError('This relationship would create a lineage cycle')
            if x not in seen:seen.add(x);todo.extend(adjacency[x])
    stamp=datetime.now(timezone.utc).isoformat();status='accepted' if action=='accept' else 'rejected' if action=='reject' else 'proposed'
    db.execute('UPDATE collection_relationships SET status=?,relation=?,decision_mode=?,updated_at=? WHERE id=?',(status,kind,'human',stamp,rid))
    db.execute('INSERT INTO collection_relationship_events(relationship_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(rid,action,json.dumps(dict(old)),json.dumps({'status':status,'relation':kind}),stamp))
    return {'id':rid,'status':status}


def alignment(a,b,accepted=False):
    """Anchored sequence gaps are correspondence evidence, NEVER recording matches."""
    x,y=a['sequence'],b['sequence'];out=[]
    opcodes=SequenceMatcher(None,x,y,autojunk=False).get_opcodes()
    for oi,(tag,i,j,k,l) in enumerate(opcodes):
        left=a['positions'][i:j];right=b['positions'][k:l]
        if tag=='equal':
            for s,d in zip(left,right):out.append({'classification':'correct_transfer' if accepted else 'shared_recording','source':[s],'destination':[d]})
            continue
        anchored=oi>0 and oi<len(opcodes)-1 and opcodes[oi-1][0]=='equal' and opcodes[oi+1][0]=='equal'
        if tag=='delete':kind='missing_destination'
        elif tag=='insert':kind='destination_only_addition'
        elif accepted and anchored and len(left)==len(right)==1:
            neighbors=[b['positions'][k-1].get('added_at'),right[0].get('added_at'),b['positions'][l].get('added_at')]
            kind='ambiguous' if all(neighbors) and len({d[:10] for d in neighbors})>1 else 'likely_wrong_substitution'
        else:kind='ambiguous'
        # Reordered known recordings are not missing/substitutions.
        if any(p['recording_id'] in set(y) for p in left) or any(p['recording_id'] in set(x) for p in right):kind='reordered_or_repeated'
        if tag=='insert' and accepted and kind=='destination_only_addition':
            common=[p['added_at'] for p in b['positions'] if p['recording_id'] in set(x)]
            extra=[p['added_at'] for p in right]
            if common and all(common) and all(extra) and min(extra)>max(common):kind='destination_only_later_addition'
        out.append({'classification':kind,'source':left,'destination':right,'bounded_by_shared_neighbors':anchored})
    return out


def detail(db,rid):
    link=next((r for r in relationships(db) if r['id']==rid),None)
    if not link:return None
    values=observations(db);a=values[link['source_id']];b=values[link['destination_id']]
    lines=alignment(a,b,link['status']=='accepted' and link['relation']!='unrelated')
    def brief(c):return {k:c[k] for k in ('id','name','service','provenance')}
    counts=Counter()
    for r in lines:counts[r['classification']]+=max(len(r['source']),len(r['destination']))
    return {**link,'source':brief(a),'destination':brief(b),'comparison':summary(a,b),'correspondence':lines,
            'correspondence_counts':dict(counts),
            'chronology_note':'Source order and exposed added_at observations only. No inferred dates.'}


def browse(db,q='',category='',collection='',offset=0):
    names={r['id']:dict(r) for r in db.execute('SELECT id,name,service FROM collections')};items=[]
    for r in relationships(db):
        if r['status']=='retired':continue
        if collection and collection not in {r['source_id'],r['destination_id']}:continue
        if q.casefold() not in (names[r['source_id']]['name']+' '+names[r['destination_id']]['name']).casefold():continue
        if category=='unresolved' and r['status']!='proposed':continue
        if category=='imperfect' and not (r['evidence'].get('imperfect') and r['evidence'].get('known_route')):continue
        if category and category not in {'unresolved','imperfect'} and r['relation']!=category:continue
        items.append({**r,'source':names[r['source_id']],'destination':names[r['destination_id']]})
    items.sort(key=lambda r:(r['status']!='proposed',r['source']['name'],r['id']))
    return {'total':len(items),'items':items[offset:offset+50],'summary':report(db)}


def history(db,rid):
    rows=[dict(r) for r in db.execute('''SELECT c.id,c.name,c.service,c.kind,m.position,m.added_at FROM memberships m
        JOIN entities e ON e.id=m.entity_id JOIN collections c ON c.id=m.collection_id WHERE e.recording_id=? ORDER BY c.id,m.position''',(rid,))]
    ids={r['id'] for r in rows}
    links=[r for r in relationships(db) if r['status']=='accepted' and r['relation']!='unrelated' and r['source_id'] in ids and r['destination_id'] in ids]
    value={'collections':{cid:{} for cid in ids}}
    decorate_counts(db,{rid:value})
    return {'raw_collection_occurrences':value['raw_collection_occurrences'],'source_collection_count':value['source_collection_count'],'collection_family_count':value['collection_family_count'],'observations':rows,'accepted_relationships':links,'chronology':'unordered observations; added_at is provider membership evidence, not acquisition time'}
