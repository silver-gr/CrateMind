import json
import sqlite3
import pytest
from app.services import collection_consolidation as c, library_collections as lib, collection_lineage as lineage, library_completeness as completeness, identity_library
from .test_completeness import fixture_algebra
from .test_collection_lineage import merge_catalog


def exact_fixture(tmp_path):
    db,a,b=fixture_algebra(tmp_path)
    db.execute("UPDATE collections SET kind='source_snapshot',service='spotify' WHERE id=?",(a,))
    copy=lib.create(db,'A (1).csv',source_id=a)['id']
    db.execute("UPDATE collections SET kind='source_snapshot',service='spotify' WHERE id=?",(copy,))
    lineage.init(db)
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('copy',a,copy,'exact_copy_of','accepted',1,'{}','inferred','now'))
    return db,a,copy


def test_exact_repeats_aliases_idempotency_sources_and_families(tmp_path):
    db,a,b=exact_fixture(tmp_path);before={i:c.snapshot(db,i) for i in (a,b)}
    counts={r:(v['collection_family_count'],v['source_collection_count'],v['raw_collection_occurrences']) for r,v in completeness.index(db).items()}
    n=len(c.active_rows(db));result=c.apply_automatic(db,'test');assert result['after']==n-1
    rep=result['decisions'][0]['representatives'][0]
    assert len(c.snapshot(db,rep)['positions'])==3
    assert len(c.active_rows(db,q='A (1).csv'))==1
    assert next(r for r in identity_library.collections(db) if r['id']==rep)['aliases']==['A','A (1).csv']
    assert len(c.active_rows(db,service='spotify',q='A (1).csv'))==1
    assert c.history(db,a)['representative_ids']==[rep]
    assert c.apply_automatic(db,'again')['decisions']==[]
    assert db.execute('SELECT count(*) FROM collection_position_dispositions').fetchone()[0]==6
    assert before=={i:c.snapshot(db,i) for i in (a,b)}
    assert counts=={r:(v['collection_family_count'],v['source_collection_count'],v['raw_collection_occurrences']) for r,v in completeness.index(db).items()}
    assert c.projection(db)['hidden'] >= {a,b}


def test_prog_two_parents_and_shared_merge_origins(tmp_path):
    db,ids=merge_catalog(tmp_path);lineage.infer(db)
    old={i:c.snapshot(db,i) for i in ids.values()};result=c.apply_automatic(db,'prog')
    d=next(r for r in result['decisions'] if len(r['representatives'])==2)
    assert result['after']==2 and len(d['absorbed'])==3
    assert len(c.history(db,ids['D'])['representative_ids'])==2
    assert old=={i:c.snapshot(db,i) for i in ids.values()}
    assert db.execute('SELECT count(*) FROM collection_position_dispositions WHERE source_id=?',(ids['D'],)).fetchone()[0]==4


def test_stale_atomicity_review_ack_and_order(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    group=c.automatic_plan(db)['groups'][0]
    db.execute('UPDATE collections SET name="changed" WHERE id=?',(a,))
    with pytest.raises(ValueError,match='Stale'):c.apply_group(db,group,'stale')
    assert db.execute('SELECT count(*) FROM collection_consolidations').fetchone()[0]==0
    db.execute('UPDATE memberships SET entity_id="soundcloud:tracks:4" WHERE collection_id=? AND position=1',(b,))
    assert not c.automatic_plan(db)['groups']
    p=c.preview(db,[a,b],a);assert len(p['historical_only'])==1
    before=db.execute('SELECT count(*) FROM collections').fetchone()[0]
    with pytest.raises(ValueError,match='acknowledgement'):c.review(db,[a,b],p['hashes'],'representative',a,[])
    assert db.execute('SELECT count(*) FROM collections').fetchone()[0]==before
    r=c.review(db,[a,b],p['hashes'],'representative',a,[x['key'] for x in p['historical_only']]);assert len(r['historical_only'])==1


def test_keep_separate_is_component_constraint(tmp_path):
    db,a,b=exact_fixture(tmp_path);z=lib.create(db,'A',source_id=a)['id']
    db.execute("UPDATE collections SET kind='source_snapshot' WHERE id=?",(z,))
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('z',b,z,'exact_copy_of','accepted',1,'{}','inferred','now'))
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('block',a,z,'unrelated','accepted',1,'{}','human','now'))
    groups=c.automatic_plan(db)['groups'];assert not any({a,z}<=set(g['ids']) for g in groups)
    c.restore(db,a);assert not any(a in g['ids'] for g in c.automatic_plan(db)['groups'])


def test_undo_preserves_edits_restore_and_restart(tmp_path):
    db,a,b=exact_fixture(tmp_path);result=c.apply_automatic(db,'undo');rep=result['decisions'][0]['representatives'][0]
    lib.append(db,rep,['soundcloud:tracks:4']);c.undo(db,batch_id='undo')
    assert rep in {r['id'] for r in c.active_rows(db)}
    assert len(c.snapshot(db,rep)['positions'])==4
    assert a in {r['id'] for r in c.active_rows(db)} and not c.automatic_plan(db)['groups']
    db.commit();path=tmp_path/'restart.sqlite'
    with sqlite3.connect(path) as dest:db.backup(dest)
    restarted=sqlite3.connect(path);restarted.row_factory=sqlite3.Row
    assert {r['id'] for r in c.active_rows(db)}=={r['id'] for r in c.active_rows(restarted)}


def test_undo_unedited_and_individual_restore(tmp_path):
    db,a,b=exact_fixture(tmp_path);result=c.apply_automatic(db,'undo');rep=result['decisions'][0]['representatives'][0]
    c.restore(db,a);assert a in {r['id'] for r in c.active_rows(db)} and b not in {r['id'] for r in c.active_rows(db)}
    c.undo(db,batch_id='undo');assert rep not in {r['id'] for r in c.active_rows(db)}
    assert not c.automatic_plan(db)['groups']


def test_different_order_subset_and_null_placeholders_are_not_automatic(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute('UPDATE memberships SET entity_id="spotify:track:b" WHERE collection_id=? AND position=0',(b,))
    db.execute('UPDATE memberships SET entity_id="local:1" WHERE collection_id=? AND position=1',(b,))
    assert not c.automatic_plan(db)['groups']
    db.execute('DELETE FROM memberships WHERE collection_id=? AND position=2',(b,));db.execute('UPDATE collections SET track_count=2 WHERE id=?',(b,))
    assert not c.automatic_plan(db)['groups']
    fake={'collection':{'track_count':1},'positions':[{'entity_id':'unknown:slot1','recording_id':'fake'}]}
    assert c.sequence(fake) is None


def test_new_unchanged_observation_reuses_existing_rep(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    provenance=json.dumps({'source_remote_id':'123','account':'account1'})
    db.execute('UPDATE collections SET provenance_json=? WHERE id IN (?,?)',(provenance,a,b))
    result=c.apply_automatic(db,'first');rep=result['decisions'][0]['representatives'][0]
    imported=lib.create(db,'A import',source_id=a)['id']
    db.execute("UPDATE collections SET kind='source_snapshot',service='spotify',provenance_json=? WHERE id=?",(provenance,imported))
    next_batch=c.apply_automatic(db,'second');assert next_batch['decisions'][0]['reused']==[rep]
    assert not next_batch['decisions'][0]['created'] and c.history(db,imported)['representative_ids']==[rep]


def test_api_reads_active_alias_original_and_mutations_isolated(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db,a,b=exact_fixture(tmp_path);result=c.apply_automatic(db,'api');rep=result['decisions'][0]['representatives'][0];db.commit()
    path=tmp_path/'api.sqlite'
    with sqlite3.connect(path) as target:db.backup(target)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path));app=FastAPI();app.include_router(router);client=TestClient(app)
    browser=client.get('/identity/collection-browser',params={'q':'A (1).csv'}).json();assert browser['total']==1 and browser['items'][0]['id']==rep
    selector=client.get('/identity/collections').json();assert a not in {r['id'] for r in selector} and b not in {r['id'] for r in selector}
    assert client.get('/identity/collection',params={'id':a}).json()['id']==rep
    assert client.get('/identity/collection',params={'id':a,'original':True}).json()['id']==a
    assert client.get('/identity/collection-browser',params={'all_sources':True,'q':'A (1).csv'}).json()['items'][0]['id']==b
    assert client.post('/identity/collections/consolidation/restore',json={'id':a}).status_code==200
    assert a in {r['id'] for r in client.get('/identity/collections').json()}
    assert client.post('/identity/collections/consolidation/undo',json={'batch_id':'api'}).status_code==200
    assert rep not in {r['id'] for r in client.get('/identity/collections').json()}


def test_incomplete_short_and_protected_native_work(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute('UPDATE collections SET track_count=4 WHERE id=?',(b,));assert not c.automatic_plan(db)['groups']
    db.execute('UPDATE collections SET track_count=3 WHERE id=?',(b,))
    db.execute('DELETE FROM memberships WHERE collection_id IN (?,?) AND position>0',(a,b));db.execute('UPDATE collections SET track_count=1 WHERE id IN (?,?)',(a,b))
    assert not c.automatic_plan(db)['groups']
    c.init(db);provenance=json.dumps({'source_remote_id':'123','account':'account1'})
    db.execute('UPDATE collections SET provenance_json=? WHERE id IN (?,?)',(provenance,a,b));assert c.automatic_plan(db)['groups']
    db.execute('UPDATE collections SET kind="native",provenance_json=? WHERE id=?',(json.dumps({'independent_use':True}),b));assert not c.automatic_plan(db)['groups']


def test_changed_import_stays_active_and_human_defer_keeps_contents(tmp_path):
    db,a,b=exact_fixture(tmp_path);c.apply_automatic(db,'first')
    imported=lib.create(db,'Different snapshot',source_id=a)['id'];lib.append(db,imported,['soundcloud:tracks:4'])
    db.execute('UPDATE collections SET kind="source_snapshot" WHERE id=?',(imported,))
    assert imported in {r['id'] for r in c.active_rows(db)}
    rep=c.history(db,a)['representative_ids'][0];p=c.preview(db,[imported,rep],rep)
    before=[tuple(r) for r in db.execute('SELECT * FROM memberships')]
    c.review(db,[imported,rep],p['hashes'],'defer');assert before==[tuple(r) for r in db.execute('SELECT * FROM memberships')]
    assert imported in {r['id'] for r in c.active_rows(db)}


def test_undo_earlier_batch_keeps_reused_rep_in_later_batch(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    provenance=json.dumps({'source_remote_id':'123','account':'account1'})
    db.execute('UPDATE collections SET provenance_json=? WHERE id IN (?,?)',(provenance,a,b))
    first=c.apply_automatic(db,'first');rep=first['decisions'][0]['representatives'][0]
    imported=lib.create(db,'A import',source_id=a)['id']
    db.execute("UPDATE collections SET kind='source_snapshot',service='spotify',provenance_json=? WHERE id=?",(provenance,imported))
    c.apply_automatic(db,'second');c.undo(db,batch_id='first')
    assert c.history(db,imported)['representative_ids']==[rep]
    assert rep in {r['id'] for r in c.active_rows(db)}


def test_conflicting_source_notes_and_known_curators_require_review(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({'description':'Deliberate opening set'}),a))
    db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({'description':'Different deliberate purpose'}),b))
    assert not c.automatic_plan(db)['groups']
    for cid,owner in [(a,123),(b,456)]:db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({'source_snapshot':{'owner_id':owner}}),cid))
    assert not c.automatic_plan(db)['groups']


def test_singleton_explicit_native_derivation_reuses_working_collection(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute('DELETE FROM memberships WHERE collection_id IN (?,?) AND position>0',(a,b));db.execute('UPDATE collections SET track_count=1 WHERE id IN (?,?)',(a,b))
    db.execute('UPDATE collections SET kind="native",provenance_json=? WHERE id=?',(json.dumps({'origin_collection':a}),b))
    result=c.apply_automatic(db,'short-explicit')
    assert result['decisions'][0]['reused']==[b] and not result['decisions'][0]['created']


def test_three_observation_repeated_migration_is_one_choice(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    third=lib.create(db,'A (2).csv',source_id=a)['id']
    db.execute('UPDATE collections SET service="spotify",kind="source_snapshot",provenance_json=? WHERE id=?',(json.dumps({'account':'account2','observed_at':'2026-09-09'}),third))
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('repeat',b,third,'migrated_from','accepted',1,'{}','inferred','now'))
    result=c.apply_automatic(db,'repeated');d=result['decisions'][0]
    assert len(d['absorbed'])==3 and len(d['created'])==1 and result['before']-result['after']==2
    assert len(c.active_rows(db,q='A (2).csv'))==1
    assert len(c.history(db,d['created'][0])['sources'])==3
    assert len(c.snapshot(db,d['created'][0])['positions'])==3


def test_review_ignores_unrelated_and_does_not_bridge_human_blocks(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute("UPDATE collection_relationships SET relation='unrelated'")
    assert c.review_groups(db)==[]
    db.execute("UPDATE collection_relationships SET relation='exact_copy_of'")
    z=lib.create(db,'A third',source_id=a)['id']
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('third',b,z,'exact_copy_of','accepted',1,'{}','inferred','now'))
    db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',('human',a,z,'unrelated','accepted',1,'{}','human','now'))
    assert not any({a,z}<=set(g['ids']) for g in c.review_groups(db))


def test_year_semantics_and_explicit_native_copy_without_lineage(tmp_path):
    assert lineage.name_key('Prog (2024) (1).csv')==lineage.name_key('Prog 2024')
    assert lineage.name_key('Prog (2024)')!=lineage.name_key('Prog (2025)')
    db,a,b=exact_fixture(tmp_path)
    db.execute('DELETE FROM collection_relationships')
    native=lib.create(db,'Prog (2024)',source_id=a)['id']
    assert any(set(g['ids'])=={a,native} for g in c.automatic_plan(db)['groups'])
    assert c.display_name({'name':'Prog (2024) (1).csv','provenance_json':'{}'})=='Prog (2024)'
    before={i:c.snapshot(db,i) for i in (a,b)}
    result=c.refresh_derived(db,'refresh')
    assert result['consolidation']['decisions']
    assert before=={i:c.snapshot(db,i) for i in (a,b)}
    event_count=db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]
    assert c.refresh_derived(db,'again')['consolidation']['decisions']==[]
    assert db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]==event_count


def test_direct_native_copy_protects_human_intent_and_order(tmp_path):
    db,a,b=exact_fixture(tmp_path);db.execute('DELETE FROM collection_relationships')
    native=lib.create(db,'A',source_id=a)['id']
    for metadata in ({'independent_use':True},{'keep_separate':True}):
        db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({'origin_collection':a,**metadata}),native))
        assert c.automatic_plan(db)['groups']==[]
    db.execute('UPDATE collections SET provenance_json=? WHERE id=?',(json.dumps({'origin_collection':a}),native))
    lib.append(db,native,['soundcloud:tracks:4'])
    assert c.automatic_plan(db)['groups']==[]


def test_grouped_browser_preserves_same_name_distinct_and_all_variants(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    distinct=lib.create(db,'A',entity_ids=['soundcloud:tracks:4'])['id']
    result=lib.list_collections(db,grouped=True,limit=1)
    assert result['collection_total']==len(c.active_rows(db))
    all_groups=lib.list_collections(db,grouped=True)['items']
    grouped=next(r for r in all_groups if r.get('related_variants'))
    assert {grouped['id'],*(v['id'] for v in grouped['related_variants'])}=={a,b}
    assert distinct in {r['id'] for r in all_groups}
    assert lib.list_collections(db,all_sources=True,grouped=True)['total']==len(c.active_rows(db,all_sources=True))
    c.review(db,[a,b],{i:c.fingerprint(db,i) for i in (a,b)},'keep_separate')
    assert all(not r.get('related_variants') for r in lib.list_collections(db,grouped=True)['items'])



def test_refresh_source_only_is_noop_on_second_run_and_reports_original_badges(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    sources={i:c.snapshot(db,i) for i in (a,b)}
    c.refresh_derived(db,'first')
    row=next(r for r in c.active_rows(db) if r['id'] in c.projection(db)['wrappers'])
    assert row['source_services']==['spotify']
    before=[tuple(r) for r in db.execute('SELECT * FROM collection_relationships ORDER BY id')]
    event_count=db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]
    assert c.refresh_derived(db,'second')['consolidation']['decisions']==[]
    assert before==[tuple(r) for r in db.execute('SELECT * FROM collection_relationships ORDER BY id')]
    assert event_count==db.execute('SELECT count(*) FROM collection_relationship_events').fetchone()[0]
    assert sources=={i:c.snapshot(db,i) for i in (a,b)}


def test_inferred_refresh_preserves_arbitrary_human_relationship_ids(tmp_path):
    db,a,b=exact_fixture(tmp_path)
    db.execute("UPDATE collection_relationships SET decision_mode='human',relation='unrelated'")
    before=dict(db.execute('SELECT * FROM collection_relationships').fetchone())
    c.refresh_derived(db,'protected')
    assert before==dict(db.execute('SELECT * FROM collection_relationships WHERE id=?',(before['id'],)).fetchone())
    assert not c.automatic_plan(db)['groups']


def test_review_groups_rank_current_exact_subset_and_overlap(tmp_path):
    db,_,_=exact_fixture(tmp_path)
    db.execute('DELETE FROM collection_relationships')
    pairs=[('overlap',['local:1','spotify:track:b'],['spotify:track:b','soundcloud:tracks:4']),
           ('subset',['local:1'],['local:1','spotify:track:b']),
           ('exact',['local:1','spotify:track:b'],['local:1','spotify:track:b'])]
    for name,left,right in pairs:
        a=lib.create(db,name,entity_ids=left,detailed=False)['id']
        b=lib.create(db,name,entity_ids=right,detailed=False)['id']
        db.execute('INSERT INTO collection_relationships VALUES (?,?,?,?,?,?,?,?,?)',(name,a,b,'possible_version_of','proposed',.8,'{}','inferred','now'))
    groups=c.review_groups(db)
    assert [g['relationship_kind'] for g in groups]==['exact','subset','overlap']
    assert all(g['hashes'] for g in groups)
    assert all(g['hashes']=={} for g in c.review_groups(db,include_hashes=False))


def test_refresh_rolls_back_inference_when_consolidation_fails(tmp_path,monkeypatch):
    db,a,b=exact_fixture(tmp_path)
    before=[tuple(r) for r in db.execute('SELECT * FROM collection_relationships ORDER BY id')]
    sources={i:c.snapshot(db,i) for i in (a,b)}
    def fail(*args,**kwargs):raise RuntimeError('injected')
    monkeypatch.setattr(c,'apply_group',fail)
    with pytest.raises(RuntimeError,match='injected'):c.refresh_derived(db,'rollback')
    assert before==[tuple(r) for r in db.execute('SELECT * FROM collection_relationships ORDER BY id')]
    assert sources=={i:c.snapshot(db,i) for i in (a,b)}


def test_grouped_api_is_read_only_and_keeps_variants_reachable(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db,a,b=exact_fixture(tmp_path);db.commit();path=tmp_path/'grouped-api.sqlite'
    with sqlite3.connect(path) as target:db.backup(target)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router);client=TestClient(app)
    flat=client.get('/identity/collection-browser').json()
    grouped=client.get('/identity/collection-browser',params={'grouped':True}).json()
    assert grouped['total']==flat['total']-1
    row=next(row for row in grouped['items'] if row.get('related_variants'))
    assert {row['id'],*(variant['id'] for variant in row['related_variants'])}=={a,b}
    for cid in (a,b):assert client.get('/identity/collection',params={'id':cid}).json()['id']==cid
    with sqlite3.connect(path) as after:
        assert after.execute("SELECT count(*) FROM sqlite_master WHERE name='collection_consolidations'").fetchone()[0]==0
        assert after.execute('SELECT count(*) FROM collections').fetchone()[0]==len(c.active_rows(db))


def test_collection_assets_probe_only_current_requested_recordings(tmp_path,monkeypatch):
    from app.services import provider_resolution
    from .test_canonical import entity,put
    db,a,_=exact_fixture(tmp_path)
    unrelated=entity('local:900','local')
    unrelated['metadata_json']=json.dumps({'absolute_path':'/unrelated/current.mp3','catalog_current':True})
    put(db,unrelated)
    db.execute('UPDATE entities SET local_track_id=900,recording_id=? WHERE id=?',('unrelated-recording',unrelated['id']))
    probes=[]
    def evidence(path,root=None):
        assert path!='/unrelated/current.mp3','unrelated current local asset was probed'
        probes.append(path)
        return {'state':'present','verified_path_absent':False}
    monkeypatch.setattr(provider_resolution,'file_evidence',evidence)
    result=lib.collection(db,a)
    assert result['availability']['playable_local']==1
    assert len(probes)==1
    probes.clear()
    assert lib.assets(db,recording_ids=set())=={}
    assert probes==[]


def test_historical_local_pointers_do_not_supply_collection_availability(tmp_path,monkeypatch):
    from app.services import provider_resolution
    from .test_canonical import entity,put
    db,_,_=exact_fixture(tmp_path)
    recording='soundcloud:tracks:4'
    for sid,tid,metadata in [('local:retained:12',12,{}),('local:901',901,{'catalog_current':False}),('local:902',902,{'catalog_current':True,'asset_lifecycle':{'state':'retired'}})]:
        old=entity(sid,'local')
        old['metadata_json']=json.dumps({'absolute_path':'/historical/pointer.mp3',**metadata})
        put(db,old)
        db.execute('UPDATE entities SET local_track_id=?,recording_id=? WHERE id=?',(tid,recording,sid))
    collection=lib.create(db,'Only remote',entity_ids=[recording],detailed=False)['id']
    def evidence(path,root=None):
        assert path!='/historical/pointer.mp3','historical pointer was probed'
        return {'state':'present','verified_path_absent':False}
    monkeypatch.setattr(provider_resolution,'file_evidence',evidence)
    assert recording not in lib.assets(db)
    detail=lib.collection(db,collection)
    assert detail['entries'][0]['local_assets']==[]
    assert detail['availability']['local_unavailable']==0
    assert detail['availability']['remote_only']==1
    row=next(row for row in lib.list_collections(db)['items'] if row['id']==collection)
    assert row['availability']['remote_only']==1
    assert row['availability']['local_unavailable']==0
