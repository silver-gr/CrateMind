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
