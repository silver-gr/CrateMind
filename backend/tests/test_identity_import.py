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


GREEK = ['URI κομματιού', 'Όνομα κομματιού', 'URI καλλιτέχνη/ων', 'Όνομα/τα καλλιτέχνη', 'URI άλμπουμ', 'Όνομα άλμπουμ', 'URI καλλιτέχνη/ων άλμπουμ',
         'Όνομα/τα καλλιτέχνη άλμπουμ', 'Ημερομηνία κυκλοφορίας άλμπουμ', 'URL εικόνας άλμπουμ', 'Αριθμός δίσκου', 'Αριθμός κομματιού',
         'Διάρκεια κομματιού (ms)', 'URL προεπισκόπησης κομματιού', 'Ακατάλληλο', 'Δημοτικότητα', 'ISRC', 'Προστέθηκε από', 'Προστέθηκε στις', 'Είδη καλλιτέχνη']
ENGLISH = ['Track URI', 'Track Name', 'Album Name', 'Artist Name(s)', 'Release Date', 'Duration (ms)', 'Popularity', 'Explicit', 'Added By', 'Added At',
           'Genres', 'Record Label', 'Danceability', 'Energy', 'Key', 'Loudness', 'Mode', 'Speechiness', 'Acousticness', 'Instrumentalness',
           'Liveness', 'Valence', 'Tempo', 'Time Signature']


def exportify(path, member, headers, values):
    import csv, io, zipfile
    with zipfile.ZipFile(path, 'w') as z:
        s = io.StringIO(); w = csv.writer(s); w.writerow(headers); w.writerows([[v.get(h, '') for h in headers] for v in values])
        z.writestr(member, s.getvalue().encode('utf-8-sig'))
    return path


def stage_from_exports(tmp_path, name, accounts):
    """The preview's Spotify path: parse each export, merge same-ID items across accounts, stage the rows."""
    import preview
    stage = tmp_path / name; stage.mkdir()
    items, observations = {}, []
    for zip_path, account in accounts:
        _, _, ii, oo = preview.parse_spotify(zip_path, account); observations += oo
        for sid, item in ii.items():
            preview.merge_item(items, sid, item)
    preview.write_rows(stage / 'source_items.jsonl', sorted(items.values(), key=lambda r: r['source_item_id']))
    preview.write_rows(stage / 'source_observations.jsonl', observations)
    return stage


def empty_catalog(path):
    c = sqlite3.connect(path)
    c.executescript('CREATE TABLE artist_profiles(normalized_name TEXT,canonical_name TEXT,aliases_json TEXT);'
                    'CREATE TABLE tracks(id INTEGER,title TEXT,artist TEXT,artist_normalized TEXT,file_name TEXT,duration REAL,album TEXT,label TEXT,genre TEXT,year INTEGER,bpm REAL);'
                    'CREATE TABLE track_soundcloud_matches(track_id INTEGER,soundcloud_track_id INTEGER,method TEXT);'
                    'CREATE TABLE soundcloud_match_candidates(track_id INTEGER,soundcloud_track_id INTEGER,status TEXT);')
    c.commit(); c.close()
    return path


def test_same_spotify_id_across_exports_keeps_richer_values_in_both_orders(tmp_path):
    sid = 'spotify:track:a'
    # Account 1 (Greek, 20 columns): ISRC + artist URIs, two rows of the same ID (the first one poorer).
    greek = exportify(tmp_path / 'account1.zip', 'liked.csv', GREEK, [
        {'URI κομματιού': sid, 'Όνομα κομματιού': 'Song', 'Όνομα/τα καλλιτέχνη': 'Artist', 'Δημοτικότητα': '40'},
        {'URI κομματιού': sid, 'Όνομα κομματιού': 'Song', 'Όνομα/τα καλλιτέχνη': 'Artist', 'URI καλλιτέχνη/ων': 'spotify:artist:x',
         'Όνομα άλμπουμ': 'Album', 'ISRC': 'GRA012300001', 'Διάρκεια κομματιού (ms)': '200000', 'Δημοτικότητα': '41', 'Είδη καλλιτέχνη': 'techno'}])
    # Account 3 (English, 24 columns): no ISRC/artist URIs, but label and genres; a different album name.
    english = exportify(tmp_path / 'account3.zip', 'Liked_Songs.csv', ENGLISH, [
        {'Track URI': sid, 'Track Name': 'Song', 'Artist Name(s)': 'Artist', 'Album Name': 'Album (Deluxe)', 'Genres': 'house',
         'Record Label': 'Label X', 'Duration (ms)': '200000', 'Popularity': '42'}])
    catalog = empty_catalog(tmp_path / 'catalog.sqlite')
    built = {}
    for name, accounts in [('greek_first', [(greek, 'account1'), (english, 'account3')]), ('english_first', [(english, 'account3'), (greek, 'account1')])]:
        stage = stage_from_exports(tmp_path, name, accounts)
        items, _, _ = builder.identity_items(stage, catalog)
        assert builder.identity_items(stage, catalog)[0] == items  # rebuilding the same stage is idempotent
        item = items[sid]; raw = item['raw']
        assert (item['isrc'], raw['artist_uris'], item['artist'], item['label'], item['duration_ms']) == ('GRA012300001', 'spotify:artist:x', 'Artist', 'Label X', 200000)
        assert {item['album'], *raw['alternatives']['album']} == {'Album', 'Album (Deluxe)'}
        assert {item['genre'], *raw['alternatives']['genres']} == {'techno', 'house'}
        # Observations are embedded compactly: provenance plus popularity only.
        assert len(raw['source_observations']) == 3
        assert all(set(o['raw_metadata']) <= {'Popularity', 'Δημοτικότητα'} and 'metadata' not in o for o in raw['source_observations'])
        assert sorted(next(iter(o['raw_metadata'].values())) for o in raw['source_observations']) == ['40', '41', '42']
        built[name] = item
    assert built['greek_first']['album'] == 'Album' and built['greek_first']['genre'] == 'techno'
    assert built['english_first']['album'] == 'Album (Deluxe)' and built['english_first']['genre'] == 'house'


def test_stale_stage_rows_are_repaired_from_every_observation(tmp_path):
    """A stage written by the old last-account-wins importer still builds the richer entity."""
    import preview
    sid = 'spotify:track:a'
    greek = exportify(tmp_path / 'account1.zip', 'liked.csv', GREEK, [
        {'URI κομματιού': sid, 'Όνομα κομματιού': 'Song', 'Όνομα/τα καλλιτέχνη': 'Artist', 'URI καλλιτέχνη/ων': 'spotify:artist:x', 'ISRC': 'GRA012300001'}])
    english = exportify(tmp_path / 'account3.zip', 'Liked_Songs.csv', ENGLISH, [
        {'Track URI': sid, 'Track Name': 'Song', 'Artist Name(s)': 'Artist', 'Record Label': 'Label X', 'Genres': 'house'}])
    stage = tmp_path / 'stale'; stage.mkdir(); observations = []; items = {}
    for zip_path, account in [(greek, 'account1'), (english, 'account3')]:
        _, _, ii, oo = preview.parse_spotify(zip_path, account); observations += oo; items.update(ii)
    assert items[sid]['isrc'] is None  # the English export has no ISRC column
    preview.write_rows(stage / 'source_items.jsonl', list(items.values())); preview.write_rows(stage / 'source_observations.jsonl', observations)
    item = builder.identity_items(stage, empty_catalog(tmp_path / 'catalog.sqlite'))[0][sid]
    assert (item['isrc'], item['raw']['artist_uris'], item['label'], item['genre']) == ('GRA012300001', 'spotify:artist:x', 'Label X', 'house')
    assert 'alternatives' not in item['raw']
