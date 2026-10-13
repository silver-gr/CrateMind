import json,sqlite3
from pathlib import Path
import pytest
from app.services import canonical_library as c,canonical_metadata as m,provider_resolution as p,canonical_queue as q,library_collections as collections
from .test_canonical import fixture_db,put,entity


def catalog(tmp_path):
    db=fixture_db()
    db.executescript(c.SCHEMA)
    audio=tmp_path/'song.mp3';audio.write_bytes(b'test fixture')
    a=entity('local:1','local');a['metadata_json']=json.dumps({'absolute_path':str(audio),'missing':False})
    s=entity('spotify:track:one','spotify');sc=entity('soundcloud:tracks:123','soundcloud');sc['metadata_json']=json.dumps({'availability':'available','popularity':{'playback_count':1234,'likes_count':12,'reposts_count':3},'normalized_metadata':{'uploader_username':'Label'}})
    for e in (a,s,sc):put(db,e)
    db.execute("UPDATE entities SET recording_id='local:1',status='ACCEPTED'")
    db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',('local:1','Song','Artist A','','','derived',json.dumps(m.proposal(a)),json.dumps({'observations':[{'id':a['id'],'service':'local','artist':'Artist A','title':'Song'}],'patterns':[]}),c.now()))
    c.set_credits(db,'local:1',[{'name':'Artist A','role':'primary'}])
    for left,right in ((a['id'],s['id']),(s['id'],sc['id'])):
        db.execute('INSERT INTO identity_acceptances VALUES (?,?,?,?,?,?,?,?,NULL)',(left,right,'fixture',93,'fixture','{}',c.now(),'auto_high_confidence'))
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)',('import','Imported','soundcloud','likes',3,'{"account":"me"}'))
    for pos,eid in enumerate((sc['id'],sc['id'],s['id'])):db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)',('import',pos,eid,'2026-01-01','{}'))
    return db


def test_transitive_provider_card_no_direct_legacy(tmp_path,monkeypatch):
    db=catalog(tmp_path);db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    legacy={'soundcloud':None,'soundcloud_candidates':[]}
    result=p.track_detail(None,1,legacy)
    assert result['legacy_soundcloud'] is None
    assert result['soundcloud']['track']['playback_count']==1234
    assert len(result['soundcloud']['accepted_path'])==2
    assert result['soundcloud']['counter_source_id']=='soundcloud:tracks:123'
    provider=next(v for v in result['canonical']['providers'] if v['service']=='soundcloud')
    assert provider['popularity']['playback_count']==result['soundcloud']['track']['playback_count']
    assert provider['liked_in']
    assert result['canonical']['local_assets'][0]['playable']


def test_neutral_order_and_explicit_feature_remixer():
    rows=m.credits('A;B','Song','spotify:artist:a;spotify:artist:b')
    assert [r['name'] for r in rows]==['A','B']
    assert [r['role'] for r in rows]==['collaborator','collaborator']
    assert [r['role'] for r in m.credits('A;B','Song (feat. B)','spotify:artist:a;spotify:artist:b')]==['primary','featured']
    assert [r['role'] for r in m.credits('A;B','Song (B Remix)','spotify:artist:a;spotify:artist:b')]==['primary','remixer']


def test_actionable_default_hides_unknown_and_complete(tmp_path):
    db=catalog(tmp_path)
    assert q.list_items(db)['total']==0
    assert q.list_items(db,view='complete')['total']==1
    proposal=m.proposal(entity('local:1','local',artist='Better artist'))
    db.execute("UPDATE canonical_recordings SET state='review',proposal_json=?",(json.dumps(proposal),))
    assert q.list_items(db)['total']==1
    db.execute("UPDATE canonical_recordings SET proposal_json='{}',title=NULL,artist=NULL")
    assert q.list_items(db)['total']==0
    assert q.list_items(db,view='unknown')['total']==1
    assert q.list_items(db,view='all')['total']==1


def test_native_copy_order_repeats_provenance_and_import_guard(tmp_path):
    db=catalog(tmp_path)
    before=[tuple(r) for r in db.execute("SELECT * FROM memberships WHERE collection_id='import'")]
    copy=collections.create(db,'My collection','import')
    assert copy['editable'] and len(copy['entries'])==3
    assert [r['id'] for r in copy['entries']]==['soundcloud:tracks:123','soundcloud:tracks:123','spotify:track:one']
    assert [r['provenance']['origin_position'] for r in copy['entries']]==[0,1,2]
    assert copy['availability']['playable_local']==3
    with pytest.raises(ValueError):collections.append(db,'import',['local:1'])
    out=collections.append(db,copy['id'],['local:1','local:1'])
    assert [r['position'] for r in out['entries']]==[0,1,2,3,4]
    assert [tuple(r) for r in db.execute("SELECT * FROM memberships WHERE collection_id='import'")]==before
    (tmp_path/'song.mp3').unlink()
    assert collections.collection(db,'import')['availability']['local_unavailable']==3


def test_empty_native_and_missing_entity(tmp_path):
    db=catalog(tmp_path)
    assert collections.create(db,'Empty')['entries']==[]
    with pytest.raises(ValueError):collections.create(db,'Bad',entity_ids=['missing'])

def test_search_each_credit_and_collection_api(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db=catalog(tmp_path)
    c.set_credits(db,'local:1',[{'name':'Artist A','role':'collaborator'},{'name':'Second artist','role':'collaborator'},{'name':'Hidden remixer','role':'remixer'}])
    db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router);client=TestClient(app)
    for name in ('Artist A','Second artist','Hidden remixer'):
        assert 'local:1' in {r['recording_id'] for r in client.get('/identity/canonical/items',params={'q':name,'view':'all'}).json()['items']}
        assert client.get('/identity/items',params={'q':name}).json()['total']==1
        assert client.get('/identity/items',params={'q':name,'mode':'sources'}).json()['total']==3
        assert 1 in c.search_ids([name])
    res=client.post('/identity/collections/native',json={'name':'Native','source_id':'import'})
    assert res.status_code==200,res.text
    cid=res.json()['id']
    assert client.post(f'/identity/collections/native/{cid}/entries',json={'entity_ids':['local:1']}).json()['track_count']==4
    assert client.post('/identity/collections/native/import/entries',json={'entity_ids':['local:1']}).status_code==400
    assert client.get('/identity/collection',params={'id':'import'}).json()['track_count']==3

def test_summary_uses_canonical_association_not_old_count(tmp_path,monkeypatch):
    db=catalog(tmp_path);db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    result=p.summary(None,{'confirmed_local_tracks':0})
    assert result['confirmed_local_tracks']==1
    assert result['legacy_confirmed_local_tracks']==0
    assert result['snapshots']==1
