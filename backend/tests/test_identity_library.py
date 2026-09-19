import json
import sqlite3
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.identity import router
from app.services import identity_library


@pytest.fixture
def identity_db(tmp_path, monkeypatch):
    path = tmp_path / 'identity.sqlite'; db = sqlite3.connect(path)
    db.executescript('''
    CREATE TABLE metadata(key TEXT,value TEXT);
    CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT,title TEXT,artist TEXT,duration_ms REAL,local_track_id INTEGER,permalink TEXT,recording_id TEXT,status TEXT,metadata_json TEXT,normalized_json TEXT);
    CREATE TABLE candidates(left_id TEXT,right_id TEXT,pair_type TEXT,score REAL,class TEXT,evidence_json TEXT);
    CREATE TABLE collections(id TEXT,name TEXT,service TEXT,kind TEXT,track_count INTEGER,provenance_json TEXT);
    CREATE TABLE memberships(collection_id TEXT,position INTEGER,entity_id TEXT,added_at TEXT,source_json TEXT);
    ''')
    db.execute('INSERT INTO metadata VALUES (?,?)', ('summary', json.dumps({'entities': 3})))
    for id, service, local_id, recording in [('local:1','local',1,'r1'),('local:2','local',2,'r1'),('spotify:track:3','spotify',None,'r3')]:
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)', (id,service,'Song','Artist',120000,local_id,None,recording,'AMBIGUOUS','{}','{}'))
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', ('local:1','spotify:track:3','local:spotify',73,'PROBABLE','{}'))
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)', ('c','Collection','cratemind','local_copy',3,'{}'))
    for pos, sid in enumerate(['local:1','spotify:track:3','spotify:track:3']):
        db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)', ('c',pos,sid,None,'{}'))
    db.commit(); db.close(); monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH',str(path)); return path


def test_readonly_and_preserved_many_assets_positions(identity_db):
    with identity_library.connect() as db:
        with pytest.raises(sqlite3.OperationalError): db.execute('DELETE FROM entities')
        c = identity_library.collection(db,'c')
        assert [r['position'] for r in c['entries']] == [0,1,2]
        assert len(c['entries'][0]['local_assets']) == 2 and not c['entries'][1]['local_assets']
        d = identity_library.detail(db,'spotify:track:3')
        assert d['candidates'][0]['other_id'] == 'local:1' and len(d['memberships']) == 2


def test_api_filters_errors_and_no_writes(identity_db):
    app = FastAPI(); app.include_router(router,prefix='/api'); before=identity_db.read_bytes()
    with TestClient(app) as c:
        assert c.get('/api/identity/summary').json()['entities'] == 3
        assert c.get('/api/identity/items?service=spotify').json()['total'] == 1
        assert len(c.get('/api/identity/items?limit=1&offset=1').json()['items']) == 1
        assert c.get('/api/identity/items?q=%25').json()['total'] == 0
        assert c.get('/api/identity/item?id=missing').status_code == 404
        assert c.get('/api/identity/items?limit=999').status_code == 422
        assert c.post('/api/identity/item?id=local:1').status_code == 405
    assert identity_db.read_bytes() == before


def test_calibration_report_must_match_current_projection(identity_db, tmp_path, monkeypatch):
    from app.api import identity
    monkeypatch.setattr(identity, 'CALIBRATION_DIR', tmp_path)
    db = sqlite3.connect(identity_db)
    db.execute('UPDATE metadata SET value=? WHERE key=?', (json.dumps({'built_at':'fixture-build'}),'summary'))
    db.commit(); db.close()
    app = FastAPI(); app.include_router(router,prefix='/api')
    with TestClient(app) as client:
        assert client.get('/api/identity/calibration').status_code == 503
        (tmp_path/'calibration.json').write_text(json.dumps({'projection_build_at':'old-build'}))
        (tmp_path/'calibration.html').write_text('<h1>Review</h1>')
        assert client.get('/api/identity/calibration').status_code == 503
        (tmp_path/'calibration.json').write_text(json.dumps({'projection_build_at':'fixture-build'}))
        result = client.get('/api/identity/calibration')
        assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
        assert client.post('/api/identity/calibration').status_code == 405
