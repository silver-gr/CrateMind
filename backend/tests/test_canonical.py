import json
import sqlite3
from app.services import canonical_library as c, canonical_metadata as m
from app.services.identity_matching import normalized_item,score_candidate

def entity(sid,service,artist='Artist A',title='Song',isrc=None):
    n=normalized_item({'id':sid,'service':service,'artist':artist,'title':title,'duration_ms':300000,'isrc':isrc})
    return {'id':sid,'service':service,'artist':artist,'title':title,'normalized_json':json.dumps(n),'metadata_json':'{}'}

def test_credits_remixer_not_primary():
    rows=m.credits('Artist A;Artist B','Song - Artist B Remix','spotify:artist:a;spotify:artist:b')
    assert [(r['name'],r['role']) for r in rows]==[('Artist A','primary'),('Artist B','remixer')]
    assert m.display_credit(rows)=='Artist A'

def test_collaboration_and_feature():
    rows=m.credits('Astrix & Captain Hook feat. Someone','Bungee Jump')
    assert [r['role'] for r in rows]==['collaborator','collaborator','featured']

def test_spotify_title_is_not_artist_wrapper():
    p=m.proposal(entity('s','spotify',title='Song - Artist B Remix'))
    assert p['title']=='Song - Artist B Remix'
    assert p['credits'][0]['name']=='Artist A'

def test_uploader_is_not_artist():
    e=entity('s','soundcloud',artist=None,title='Song')
    e['artist']='Some Records'
    assert m.proposal(e)['artist']==''

def test_corroborated_pattern_and_original_preserved():
    local=entity('l','local','Some Records','Artist A - Song')
    remote=entity('s','spotify')
    results,patterns=m.derive({'l':[local,remote]})
    assert results['l']['artist']=='Artist A'
    assert results['l']['state']=='derived'
    assert 'artist_inside_title' in results['l']['validated_patterns']
    assert patterns['artist_inside_title']['corroborated']==1
    assert local['artist']=='Some Records'

def fixture_db():
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript('''CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE recordings(id TEXT PRIMARY KEY,title TEXT,status TEXT);
    CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT,title TEXT,artist TEXT,duration_ms REAL,local_track_id INTEGER,permalink TEXT,recording_id TEXT,status TEXT,metadata_json TEXT,normalized_json TEXT);
    CREATE TABLE candidates(left_id TEXT,right_id TEXT,pair_type TEXT,score REAL,class TEXT,evidence_json TEXT);
    CREATE TABLE collections(id TEXT,name TEXT,service TEXT,kind TEXT,track_count INTEGER,provenance_json TEXT);
    CREATE TABLE memberships(collection_id TEXT,position INTEGER,entity_id TEXT,added_at TEXT,source_json TEXT);''')
    db.execute('INSERT INTO metadata VALUES (?,?)',('summary',json.dumps({'coverage':{}})))
    return db

def put(db,e):
    db.execute('INSERT INTO recordings VALUES (?,?,?)',(e['id'],e['title'],'PROVISIONAL'))
    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',(e['id'],e['service'],e['title'],e['artist'],300000,1 if e['service']=='local' else None,None,e['id'],'HIGH_CONFIDENCE',e['metadata_json'],e['normalized_json']))

def edge(db,a,b,conflicts=None):
    r=score_candidate(json.loads(a['normalized_json']),json.loads(b['normalized_json']))
    r['evidence']['conflicts']=conflicts or []
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',(a['id'],b['id'],'local:spotify',95,'HIGH_CONFIDENCE',json.dumps(r['evidence'])))

def test_promotion_replay_revocation():
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b)
    assert c.promote(db)['new_promotions']==1
    assert c.promote(db)['new_promotions']==0
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==1
    c.revoke(db,a['id'],b['id'])
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2
    assert c.promote(db)['new_promotions']==0

def test_isrc_contradiction_blocks():
    db=fixture_db();a=entity('local:1','local',isrc='AA123');b=entity('spotify:track:b','spotify',isrc='BB456')
    put(db,a);put(db,b);edge(db,a,b)
    report=c.promote(db)
    assert report['new_promotions']==0
    assert report['blocked']['contradictory_isrc']==1

def test_conflict_cannot_promote():
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b,['previously_rejected'])
    assert c.promote(db)['new_promotions']==0

def test_human_anchor_metadata_preserved():
    db=fixture_db();a=entity('local:1','local');b=entity('soundcloud:tracks:b','soundcloud')
    put(db,a);put(db,b)
    r=score_candidate(json.loads(a['normalized_json']),json.loads(b['normalized_json']))
    r['evidence']['anchor']={'trusted':True,'method':'existing_manual_review','original':{'confirmed_at':'2026-01-01','method':'manual_review'}}
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',(a['id'],b['id'],'local:soundcloud',100,'ACCEPTED',json.dumps(r['evidence'])))
    c.promote(db)
    row=db.execute('SELECT * FROM identity_acceptances').fetchone()
    assert row['acceptance_mode']=='human'
    assert row['accepted_at']=='2026-01-01'

def test_transitive_conflicting_bridge_blocked():
    db=fixture_db()
    a=entity('local:1','local',isrc='AAA');b=entity('soundcloud:tracks:b','soundcloud');d=entity('spotify:track:d','spotify',isrc='BBB')
    for e in (a,b,d):put(db,e)
    edge(db,a,b);edge(db,b,d)
    assert c.promote(db)['new_promotions']==1
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2

def test_neighborhood_does_not_promote():
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b)
    e=json.loads(db.execute('SELECT evidence_json FROM candidates').fetchone()[0]);e['score_without_neighborhood']=69
    db.execute('UPDATE candidates SET evidence_json=?',(json.dumps(e),))
    assert c.promote(db)['new_promotions']==0

def test_review_and_replay_preserve_human_metadata():
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b);c.promote(db)
    result=c.review(db,'local:1','edit',{'title':'Human title','credits':[{'name':'Real artist','role':'primary'}]})
    assert result['title']=='Human title'
    c.materialize(db)
    assert c.detail(db,'local:1')['title']=='Human title'
    assert db.execute("SELECT title FROM entities WHERE id='local:1'").fetchone()[0]=='Song'
    c.review(db,'local:1','keep_local')
    assert c.detail(db,'local:1')['title']=='Song'

def test_exportify_comma_credits_use_uri_boundaries():
    rows=m.credits('Captain Hook, Astrix','Bungee Jump','spotify:artist:a, spotify:artist:b')
    assert [r['name'] for r in rows]==['Captain Hook','Astrix']
    assert [r['role'] for r in rows]==['collaborator','collaborator']
    assert [r['provider_uri'] for r in rows]==['spotify:artist:a','spotify:artist:b']

def test_canonical_api_decisions_are_db_only(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b);c.promote(db);db.commit()
    path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router)
    client=TestClient(app)
    assert client.get('/identity/canonical/items').status_code==200
    assert client.post('/identity/canonical/pattern-accept',json={'pattern':'artist_inside_title'}).status_code==400
    for action in ('accept','reject','keep_local'):
        res=client.post('/identity/canonical/decision',json={'recording_id':'local:1','action':action})
        assert res.status_code==200,res.text
    res=client.post('/identity/canonical/decision',json={'recording_id':'local:1','action':'edit','payload':{'title':'Changed','credits':[{'name':'A','role':'primary'},{'name':'B','role':'remixer'}]}})
    assert res.status_code==200
    with sqlite3.connect(path) as check:
        assert check.execute("SELECT title FROM entities WHERE id='local:1'").fetchone()[0]=='Song'
        assert check.execute("SELECT title FROM canonical_recordings WHERE recording_id='local:1'").fetchone()[0]=='Changed'
        assert check.execute('SELECT count(*) FROM canonical_events').fetchone()[0]==5
    res=client.post('/identity/canonical/revoke-identity',json={'left_id':'local:1','right_id':'spotify:track:b'})
    assert res.status_code==200

def test_multiple_remixers_are_not_collaborators():
    rows=m.credits('Original Artist, Remixer A, Remixer B','Song - Remixer A & Remixer B Remix','spotify:artist:o, spotify:artist:a, spotify:artist:b')
    assert [(r['name'],r['role']) for r in rows]==[('Original Artist','primary'),('Remixer A','remixer'),('Remixer B','remixer')]

def test_bulk_requires_distinct_manual_examples(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.identity import router
    db=fixture_db()
    for i in range(11):put(db,entity(f'local:{i}','local'))
    c.promote(db)
    db.execute("UPDATE canonical_recordings SET state='review',evidence_json=json_set(evidence_json,'$.patterns',json('[\"test_pattern\"]'))")
    db.commit();path=tmp_path/'identity.sqlite'
    with sqlite3.connect(path) as out:db.backup(out)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path))
    app=FastAPI();app.include_router(router);client=TestClient(app)
    for _ in range(10):assert client.post('/identity/canonical/decision',json={'recording_id':'local:0','action':'accept'}).status_code==200
    assert client.post('/identity/canonical/pattern-accept',json={'pattern':'test_pattern'}).status_code==400
    for i in range(1,10):assert client.post('/identity/canonical/decision',json={'recording_id':f'local:{i}','action':'accept'}).status_code==200
    r=client.post('/identity/canonical/pattern-accept',json={'pattern':'test_pattern'})
    assert r.status_code==200,r.text
    assert r.json()['applied']==1

def test_single_spotify_artist_uri_preserves_band_name():
    rows=m.credits('Simon & Garfunkel','Song','spotify:artist:band')
    assert len(rows)==1
    assert rows[0]['name']=='Simon & Garfunkel'


def test_permissive_promotion_reuses_pair_eligibility():
    db=fixture_db();a=entity('local:1','local','Alpha & Beta');b=entity('spotify:track:b','spotify','Alpha')
    n=json.loads(b['normalized_json']);n['duration_ms']=312000;b['normalized_json']=json.dumps(n)
    put(db,a);put(db,b);edge(db,a,b)
    assert c.promote(db)['new_promotions']==1


def test_numeric_artist_promotion_uses_provider_performer():
    db=fixture_db();a=entity('local:1','local','280');b=entity('spotify:track:b','spotify','Alpha')
    put(db,a);put(db,b);edge(db,a,b)
    assert c.promote(db)['new_promotions']==1


def test_transitive_incompatible_titles_do_not_merge():
    db=fixture_db()
    a=entity('local:1','local',title='Moon Garden')
    b=entity('soundcloud:tracks:b','soundcloud',title='Moon Garden')
    n=json.loads(b['normalized_json']);n['file_name']='Artist A - Distant Oceans.mp3'
    b['normalized_json']=json.dumps(normalized_item(n))
    d=entity('spotify:track:d','spotify',title='Distant Oceans')
    for row in (a,b,d):put(db,row)
    edge(db,a,b);edge(db,b,d)
    report=c.promote(db)
    assert report['new_promotions']==1
    assert report['blocked']['component_title_conflict']==1
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2


def test_new_deterministic_edge_checks_existing_human_component():
    db=fixture_db()
    a=entity('local:1','local',isrc='AAA')
    b=entity('spotify:track:b','spotify',isrc='AAA')
    d=entity('soundcloud:tracks:d','soundcloud',isrc='BBB')
    for row in (a,b,d):put(db,row)
    db.executescript(c.SCHEMA)
    db.execute('INSERT INTO identity_acceptances VALUES (?,?,?,?,?,?,?,?,NULL)',
               (a['id'],d['id'],'fixture',100,'manual_review','{}',c.now(),'human'))
    result=score_candidate(json.loads(a['normalized_json']),json.loads(b['normalized_json']))
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',
               (a['id'],b['id'],'local:spotify',result['score'],result['class'],json.dumps(result['evidence'])))
    report=c.promote(db)
    assert report['blocked']['contradictory_isrc']==1
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==1
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2
