from collections import Counter
import json
import pytest
from app.services import collection_lineage as l,library_completeness as c,library_collections as collections,recovery_prioritization as recovery
from .test_completeness import fixture_algebra


def observation(sid,seq,service='spotify',account='account1',name='Playlist',dates=None):
    dates=dates or [None]*len(seq)
    return {'id':sid,'name':name,'key':l.name_key(name),'service':service,'provenance':{'account':account},'sequence':seq,'multiset':Counter(seq),
            'days':Counter(d[:10] for d in dates if d),'positions':[{'position':i,'entity_id':f'{sid}:{i}','recording_id':r,'added_at':dates[i],'artist':'Artist','title':r} for i,r in enumerate(seq)]}


def test_exact_route_and_dates_are_not_origin():
    a=observation('a',['r1','r2']);b=observation('b',['r1','r2'],account='account2',dates=['2026-04-10','2026-04-10'])
    kind,status,confidence,evidence=l.candidate(a,b)
    assert (kind,status)==('migrated_from','accepted') and confidence==1
    assert evidence['dates_do_not_establish_origin']
    b['sequence']=['other','different'];b['multiset']=Counter(b['sequence'])
    assert l.candidate(a,b)[:2]==('unrelated','proposed')


def test_subsequence_extension_does_not_invent_chronology():
    a=observation('a',['r1','r2','r3'],account='account2',dates=['2026-09-09']*3)
    b=observation('b',['r1','extra','r2','r3'],account='account2',dates=['2026-04-10']*4)
    kind,status,_,e=l.candidate(a,b)
    assert kind=='descendant_of' and status=='proposed' and e['ordered_subsequence']
    assert not e.get('later_additions',False)
    a=observation('a',['r1','r2','r3']);b=observation('b',['r1','r2','r3','extra'],account='account2',dates=['2026-04-10']*3+['2026-09-09'])
    assert l.candidate(a,b)[:2]==('descendant_of','accepted')


def test_alignment_missing_substitution_addition_reorder_no_identity_mutation():
    a=observation('a',['r1','source','r2','missing','r3'],service='soundcloud')
    b=observation('b',['r1','wrong','r2','r3','extra'],account='account2')
    rows=l.alignment(a,b,accepted=True);kinds=[r['classification'] for r in rows]
    assert 'likely_wrong_substitution' in kinds and 'missing_destination' in kinds and 'destination_only_addition' in kinds
    assert 'likely_wrong_substitution' not in [r['classification'] for r in l.alignment(a,b,accepted=False)]
    wrong=next(r for r in rows if r['classification']=='likely_wrong_substitution')
    assert wrong['source'][0]['recording_id']!=wrong['destination'][0]['recording_id']
    moved=observation('b',['r2','r1','source','missing','r3'],account='account2')
    assert 'reordered_or_repeated' in [r['classification'] for r in l.alignment(a,moved,accepted=True)]


def merge_catalog(tmp_path):
    db,_,_=fixture_algebra(tmp_path);db.execute('DELETE FROM memberships');db.execute('DELETE FROM collections')
    groups=[('A',['local:1','spotify:track:b'],'account1'),('B',['local:1','soundcloud:tracks:4'],'account1'),('D',['local:1','spotify:track:b','local:1','soundcloud:tracks:4'],'account2')]
    ids={}
    for name,seq,account in groups:
        v=collections.create(db,'Prog 2024',entity_ids=seq);ids[name]=v['id']
        db.execute('UPDATE collections SET service="spotify",kind="playlist",provenance_json=? WHERE id=?',(json.dumps({'account':account}),v['id']))
    return db,ids


def test_merge_preserves_independent_parent_selections_and_sources(tmp_path):
    db,ids=merge_catalog(tmp_path)
    before={t:[tuple(r) for r in db.execute('SELECT * FROM '+t)] for t in ('entities','memberships','collections')}
    result=l.infer(db)
    assert result['merge_edges']==2 and result['merge_destinations']==1
    v=c.index(db)['local:1']
    assert v['raw_collection_occurrences']==4 and v['source_collection_count']==3 and v['collection_family_count']==2
    for t,rows in before.items():assert rows==[tuple(r) for r in db.execute('SELECT * FROM '+t)]
    event_count=db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]
    l.infer(db)
    assert db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]==event_count
    for r in l.relationships(db):
        if r['relation']=='merged_from':l.decide(db,r['id'],'reject')
    assert c.index(db)['local:1']['collection_family_count']==3
    l.infer(db)
    assert c.index(db)['local:1']['collection_family_count']==3  # human rejections survive refresh


def test_explicit_intent_presets_and_snapshot_save(tmp_path):
    db,ids=merge_catalog(tmp_path);l.infer(db)
    assert recovery.view(db)['total']==0  # remote-only is not wanted
    assert recovery.view(db,preset='discovery')['total']==3
    assert recovery.view(db,preset='strong_interest',minimum_families=1)['total']==2
    c.recover(db,'spotify:track:b','wanted')
    assert recovery.view(db)['total']==1
    before=db.execute('SELECT count(*) FROM recording_recovery').fetchone()[0]
    result=recovery.view(db,preset='strong_interest',minimum_families=1,save_name='Selected recommendation')
    assert result['saved_collection_id']
    assert db.execute('SELECT count(*) FROM recording_recovery').fetchone()[0]==before
    assert json.loads(db.execute('SELECT provenance_json FROM collections WHERE id=?',(result['saved_collection_id'],)).fetchone()[0])['acquisition_intent']=='not_implied'


def test_singleton_exact_is_not_auto_confirmed():
    a=observation('a',['one'],service='soundcloud');b=observation('b',['one'],account='account2')
    assert l.candidate(a,b)[1]=='proposed'


def test_cycle_rejected(tmp_path):
    db,ids=merge_catalog(tmp_path);l.infer(db)
    r=next(r for r in l.relationships(db) if r['relation']=='merged_from')
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('reverse',r['destination_id'],r['source_id'],'descendant_of','proposed',.9,'{}','inferred','now'))
    with pytest.raises(ValueError,match='cycle'):l.decide(db,'reverse','accept')


def test_lineage_and_priority_api(tmp_path,monkeypatch):
    import sqlite3
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db,ids=merge_catalog(tmp_path);l.infer(db);db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router);client=TestClient(app)
    rows=client.get('/identity/lineage').json()['items'];edge=next(r for r in rows if r['relation']=='merged_from')
    detail=client.get('/identity/lineage/detail',params={'id':edge['id']}).json()
    assert detail['evidence']['exact_concatenation']
    assert client.post('/identity/recovery-priorities',json={}).json()['total']==0
    preview=client.post('/identity/recovery-priorities',json={'preset':'discovery','filters':{'q':'remote_only'}}).json()
    assert preview['total']==2 and preview['intent']=='catalog_discovery'
    assert client.post('/identity/recovery-priorities',json={'filters':{'minimum':-1}}).status_code==422
    saved=client.post('/identity/recovery-priorities',json={'preset':'strong_interest','minimum_families':1,'save_name':'API recommendation'}).json()
    assert saved['saved_collection_id']
    history=client.get('/identity/lineage/history',params={'recording_id':'local:1'}).json()
    assert history['source_collection_count']==3 and history['collection_family_count']==2
    assert client.post('/identity/lineage/decision',json={'id':edge['id'],'action':'reject'}).status_code==200


def test_human_unrelated_preserves_independent_selections(tmp_path):
    db,a,_=fixture_algebra(tmp_path)
    duplicate=collections.create(db,'A',source_id=a)
    l.infer(db)
    edge=next(r for r in l.relationships(db) if r['source_id']==a and r['destination_id']==duplicate['id'])
    before=c.index(db)['spotify:track:b']['collection_family_count']
    l.decide(db,edge['id'],'accept','unrelated')
    assert c.index(db)['spotify:track:b']['collection_family_count']==before+1
    l.infer(db)
    assert next(r for r in l.relationships(db) if r['id']==edge['id'])['relation']=='unrelated'


def test_later_edit_is_not_labelled_historical_wrong_substitution():
    a=observation('a',['r1','original','r2'],service='soundcloud')
    b=observation('b',['r1','changed','r2'],account='account2',dates=['2026-04-10','2026-09-09','2026-04-10'])
    assert 'likely_wrong_substitution' not in [r['classification'] for r in l.alignment(a,b,True)]


def test_recommendation_snapshot_does_not_inflate_family_interest(tmp_path):
    db,ids=merge_catalog(tmp_path);l.infer(db)
    before=c.index(db)['spotify:track:b']
    recovery.view(db,preset='strong_interest',minimum_families=1,save_name='Recommendation snapshot')
    after=c.index(db)['spotify:track:b']
    assert after['source_collection_count']==before['source_collection_count']+1
    assert after['collection_family_count']==before['collection_family_count']


def test_user_confirmed_likes_history_does_not_require_current_equality(tmp_path):
    db,a,b=fixture_algebra(tmp_path)
    for cid,account in [(a,'account1'),(b,'account2')]:db.execute('UPDATE collections SET kind="likes",service="spotify",provenance_json=? WHERE id=?',(json.dumps({'account':account}),cid))
    l.infer(db)
    edge=next(r for r in l.relationships(db) if r['source_id']==a and r['destination_id']==b)
    assert edge['status']=='accepted' and edge['relation']=='migrated_from'
    assert edge['evidence']['user_confirmed_history'] and not edge['evidence']['exact_ordered']
