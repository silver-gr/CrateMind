import json
import pytest
from app.services import library_completeness as c,collection_intelligence as algebra,library_collections
from .test_stabilization import catalog
from .test_canonical import entity,put


def add(db,sid,service):
    e=entity(sid,service);put(db,e)
    db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',(sid,'Song '+sid,'Artist','','','derived','{}','{}','now'))
    return sid


def test_availability_live_files_and_multi_provider(tmp_path):
    db=catalog(tmp_path)
    r=c.index(db)['local:1'];assert r['availability']['state']=='LOCAL_AND_REMOTE'
    assert r['collection_count']==1 and r['soundcloud_like']
    (tmp_path/'song.mp3').unlink()
    assert c.index(db)['local:1']['availability']['state']=='LOCAL_MISSING_FILE'
    assert c.browse(db,origin='missing_file')['total']==1
    db.execute("DELETE FROM entities WHERE service='local'")
    assert c.index(db)['local:1']['availability']['state']=='REMOTE_ONLY_BOTH'


def test_availability_states():
    sc={'id':'soundcloud:tracks:1','service':'soundcloud'};sp={'id':'spotify:track:a','service':'spotify'}
    assert c.derive([{'playable':True}],[])['state']=='LOCAL_PLAYABLE'
    assert c.derive([{'playable':False}],[])['state']=='LOCAL_MISSING_FILE'
    assert c.derive([], [sc])['state']=='REMOTE_ONLY_SOUNDCLOUD'
    assert c.derive([], [sp])['state']=='REMOTE_ONLY_SPOTIFY'
    assert c.derive([], [{'id':'spotify:local:foo','service':'spotify'}])['state']=='REMOTE_UNRESOLVED'
    assert c.derive([], [{'id':'spotify:episode:a','service':'spotify'}])['state']=='REMOTE_ONLY_SPOTIFY'


def test_recovery_is_persistent_not_availability(tmp_path):
    db=catalog(tmp_path);add(db,'spotify:track:remote','spotify')
    before=[tuple(r) for r in db.execute('SELECT * FROM entities')]
    c.recover(db,'spotify:track:remote','wanted');assert c.browse(db,state='wanted')['total']==1
    c.recover(db,'spotify:track:remote','acquired')
    assert c.index(db)['spotify:track:remote']['availability']['state']=='REMOTE_ONLY_SPOTIFY'
    assert db.execute('SELECT count(*) FROM recovery_events').fetchone()[0]==2
    assert before==[tuple(r) for r in db.execute('SELECT * FROM entities')]
    with pytest.raises(ValueError):c.recover(db,'missing','wanted')


def fixture_algebra(tmp_path):
    db=catalog(tmp_path)
    b=add(db,'spotify:track:b','spotify');d=add(db,'soundcloud:tracks:4','soundcloud')
    a=library_collections.create(db,'A',entity_ids=['local:1',b,b])
    z=library_collections.create(db,'B',entity_ids=[b,d,'spotify:track:one'])
    return db,a['id'],z['id']


def test_canonical_algebra_order_overlap_and_provenance(tmp_path):
    db,a,b=fixture_algebra(tmp_path)
    before=[tuple(r) for r in db.execute('SELECT * FROM memberships')]
    def ids(op):return [r['recording_id'] for r in algebra.algebra(db,[a,b],op)['items']]
    assert ids('union')==['local:1','spotify:track:b','soundcloud:tracks:4']
    assert ids('intersection')==['local:1','spotify:track:b']
    assert ids('difference')==[]
    assert algebra.algebra(db,[b,a],'difference')['items'][0]['recording_id']=='soundcloud:tracks:4'
    preview=algebra.algebra(db,[a,b],'union',True)
    assert preview['total']==2 and preview['overlap']=={'shared':2,'only_left':0,'only_right':1,'jaccard_percent':66.7,'denominator':'unique canonical union'}
    saved=algebra.algebra(db,[a,b],'union',True,'Missing fixtures')
    origins=json.loads(db.execute('SELECT source_json FROM memberships WHERE collection_id=? ORDER BY position',(saved['saved_collection_id'],)).fetchone()[0])['origins']
    assert len(origins)==3  # two repeated left positions and one right
    assert before==[tuple(r) for r in db.execute('SELECT * FROM memberships WHERE collection_id!=?',(saved['saved_collection_id'],))]
    assert algebra.algebra(db,[a],'union')['total']==2
    with pytest.raises(ValueError):algebra.algebra(db,[])
    with pytest.raises(ValueError):algebra.algebra(db,['absent'])


def test_frequency_filters_and_unique(tmp_path):
    db,a,b=fixture_algebra(tmp_path)
    rows=c.index(db)
    assert rows['local:1']['collection_count']==3
    assert c.matches(rows['local:1'],'local_playable soundcloud_like collections:3+ -missing_file')
    assert not c.matches(rows['local:1'],'remote_only')
    result=algebra.enrich_collection(db,library_collections.collection(db,b))
    assert [e['recording_id'] for e in result['entries'] if e['unique_to_collection']]==['soundcloud:tracks:4']
    assert sum(v for k,v in result['availability'].items() if k!='positions')==3


def test_api_preview_no_writes_and_recovery(tmp_path,monkeypatch):
    import sqlite3
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db,a,b=fixture_algebra(tmp_path);db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router);client=TestClient(app)
    assert client.get('/identity/completeness').status_code==200
    assert client.post('/identity/collections/algebra',json={'collection_ids':[a,b]}).json()['total']==3
    assert client.post('/identity/collections/algebra',json={'collection_ids':[]}).status_code==400
    assert client.post('/identity/recovery',json={'recording_id':'spotify:track:b','state':'wanted'}).status_code==200
    assert client.get('/identity/completeness?state=wanted').json()['total']==1
    assert client.post('/identity/recovery',json={'recording_id':'spotify:track:b','state':'bad'}).status_code==422
    saved=client.post('/identity/collections/algebra',json={'collection_ids':[a,b],'operation':'union','exclude_playable':True,'save_name':'API missing'}).json()
    assert saved['total']==2
    detail=client.get('/identity/collection',params={'id':saved['saved_collection_id']}).json()
    assert detail['editable'] and detail['availability']['remote_only']==2
    assert detail['provenance']['operation']=='union'
    assert len(detail['entries'][0]['provenance']['origins'])==3


def test_dj_search_combines_canonical_predicates(db,monkeypatch):
    from .test_search import _mk
    from app.services import search
    good=_mk(db,'/approved.mp3',personal_status='approved')
    _mk(db,'/other.mp3',personal_status='testing')
    monkeypatch.setattr(c,'local_search_ids',lambda session,token:[good.id] if token in {'collections:5+','soundcloud_like','local_playable'} else [])
    assert [t.id for t in search.search(db,'status:approved not_recent:90 collections:5+ soundcloud_like local_playable')]==[good.id]
    assert search.search(db,'remote_only')==[]
    assert [t.id for t in search.search(db,'status:approved -missing_file')]==[good.id]


def test_saved_account_and_availability_filters(tmp_path):
    db=catalog(tmp_path);add(db,'spotify:track:r','spotify')
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)',('saved','Saved unknown owner','spotify','playlist',1,json.dumps({'relationships':['saved_playlist_ownership_unknown']})))
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)',('liked','Liked','spotify','likes',1,json.dumps({'account':'account2'})))
    for cid in ['saved','liked']:db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)',(cid,0,'spotify:track:r',None,'{}'))
    assert c.browse(db,account='account2',saved=True,availability='REMOTE_ONLY_SPOTIFY')['total']==1
    assert c.browse(db,account='account1')['total']==0
    assert c.browse(db,availability='LOCAL_AND_REMOTE')['total']==0
    assert c.browse(db,scope='all',availability='LOCAL_AND_REMOTE')['total']==1
