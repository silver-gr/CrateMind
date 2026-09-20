"""Reversible everyday-library presentation over immutable collection observations."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid
from . import collection_lineage as lineage

SCHEMA = '''
CREATE TABLE IF NOT EXISTS collection_consolidations(
 id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,mode TEXT NOT NULL,action TEXT NOT NULL,
 status TEXT NOT NULL,baseline_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_representation_bindings(
 decision_id TEXT NOT NULL,source_id TEXT NOT NULL,representative_id TEXT NOT NULL,
 PRIMARY KEY(decision_id,source_id,representative_id));
CREATE TABLE IF NOT EXISTS collection_position_dispositions(
 decision_id TEXT NOT NULL,source_id TEXT NOT NULL,source_position INTEGER NOT NULL,
 representative_id TEXT,representative_position INTEGER,disposition TEXT NOT NULL,
 PRIMARY KEY(decision_id,source_id,source_position,representative_id));
CREATE TABLE IF NOT EXISTS collection_presentation_overrides(
 collection_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_consolidation_events(
 id INTEGER PRIMARY KEY,decision_id TEXT NOT NULL,action TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
'''


def init(db):
    for sql in SCHEMA.split(';'):
        if sql.strip(): db.execute(sql)


def installed(db):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_consolidations'").fetchone())


def stamp(): return datetime.now(timezone.utc).isoformat()
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def snapshot(db,cid):
    row=db.execute('SELECT * FROM collections WHERE id=?',(cid,)).fetchone()
    if not row: raise ValueError('Unknown collection')
    positions=[dict(r) for r in db.execute('''SELECT m.*,e.recording_id FROM memberships m
        LEFT JOIN entities e ON e.id=m.entity_id WHERE collection_id=? ORDER BY position''',(cid,))]
    return {'collection':dict(row),'positions':positions}


def fingerprint(db,cid): return digest(snapshot(db,cid))


def sequence(value):
    # Explicit unavailable provider IDs remain evidence. Generic placeholders never prove equality.
    out=[]
    for p in value['positions']:
        eid=p['entity_id'] or ''
        if not p['recording_id'] or re.search(r'(unknown|null|placeholder|unresolved)',eid,re.I): return None
        out.append(p['recording_id'])
    if len(out)!=value['collection']['track_count']: return None
    return out


def projection(db):
    rows={r['id']:dict(r) for r in db.execute('SELECT * FROM collections')}
    destinations=defaultdict(set);hidden=set();wrappers=set();overrides=set()
    if installed(db):
        overrides={r[0] for r in db.execute('SELECT collection_id FROM collection_presentation_overrides')}
        active_reps={r[0] for r in db.execute("SELECT b.representative_id FROM collection_representation_bindings b JOIN collection_consolidations d ON d.id=b.decision_id WHERE d.status='active'")}
        for r in db.execute('SELECT * FROM collection_consolidations'):
            result=json.loads(r['result_json'])
            wrappers.update(result.get('created',[]))
            if r['status']=='active':
                hidden.update(set(result.get('absorbed',[]))-overrides)
            else:
                # Edited native work survives undo. Unedited wrappers are retained as history.
                for cid in result.get('created',[]):
                    if cid in rows and cid not in overrides and cid not in active_reps and fingerprint(db,cid)==result.get('representative_hashes',{}).get(cid):hidden.add(cid)
        for r in db.execute('''SELECT b.* FROM collection_representation_bindings b JOIN collection_consolidations d ON d.id=b.decision_id WHERE d.status='active' '''):
            if r['source_id'] not in overrides: destinations[r['source_id']].add(r['representative_id'])
    def resolve(cid,path=frozenset()):
        if cid in path:return set()
        if cid not in hidden:return {cid} if cid in rows else set()
        return set().union(*(resolve(x,path|{cid}) for x in destinations[cid])) if destinations[cid] else set()
    mapping={cid:resolve(cid) for cid in rows}
    return {'rows':rows,'hidden':hidden,'mapping':mapping,'wrappers':wrappers,'overrides':overrides}


def active_rows(db,q='',service='',account='',all_sources=False):
    p=projection(db);origins=defaultdict(list)
    for cid,targets in p['mapping'].items():
        for target in targets: origins[target].append(p['rows'][cid])
    result=[]
    for cid,row in p['rows'].items():
        if all_sources:
            if cid in p['wrappers']:continue
            sources=[row]
        else:
            if cid in p['hidden']:continue
            sources=origins[cid]
        if q.casefold() not in ' '.join(s['name'] or '' for s in sources).casefold():continue
        if service and not any(s['service']==service for s in sources):continue
        if account and not any(str(json.loads(s['provenance_json']).get('account',''))==account for s in sources):continue
        result.append({**row,'source_ids':[s['id'] for s in sources], 'representative_ids':sorted(p['mapping'][cid]),
                       'absorbed':cid in p['hidden'],'aliases':sorted({s['name'] for s in sources}),
                       'source_services':sorted({s['service'] for s in sources}),
                       'source_accounts':sorted({str(json.loads(s['provenance_json']).get('account')) for s in sources if json.loads(s['provenance_json']).get('account')})})
    origin_order={'soundcloud':0,'spotify':1,'cratemind':2}
    return sorted(result,key=lambda r:(origin_order.get(r['service'],3),str(json.loads(r['provenance_json']).get('account') or '').casefold(),r['name'].casefold(),r['id']))


def memberships(db,rid):
    # Everyday membership uses actual active contents, never an absorbed observation's side-only rows.
    p=projection(db)
    return [dict(r) for r in db.execute('''SELECT c.id,c.name,c.service,c.kind,c.provenance_json,m.position,m.entity_id,m.added_at
        FROM memberships m JOIN collections c ON c.id=m.collection_id JOIN entities e ON e.id=m.entity_id
        WHERE e.recording_id=? ORDER BY c.name,m.position''',(rid,)) if r['id'] not in p['hidden']]


def reliable_key(row):
    p=json.loads(row['provenance_json']);remote=p.get('source_remote_id')
    if not remote:return None
    key=(row['service'],str(p.get('account','')),str(remote))
    if row['kind']=='likes' or p.get('source_snapshot',{}).get('system_playlist'):
        key+= (str(p.get('observed_at')),)
        if not p.get('observed_at'):return None
    return key


def constraints(db):
    p=projection(db);pairs=[]
    for r in lineage.relationships(db):
        if r['decision_mode']=='human' and (r['status'] in {'rejected','proposed'} or r['relation']=='unrelated'):
            pairs.append({r['source_id'],r['destination_id']})
            pairs.extend({a,b} for a in p['mapping'][r['source_id']] for b in p['mapping'][r['destination_id']] if a!=b)
    return p,pairs


def automatic_plan(db):
    p,blocked=constraints(db);values={cid:snapshot(db,cid) for cid in p['rows']};seq={cid:sequence(v) for cid,v in values.items()}
    parents={cid:cid for cid in values};members={cid:{cid} for cid in values};skipped=[]
    def root(x):
        while parents[x]!=x:x=parents[x]
        return x
    candidates=[]
    for r in lineage.relationships(db):
        if r['status']=='accepted' and r['relation'] in {'exact_copy_of','migrated_from'}:
            candidates.append((r['source_id'],r['destination_id'],'accepted exact copy evidence'))
    by_source=defaultdict(list)
    for cid,row in p['rows'].items():
        key=reliable_key(row)
        if key:by_source[key].append(cid)
    for ids in by_source.values():
        for x,y in zip(sorted(ids),sorted(ids)[1:]):candidates.append((x,y,'same reliable source observation'))
    expanded=[]
    for a,b,basis in candidates:
        for x in p['mapping'][a]:
            for y in p['mapping'][b]:
                if x!=y:expanded.append((x,y,basis))
    for a,b,basis in sorted(expanded):
        x,y=root(a),root(b)
        if x==y:continue
        group=members[x]|members[y];reason=None
        explicit_copy=(p['rows'][a]['kind']=='native' and json.loads(p['rows'][a]['provenance_json']).get('origin_collection')==b) or (p['rows'][b]['kind']=='native' and json.loads(p['rows'][b]['provenance_json']).get('origin_collection')==a)
        if group&p['overrides'] or any(pair<=group for pair in blocked):reason='protected keep-separate or lineage decision'
        elif seq[a] is None or seq[a]!=seq[b]:reason='unequal/incomplete ordered content'
        elif len(seq[a])<2 and not explicit_copy and reliable_key(p['rows'][a])!=reliable_key(p['rows'][b]):reason='short collection without reliable shared identity'
        elif len(seq[a])<2 and not explicit_copy and not reliable_key(p['rows'][a]):reason='short collection without reliable shared identity'
        # Explicit independent-use metadata protects native/user intent. Missing descriptions do not block.
        elif any(json.loads(p['rows'][cid]['provenance_json']).get('keep_separate') or json.loads(p['rows'][cid]['provenance_json']).get('independent_use') for cid in group):reason='explicit independent use'
        notes=set();curators=set()
        for i in group:
            metadata=json.loads(p['rows'][i]['provenance_json']);source=metadata.get('source_snapshot',{})
            note=source.get('description') or metadata.get('description')
            if note and note.strip():notes.add(note.strip())
            if source.get('owner_id'):curators.add((p['rows'][i]['service'],str(source['owner_id'])))
        if len(notes)>1:reason='conflicting nonempty source notes'
        if len(curators)>1:reason='different known curators require purpose review'
        natives=[i for i in group if p['rows'][i]['kind']=='native']
        if len(natives)>1:reason='multiple native working collections require review'
        elif natives:
            native=natives[0];origin=json.loads(p['rows'][native]['provenance_json']).get('origin_collection')
            if native not in p['wrappers'] and origin not in group:reason='protected independent native work'
        if reason:skipped.append({'ids':[a,b],'reason':reason});continue
        parents[y]=x;members[x]=group
    groups=[]
    for cid,ids in members.items():
        if root(cid)!=cid or len(ids)<2:continue
        chosen=next((i for i in sorted(ids) if p['rows'][i]['kind']=='native'),None) or choose_source(p['rows'],ids)
        groups.append({'kind':'exact','ids':sorted(ids),'selected':chosen,'hashes':{i:digest(values[i]) for i in ids}})
    # Only the user-authorized accidental Prog 2024 concatenation receives this special presentation rule.
    merges=defaultdict(list)
    for r in lineage.relationships(db):
        if r['status']=='accepted' and r['relation']=='merged_from' and r['evidence'].get('exact_concatenation'):
            merges[r['destination_id']].append(r)
    for dest,links in merges.items():
        if dest in p['hidden'] or lineage.name_key(p['rows'][dest]['name'])!='prog 2024':continue
        src=links[0]['evidence'].get('merge_sources',[]);ids=set(src+[dest])
        if len(src)!=2 or set(src)!={r['source_id'] for r in links}:continue
        if ids&p['overrides'] or any(pair<=ids for pair in blocked):continue
        if any(json.loads(p['rows'][i]['provenance_json']).get('independent_use') for i in ids):continue
        if any([p['position'] for p in values[i]['positions']]!=list(range(len(values[i]['positions']))) for i in ids):continue
        if seq[src[0]] is None or seq[src[1]] is None or seq[src[0]]+seq[src[1]]!=seq[dest]:continue
        # A native work derived from the merged arrangement is concrete deliberate-use evidence.
        if any(json.loads(r['provenance_json']).get('origin_collection')==dest for r in p['rows'].values() if r['kind']=='native'):continue
        groups.append({'kind':'prog_split','ids':sorted(ids),'parents':src,'destination':dest,'hashes':{i:digest(values[i]) for i in ids}})
    return {'groups':groups,'blocked_pairs':skipped}


def choose_source(rows,ids):
    def rank(cid):
        r=rows[cid];p=json.loads(r['provenance_json']);s=p.get('source_snapshot',{})
        return (not bool(s.get('title') or p.get('verified_title')),not bool(s.get('description') or p.get('description')),r['name'].endswith('.csv'),cid)
    return min(ids,key=rank)


def display_name(row):
    p=json.loads(row['provenance_json']);name=p.get('source_snapshot',{}).get('title') or p.get('verified_title') or row['name']
    return re.sub(r'\s*\(\d+\)$','',re.sub(r'\.csv$','',name)).replace('_',' ')[:200]


def event(db,did,action,payload):
    db.execute('INSERT INTO collection_consolidation_events(decision_id,action,payload_json,created_at) VALUES (?,?,?,?)',(did,action,json.dumps(payload),stamp()))


def begin(db):
    if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
    init(db)


def apply_group(db,group,batch_id,mode='automatic',acknowledged=None,representative=None):
    begin(db)
    db.execute('SAVEPOINT consolidation_decision')
    try:
        result=_apply_group(db,group,batch_id,mode,acknowledged,representative)
        db.execute('RELEASE consolidation_decision')
        return result
    except Exception:
        db.execute('ROLLBACK TO consolidation_decision')
        db.execute('RELEASE consolidation_decision')
        raise


def _apply_group(db,group,batch_id,mode='automatic',acknowledged=None,representative=None):
    from . import library_collections
    begin(db);ids=group['ids'];key=digest({'kind':group['kind'],'ids':sorted(ids),'hashes':group['hashes'],'selected':group.get('selected'),'representative':representative})
    old=db.execute('SELECT * FROM collection_consolidations WHERE id=?',(key,)).fetchone()
    if old:return {'id':key,'status':old['status'],'idempotent':True,**json.loads(old['result_json'])}
    if any(fingerprint(db,cid)!=group['hashes'][cid] for cid in ids):raise ValueError('Stale collection contents; refresh the comparison')
    if mode=='automatic' and group['kind']=='exact':
        sequences=[sequence(snapshot(db,c)) for c in ids]
        if any(x is None or x!=sequences[0] for x in sequences):raise ValueError('Exact consolidation requires complete identical ordered sequences')
    p,blocked=constraints(db)
    if set(ids)&p['overrides'] or any(pair<=set(ids) for pair in blocked):raise ValueError('Protected keep-separate decision')
    if any(i in p['hidden'] for i in ids):raise ValueError('Presentation changed; refresh the comparison')
    created=[];reused=[];bindings=[];dispositions=[];absorbed=[]
    def native(source):
        if p['rows'][source]['kind']=='native':reused.append(source);return source
        # Only explicit derivation, exact current content, and no extra provenance/edits can be reused.
        candidates=[cid for cid in ids if p['rows'][cid]['kind']=='native' and json.loads(p['rows'][cid]['provenance_json']).get('origin_collection')==source and sequence(snapshot(db,cid))==sequence(snapshot(db,source))]
        if candidates:rep=sorted(candidates)[0];reused.append(rep);return rep
        result=library_collections.create(db,display_name(p['rows'][source]),source_id=source,detailed=False);rep=result['id']
        provenance=json.loads(db.execute('SELECT provenance_json FROM collections WHERE id=?',(rep,)).fetchone()[0])
        original=json.loads(p['rows'][source]['provenance_json'])
        provenance.update(selected_name_source=source,selected_order_source=source,description=original.get('source_snapshot',{}).get('description') or original.get('description'))
        db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps(provenance),rep))
        created.append(rep);return rep
    if group['kind']=='prog_split':
        dest=group['destination'];offset=0
        for source in group['parents']:
            rep=native(source);bindings.extend([(source,rep),(dest,rep)])
            for row in snapshot(db,source)['positions']:
                pos=row['position'];dispositions.extend([(source,pos,rep,pos,'represented'),(dest,pos+offset,rep,pos,'represented')])
            offset+=len(snapshot(db,source)['positions'])
        absorbed=[i for i in ids if i not in reused]
    else:
        source=group['selected'];rep=representative or native(source)
        if representative:
            if representative not in ids or p['rows'][representative]['kind']!='native':raise ValueError('Representative must be a selected native collection')
            reused.append(rep)
        target=snapshot(db,rep);by_rid=defaultdict(list)
        for row in target['positions']:by_rid[row['recording_id']].append(row['position'])
        acknowledged=set(acknowledged or [])
        for cid in ids:
            bindings.append((cid,rep));used=Counter()
            for row in snapshot(db,cid)['positions']:
                rid=row['recording_id'];n=used[rid];used[rid]+=1
                pos=by_rid[rid][n] if n<len(by_rid[rid]) else None
                if pos is None and f"{cid}:{row['position']}" not in acknowledged:raise ValueError('Every history-only occurrence requires explicit acknowledgement')
                dispositions.append((cid,row['position'],rep,pos,'represented' if pos is not None else 'historical_only'))
        absorbed=[i for i in ids if i!=rep]
    reps=created+reused
    # Membership origins make wrappers derived selections; raw sources and accepted lineage remain untouched.
    for rep in created:
        for row in db.execute('SELECT * FROM memberships WHERE collection_id=?',(rep,)).fetchall():
            origins=[{'collection_id':cid,'position':pos} for cid,pos,r,rpos,state in dispositions if r==rep and rpos==row['position'] and state=='represented']
            origin=json.loads(row['source_json']);origin['origins']=origins;origin['consolidation_id']=key
            db.execute('UPDATE memberships SET source_json=? WHERE collection_id=? AND position=?',(json.dumps(origin),rep,row['position']))
    result={'absorbed':absorbed,'created':created,'reused':reused,'representatives':reps,
            'historical_only':[{'source_id':c,'position':pos} for c,pos,r,rp,state in dispositions if state=='historical_only'],
            'representative_hashes':{r:fingerprint(db,r) for r in reps}}
    db.execute('INSERT INTO collection_consolidations VALUES (?,?,?,?,?,?,?,?)',(key,batch_id,mode,group['kind'],'active',json.dumps(group),json.dumps(result),stamp()))
    db.executemany('INSERT INTO collection_representation_bindings VALUES (?,?,?)',[(key,c,r) for c,r in bindings])
    db.executemany('INSERT INTO collection_position_dispositions VALUES (?,?,?,?,?,?)',[(key,*d) for d in dispositions])
    event(db,key,'apply',result)
    return {'id':key,**result}


def apply_automatic(db,batch_id=None):
    begin(db);batch_id=batch_id or 'auto:'+uuid.uuid4().hex;before=len(active_rows(db));results=[]
    # Prog split first; exact groups are recomputed afterwards to avoid stale presentation overlap.
    plan=automatic_plan(db)
    for g in plan['groups']:
        if g['kind']=='prog_split':results.append(apply_group(db,g,batch_id))
    for g in automatic_plan(db)['groups']:
        if g['kind']=='exact':results.append(apply_group(db,g,batch_id))
    return {'batch_id':batch_id,'before':before,'after':len(active_rows(db)),'decisions':results,'remaining_eligible':len(automatic_plan(db)['groups'])}


def undo(db,decision_id=None,batch_id=None):
    begin(db)
    if bool(decision_id)==bool(batch_id):raise ValueError('Select one decision or batch')
    rows=db.execute('SELECT * FROM collection_consolidations WHERE '+('id=?' if decision_id else 'batch_id=?'),(decision_id or batch_id,)).fetchall()
    if not rows:raise ValueError('Unknown consolidation')
    protected_edits=[]
    for row in rows:
        if row['status']!='active':continue
        result=json.loads(row['result_json'])
        protected_edits.extend(cid for cid in result.get('created',[]) if fingerprint(db,cid)!=result.get('representative_hashes',{}).get(cid))
        group=json.loads(row['baseline_json'])
        db.execute("UPDATE collection_consolidations SET status='undone' WHERE id=?",(row['id'],))
        for cid in group['ids']:db.execute('INSERT OR REPLACE INTO collection_presentation_overrides VALUES (?,?,?)',(cid,row['id'],'undo'))
        event(db,row['id'],'undo',{'protected_native_edits':protected_edits})
    return {'undone':[r['id'] for r in rows],'active':len(active_rows(db)),'protected_native_edits':sorted(set(protected_edits))}


def restore(db,cid):
    begin(db)
    if not db.execute('SELECT 1 FROM collections WHERE id=?',(cid,)).fetchone():raise ValueError('Unknown collection')
    db.execute('INSERT OR REPLACE INTO collection_presentation_overrides VALUES (?,?,?)',(cid,'restore:'+cid,'restored_as_distinct'))
    event(db,'restore:'+cid,'restore',{'collection_id':cid})
    return {'id':cid,'active':True}


def history(db,cid):
    p=projection(db)
    if cid not in p['rows']:return None
    decisions=[]
    if installed(db):
        for r in db.execute('SELECT DISTINCT d.* FROM collection_consolidations d JOIN collection_representation_bindings b ON b.decision_id=d.id WHERE b.source_id=? OR b.representative_id=?',(cid,cid)):
            v=dict(r);v['result']=json.loads(v.pop('result_json'));v['baseline']=json.loads(v.pop('baseline_json'));decisions.append(v)
    source_ids={cid}
    for d in decisions:source_ids.update(d['baseline']['ids'])
    return {'id':cid,'absorbed':cid in p['hidden'],'representative_ids':sorted(p['mapping'][cid]),'decisions':decisions,
            'sources':[p['rows'][i] for i in sorted(source_ids) if i not in p['wrappers']],
            'note':'Presentation decisions do not alter historical lineage or recording identities.'}


def review_groups(db):
    p=projection(db);adj=defaultdict(set)
    covered=[]
    if installed(db):
        covered=[set(json.loads(r[0])['ids']) for r in db.execute("SELECT baseline_json FROM collection_consolidations WHERE status='active' AND action='prog_split'")]
    for r in lineage.relationships(db):
        if any({r['source_id'],r['destination_id']}<=ids for ids in covered):continue
        if r['status'] in {'retired','rejected'}:continue
        for a in p['mapping'][r['source_id']]:
            for b in p['mapping'][r['destination_id']]:
                if a!=b:adj[a].add(b);adj[b].add(a)
    groups=[];seen=set()
    for start in sorted(adj):
        if start in seen:continue
        todo=[start];ids=set()
        while todo:
            cid=todo.pop()
            if cid in ids:continue
            ids.add(cid);todo.extend(adj[cid]-ids)
        seen.update(ids)
        hashes={i:fingerprint(db,i) for i in ids};key=digest(sorted(ids))
        state='needs_review'
        if ids<=p['overrides']:state='kept_separate'
        if installed(db):
            prior=db.execute('SELECT action,baseline_json FROM collection_consolidations WHERE id=?',('review:'+digest(hashes),)).fetchone()
            if prior:state='kept_separate' if prior['action']=='keep_separate' else prior['action']
        groups.append({'id':key,'ids':sorted(ids),'hashes':hashes,'state':state,'selected':choose_source(p['rows'],ids),
                       'sources':[p['rows'][i] for i in sorted(ids)],'potential_reduction':len(ids)-1})
    return groups


def preview(db,ids,selected):
    if len(set(ids))<2 or selected not in ids:raise ValueError('Select a group and representative source')
    values=lineage.observations(db);p=projection(db)
    if any(i in p['hidden'] for i in ids):raise ValueError('Refresh: group presentation changed')
    target=values[selected];comparisons=[];historical=[]
    for cid in ids:
        if cid==selected:continue
        # Presentation correspondence intentionally never claims migration/substitution truth.
        lines=lineage.alignment(values[cid],target,False)
        comparisons.append({'source_id':cid,'summary':lineage.summary(values[cid],target),'positions':[r for r in lines if r['classification']!='shared_recording']})
        counts=Counter(target['sequence'])
        for row in values[cid]['positions']:
            rid=row['recording_id']
            if counts[rid]:counts[rid]-=1
            else:historical.append({'key':f"{cid}:{row['position']}",'source_id':cid,**row})
    return {'ids':ids,'selected':selected,'hashes':{i:fingerprint(db,i) for i in ids},'comparisons':comparisons,
            'historical_only':historical,'potential_reduction':len(ids)-1,'chronology_note':'Dates are observations, not proof that a longer playlist is newer.'}


def review(db,ids,hashes,action,selected=None,acknowledged=None):
    begin(db)
    if len(set(ids))<2 or len(ids)!=len(set(ids)):raise ValueError('Select at least two distinct collections')
    if any(fingerprint(db,cid)!=hashes.get(cid) for cid in ids):raise ValueError('Stale comparison; refresh')
    if action in {'keep_separate','defer'}:
        key='review:'+digest(hashes)
        db.execute('INSERT OR REPLACE INTO collection_consolidations VALUES (?,?,?,?,?,?,?,?)',(key,'human','human',action,'reviewed',json.dumps({'ids':ids,'hashes':hashes}),json.dumps({}),stamp()))
        if action=='keep_separate':
            for cid in ids:db.execute('INSERT OR REPLACE INTO collection_presentation_overrides VALUES (?,?,?)',(cid,key,action))
        event(db,key,action,{'ids':ids});return {'id':key}
    if action!='representative' or selected not in ids:raise ValueError('Invalid review action')
    return apply_group(db,{'kind':'reviewed_representative','ids':ids,'selected':selected,'hashes':hashes},'human:'+uuid.uuid4().hex,'human',acknowledged,selected if db.execute('SELECT kind FROM collections WHERE id=?',(selected,)).fetchone()[0]=='native' else None)
