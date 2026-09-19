"""Read-only real-library milestone checks; no matching/promotion or source edits."""
import hashlib,json,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from app.services import identity_library,library_completeness as c,collection_intelligence as algebra,library_collections
OUT=Path(__file__).parent/'identity'/'completeness'
with identity_library.connect() as db:
    started=time.monotonic();rows=c.index(db)
    report={'metrics':c.metrics(rows),'index_seconds':round(time.monotonic()-started,3),'collections':[]}
    summer=db.execute("SELECT id FROM collections WHERE name='Summer 2023 — CrateMind'").fetchone()[0]
    selected=[summer,'sc:20260913T225252Z:likes','78ee9071c441172331528fca9db04563de1ef9f35381dd0b10496f187a6648c3']
    for cid in selected:
        positions=algebra.positions(db,cid)
        counts={'total':len(positions),'playable':0,'remote_only':0,'missing':0,'unresolved':0}
        for p in positions:
            a=rows[p['recording_id']]['availability'];key='playable' if a['playable'] else 'missing' if a['missing_file'] else 'remote_only' if a['remote_only'] else 'unresolved';counts[key]+=1
        assert sum(v for k,v in counts.items() if k!='total')==counts['total']
        actual=[(p['position'],p['entity_id']) for p in positions]
        expected=[tuple(r) for r in db.execute('SELECT position,entity_id FROM memberships WHERE collection_id=? ORDER BY position',(cid,))]
        assert actual==expected
        report['collections'].append({'id':cid,**counts,'order_preserved':True})
    assert report['collections'][0]=={'id':summer,'total':20,'playable':16,'remote_only':4,'missing':0,'unresolved':0,'order_preserved':True}
    result=algebra.algebra(db,[summer],'union',True)
    assert result['total']==4
    report['summer_missing']=[{'id':r['recording_id'],'artist':r['artist'],'title':r['title']} for r in result['items']]
    report['examples']={key:next({'id':v['recording_id'],'artist':v['artist'],'title':v['title'],'availability':v['availability']} for v in rows.values() if predicate(v)) for key,predicate in {
        'all_three':lambda v:v['availability']['playable'] and v['availability']['providers']==['soundcloud','spotify'],
        'provider_only':lambda v:v['availability']['remote_only'],
        'missing_local_file':lambda v:v['availability']['missing_file']}.items()}
    before=json.loads((OUT/'before.json').read_text())
    report['preserved']={table:hashlib.sha256(repr([tuple(r) for r in db.execute(f'SELECT * FROM {table} ORDER BY rowid')]).encode()).hexdigest()==digest for table,digest in before.items() if table!='scorer'}
    report['preserved']['scorer']=hashlib.sha256((Path(__file__).resolve().parents[1]/'backend/app/services/identity_matching.py').read_bytes()).hexdigest()==before['scorer']
    assert all(report['preserved'].values()),report['preserved']
    report['integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
    assert report['integrity']=='ok'
    (OUT/'validation.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    print(json.dumps(report,indent=2,ensure_ascii=False))
