"""Transactional staging contract: idempotent snapshots and many representations."""
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'reconciliation'))
spec = importlib.util.spec_from_file_location('identity_builder_test', ROOT / 'reconciliation/build_identity.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def rows(path, values):
    path.write_text(''.join(json.dumps(v) + '\n' for v in values))


def test_rebuild_preserves_repeats_provider_only_and_many_assets(tmp_path):
    stage = tmp_path / 'stage'; stage.mkdir()
    collection = {'collection_id':'source:one','name':'Test','service':'soundcloud','is_likes':False,'track_count':4}
    rows(stage/'source_collections.jsonl',[collection])
    members = [{'collection_id':'source:one','position':i,'source_item_id':sid,'added_at':None} for i,sid in enumerate(['sc:1','spotify:track:2','spotify:track:2','sc:missing'])]
    rows(stage/'source_memberships.jsonl',members)
    (stage/'collection_preview.json').write_text(json.dumps({'source_snapshot':collection,'source_entries':members}))
    items = {sid:{'id':sid,'service':service,'title':'Title','artist':'Artist','duration_ms':300000,'raw':{},'local_track_id':lid} for sid,service,lid in [('local:1','local',1),('local:2','local',2),('sc:1','soundcloud',None),('spotify:track:2','spotify',None),('sc:missing','soundcloud',None)]}
    candidates = [{'left_id':sid,'right_id':'sc:1','pair_type':'local:soundcloud','score':100,'class':'ACCEPTED','evidence':{}} for sid in ['local:1','local:2']]
    dumps=[]
    for name in ['first.sqlite','second.sqlite']:
        path=tmp_path/name;builder.populate(path,items,candidates,stage)
        c=sqlite3.connect(path)
        assert c.execute('select count(distinct recording_id) from entities where id in ("local:1","local:2","sc:1")').fetchone()[0]==1
        assert c.execute('select count(*) from memberships where collection_id="source:one"').fetchone()[0]==4
        assert c.execute('select entity_id from memberships where collection_id="local:collection:summer-proof" and position=3').fetchone()[0]=='sc:missing'
        assert c.execute('select local_track_id from entities where id="spotify:track:2"').fetchone()[0] is None
        dumps.append('\n'.join(x for x in c.iterdump() if not x.startswith('INSERT INTO "metadata"')))
        c.close()
    assert dumps[0]==dumps[1]
