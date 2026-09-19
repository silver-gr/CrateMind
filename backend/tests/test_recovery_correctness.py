import json,errno,os
from pathlib import Path
from urllib.parse import urlparse,parse_qs
import pytest
from app.services import provider_resolution as p,recovery_prioritization as recovery,library_completeness as completeness,identity_library
from .test_completeness import fixture_algebra
from .test_canonical import entity,put


def test_file_diagnostics_separate_absence_access_and_missing_root(tmp_path,monkeypatch):
    root=tmp_path/'volume';root.mkdir();parent=root/'music';parent.mkdir();path=parent/'track.mp3'
    assert p.file_evidence(path,root)=={'state':'recorded_path_absent','verified_path_absent':True,'errno':errno.ENOENT}
    assert p.file_evidence(root/'gone'/'song.mp3',root)['state']=='parent_path_absent'
    assert p.file_evidence(path,tmp_path/'unmounted')['state']=='root_unavailable'
    original=Path.stat
    def denied(self,*args,**kwargs):
        if self==path:raise PermissionError(errno.EACCES,'denied')
        return original(self,*args,**kwargs)
    monkeypatch.setattr(Path,'stat',denied)
    e=p.file_evidence(path,root)
    assert e['state']=='permission_denied' and not e['verified_path_absent']
    monkeypatch.setattr(Path,'stat',original)
    path.write_bytes(b'fixture');monkeypatch.setattr(os,'access',lambda *args:False)
    assert p.file_evidence(path,root)['state']=='permission_denied'
    assert p.file_evidence(None)['state']=='unknown_no_path'


def test_existing_missing_flag_does_not_become_verified_absence(tmp_path):
    db,_,_=fixture_algebra(tmp_path)
    e=dict(db.execute("SELECT * FROM entities WHERE id='local:1'").fetchone());raw=json.loads(e['metadata_json']);raw['missing']=True;e['metadata_json']=json.dumps(raw)
    a=p.local_asset(e)
    assert a['catalog_missing_flag'] and not a['playable']
    assert a['file_evidence']['state']=='present' and not a['file_evidence']['verified_path_absent']


def test_candidates_link_review_without_attaching_local_assets(tmp_path):
    db,_,_=fixture_algebra(tmp_path)
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('local:1','spotify:track:b','local_spotify',80,'PROBABLE',json.dumps({'conflicts':[]})))
    before=[tuple(r) for r in db.execute('SELECT * FROM entities')]
    result=recovery.view(db,preset='discovery')
    b=next(v for v in result['items'] if v['recording_id']=='spotify:track:b')
    evidence=b['local_candidate_evidence']
    assert evidence['plausible_local_files']==1 and b['local_assets']==[]
    assert b['availability']['remote_only'] and b['availability']['local_association']=='none_accepted'
    params=parse_qs(urlparse(evidence['items'][0]['review_url']).query)
    detail=identity_library.detail(db,params['id'][0],params['candidate'][0])
    assert detail['candidates'][0]['other_id']=='local:1'
    assert before==[tuple(r) for r in db.execute('SELECT * FROM entities')]
    db.execute('UPDATE candidates SET evidence_json=?',(json.dumps({'conflicts':['previously_rejected']}),))
    b=next(v for v in recovery.view(db,preset='discovery')['items'] if v['recording_id']=='spotify:track:b')
    assert b['local_candidate_evidence']['plausible_local_files']==0 and b['local_candidate_evidence']['guarded_pairs']==1


def test_popularity_minimum_upload_observation_zero_before_unknown(tmp_path):
    db,_,_=fixture_algebra(tmp_path)
    db.execute('UPDATE entities SET metadata_json=? WHERE id=?',(json.dumps({'popularity':{'playback_count':0,'likes_count':0}}),'soundcloud:tracks:4'))
    e=entity('soundcloud:tracks:9','soundcloud');put(db,e)
    db.execute('UPDATE entities SET recording_id=?,metadata_json=? WHERE id=?',('soundcloud:tracks:4',json.dumps({'popularity':{'playback_count':100,'likes_count':10}}),'soundcloud:tracks:9'))
    for key in ['soundcloud_plays','soundcloud_likes']:
        result=recovery.view(db,preset='discovery',sort=key)
        assert [v['recording_id'] for v in result['items']]==['soundcloud:tracks:4','local:1','spotify:track:b']
        assert result['items'][0]['providers'][0]['popularity']['playback_count']==0
        assert result['items'][-1]['providers'][0]['service']=='spotify'


def test_requested_candidate_not_lost_below_review_limit(tmp_path):
    db,_,_=fixture_algebra(tmp_path)
    for i in range(105):
        sid=f'spotify:track:noise{i}';put(db,entity(sid,'spotify'))
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('spotify:track:b',sid,'spotify_soundcloud',99,'HIGH_CONFIDENCE','{}'))
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)',('local:1','spotify:track:b','local_spotify',70,'PROBABLE','{}'))
    rows=identity_library.detail(db,'spotify:track:b','local:1')['candidates']
    assert len(rows)==100 and rows[0]['other_id']=='local:1'
