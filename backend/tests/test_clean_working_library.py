"""reconciliation/clean_working_library.py on a synthetic dataset root (hand-built fixtures, never real data)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.library_exchange.operations import _pointer
from app.library_exchange.state import atomic_json, initial_state
from app.services.collection_consolidation import fingerprint
from app.services.dataset_access import DatasetBusyError, DatasetLease
from app.services.identity_compaction import SPOTIFY_OBSERVATION_KEEP
from app.services.identity_matching import normalized_item
from app.services.schema_contract import canonical_database_values, load_schema_contract

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('clean_working_library', ROOT / 'reconciliation/clean_working_library.py')
cwl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cwl)
GRID = 7  # locals local:1..7 x spotify:track:s0..s6, all AMBIGUOUS below the display pool score


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def dump(value): return json.dumps(value, ensure_ascii=False, sort_keys=True)


def entity(db, sid, service, title, artist, recording=None, metadata=None, status='AMBIGUOUS', local_id=None, normalized=None):
    recording = recording or sid
    db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)', (recording, title, 'PROVISIONAL'))
    norm = normalized or normalized_item({'id': sid, 'service': service, 'title': title, 'artist': artist, 'duration_ms': 300000, 'kind': 'track'})
    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',
               (sid, service, title, artist, 300000, local_id, None, recording, status, dump(metadata or {}), dump(norm)))
    db.execute('INSERT INTO canonical_base_entities VALUES (?,?,?)', (sid, recording, status))
    return norm


def canonical(db, rid, title, artist, state='derived'):
    evidence = {'proposal': {'title': title}, 'observations': [{'proposal': {'title': title}, 'source_id': rid}], 'kept': 1}
    db.execute('INSERT INTO canonical_recordings VALUES (?,?,?,?,?,?,?,?,?)',
               (rid, title, artist, '', '', state, dump({'title': title, 'credits': []}), dump(evidence), 'then'))


def event(db, rid, action, before=None, after=None):
    db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',
               (rid, action, None if before is None else dump(before), None if after is None else dump(after), 'then'))


def credit_event(db, rid):
    credits = [{'credit_order': 0, 'id': 'artist:a', 'name': 'A', 'role': 'primary'}, {'credit_order': 1, 'id': 'artist:b', 'name': 'B', 'role': 'collaborator'}]
    proposal = {'artist': 'A & B', 'credits': [{'name': 'A', 'role': 'primary', 'provider_uri': None}, {'name': 'B', 'role': 'collaborator', 'provider_uri': None}]}
    collab = lambda rows: [{**r, 'role': 'collaborator'} for r in rows]
    event(db, rid, 'credit_semantics_v2', {'proposal': proposal, 'credits': credits, 'artist': 'A & B'},
          {'proposal': {**proposal, 'credits': collab(proposal['credits'])}, 'credits': collab(credits), 'artist': 'A & B'})


def sou_event(db, sid, metadata, normalized, new_metadata, new_normalized):
    row = {'id': sid, 'service': 'local', 'title': 'T', 'artist': 'A', 'duration_ms': 300000, 'local_track_id': 1, 'permalink': None,
           'recording_id': sid, 'status': 'AMBIGUOUS', 'metadata_json': dump(metadata), 'normalized_json': dump(normalized)}
    event(db, sid, 'source_observation_update', row, {'entity_id': sid, 'metadata': new_metadata, 'normalized': new_normalized})


def populate(identity, catalog, zips):
    with closing(sqlite3.connect(identity)) as db:
        db.row_factory = sqlite3.Row
        local_meta = {}
        for i in range(1, GRID + 2):
            local_meta[i] = {'absolute_path': f'/nowhere/{i}.mp3', 'file_name': f'{i}.mp3', 'missing': 0}
            norm = entity(db, f'local:{i}', 'local', f'Kappa Song {i}', f'Kappa Artist {i}', local_id=i, metadata=local_meta[i],
                          status='ACCEPTED' if i == GRID + 1 else 'AMBIGUOUS')
            if i == 1: local_norm = norm
        for j in range(GRID):
            entity(db, f'spotify:track:s{j}', 'spotify', f'Remote Tune {j}', f'Remote Band {j}', metadata={'source_observations': []})
            canonical(db, f'spotify:track:s{j}', f'Remote Tune {j}', f'Remote Band {j}')
        for i in range(1, GRID + 1):
            canonical(db, f'local:{i}', f'Kappa Song {i}', f'Kappa Artist {i}')
            for j in range(GRID):
                db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', (f'local:{i}', f'spotify:track:s{j}', 'local:spotify', 40 + i + j / 10,
                                                                            'AMBIGUOUS', dump({'conflicts': [], 'title_basis': 'x', 'artist_basis': 'y'})))
        # Human recording: a local file and its accepted Spotify twin.
        entity(db, 'spotify:track:h', 'spotify', 'Kappa Song 8', 'Kappa Artist 8', recording=f'local:{GRID + 1}', status='ACCEPTED',
               metadata={'source_observations': []})
        canonical(db, f'local:{GRID + 1}', 'Kappa Song 8', 'Human Choice', state='human')
        db.execute("INSERT INTO identity_acceptances VALUES ('local:8','spotify:track:h','human',1.0,'manual','{}','then','human',NULL)")
        db.execute("INSERT INTO canonical_blocks VALUES ('local:1','spotify:track:s0','human_rejection')")
        db.execute("INSERT INTO canonical_artists VALUES ('artist:h','Human Choice','human choice'),('artist:old','Solo Act','solo act')")
        db.execute("INSERT INTO recording_artists VALUES ('local:8','artist:h',0,'primary')")
        db.execute("INSERT INTO recording_recovery VALUES ('spotify:track:s1','wanted','then')")
        db.execute("INSERT INTO recovery_events(recording_id,state,created_at) VALUES ('spotify:track:s1','wanted','then')")
        # R1/R2: blank ISRC and artist URIs on the scalar; the Greek and the English export observations carry them.
        observations = [
            {'observation_id': 'o1', 'source_item_id': 'spotify:track:a', 'archive_sha256': zips['account1'], 'member': 'Liked.csv',
             'member_index': 0, 'position': 0, 'observed_at': None, 'observation_time_basis': 'export time not exposed',
             'metadata': {'title': 'Unique Aria', 'performer': 'Solo Act, Guest', 'isrc': 'gbaaa0000001', 'artist_uris': 'spotify:artist:x'},
             'raw_metadata': {'Όνομα κομματιού': 'Unique Aria', 'ISRC': 'gbaaa0000001', 'URI καλλιτέχνη/ων': 'spotify:artist:x', 'Δημοτικότητα': '12'}},
            {'observation_id': 'o3', 'source_item_id': 'spotify:track:a', 'archive_sha256': zips['account3'], 'member': 'Liked_Songs.csv',
             'member_index': 0, 'position': 4, 'observed_at': None, 'observation_time_basis': 'export time not exposed',
             'metadata': {'title': 'Unique Aria', 'performer': 'Solo Act;Guest', 'isrc': '', 'artist_uris': ''},
             'raw_metadata': {'Track Name': 'Unique Aria', 'Record Label': 'Label X', 'Genres': 'techno', 'Popularity': '30'}}]
        entity(db, 'spotify:track:a', 'spotify', 'Unique Aria', 'Solo Act', status='NO_CANDIDATE',
               metadata={'title': 'Unique Aria', 'performer': 'Solo Act', 'isrc': '', 'artist_uris': '', 'source_observations': observations})
        canonical(db, 'spotify:track:a', 'Unique Aria', 'Solo Act')
        db.execute("INSERT INTO recording_artists VALUES ('spotify:track:a','artist:old',0,'primary')")
        # R3/R7: a SoundCloud entity with the whole API payload, in a Likes list and in a consolidation baseline list.
        entity(db, 'soundcloud:tracks:100', 'soundcloud', 'Cloud Piece', 'Uploader', status='NO_CANDIDATE', metadata={
            'availability': 'available', 'popularity': {'likes_count': 3},
            'normalized_metadata': {'title': 'Cloud Piece', 'uploader_username': 'up', 'genre': 'dub', 'urn': 'soundcloud:tracks:100'},
            'raw_metadata': {'artwork_url': 'https://img/a.jpg', 'description': 'd', 'duration': 30000, 'user': {'id': 1, 'username': 'up'},
                             'media': {'transcodings': [1, 2, 3]}, 'genre': 'dub'}})
        canonical(db, 'soundcloud:tracks:100', 'Cloud Piece', '')
        db.execute("INSERT INTO collections VALUES ('sc:likes','Likes','soundcloud','likes',1,'{}'),('sc:ref','Set','soundcloud','source_snapshot',1,'{}')")
        db.execute("INSERT INTO memberships VALUES ('sc:likes',0,'soundcloud:tracks:100','then',?)", (dump({'raw_membership': {'big': 'x'}, 'kept': 1}),))
        db.execute("INSERT INTO memberships VALUES ('sc:ref',0,'soundcloud:tracks:100','then',?)", (dump({'raw_membership': {'y': 1}}),))
        db.execute('INSERT INTO collection_consolidations VALUES (?,?,?,?,?,?,?,?)', ('d1', 'b', 'automatic', 'consolidate', 'active',
                   dump({'kind': 'exact', 'ids': ['sc:ref'], 'hashes': {'sc:ref': fingerprint(db, 'sc:ref')}}), dump({'representative_hashes': {}}), 'then'))
        # R5: normalizer-only and real observation updates, credit-role migrations, and the human recording's decisions.
        stale = {**local_norm, 'normalization_version': 3}
        sou_event(db, 'local:1', local_meta[1], stale, local_meta[1], local_norm)
        sou_event(db, 'local:1', local_meta[1], local_norm, {**local_meta[1], 'missing': 1}, local_norm)
        credit_event(db, 'local:1')
        event(db, 'local:1', 'source_observation_added', after={'entity_id': 'local:1'})
        sou_event(db, 'local:8', local_meta[GRID + 1], stale, local_meta[GRID + 1], local_norm)
        credit_event(db, 'local:8')
        event(db, 'local:8', 'accept', {'artist': 'Kappa Artist 8'}, {'artist': 'Human Choice', 'credits': []})
        db.commit()
    with closing(sqlite3.connect(catalog)) as db:
        for track_id, raw in ((100, '{"track":{"user":{"id":1}}}'), (999, '{"only":"copy"}')):
            db.execute('INSERT INTO soundcloud_tracks(soundcloud_track_id,title,raw_json,available,fetched_at) VALUES (?,?,?,1,?)',
                       (track_id, f'Track {track_id}', raw, 'then'))
        db.commit()


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    from app.config import get_settings
    root, generation = tmp_path / 'data', tmp_path / 'data/datasets/g1'
    generation.mkdir(parents=True)
    contract = load_schema_contract()['initialization_sql']
    for name in ('catalog', 'identity'):
        with closing(sqlite3.connect(generation / f'{name}.sqlite')) as db:
            for statement in contract[name]: db.execute(statement)
    _pointer(root, 'g1', True)
    atomic_json(generation / 'exchange-state.json', initial_state('lineage-before'))
    sources, roles = tmp_path / 'sources', {}
    for role in cwl.SPOTIFY_ROLES:
        path = sources / 'inputs/spotify' / f'{role}_exportify.zip'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f'synthetic {role}'.encode())
        roles[role] = sha(path)
    archive = sources / 'data/soundcloud/archives' / f'soundcloud_{cwl.SOUNDCLOUD_SNAPSHOT}.tar.gz'
    cache = sources / 'data/soundcloud/raw' / cwl.SOUNDCLOUD_SNAPSHOT / 'tracks_cache.json'
    for path, body in ((archive, b'synthetic archive'), (cache, b'{}')):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    manifest = tmp_path / 'input_manifest.json'
    manifest.write_text(json.dumps([{'role': r, 'sha256': h} for r, h in {**roles, 'soundcloud': sha(archive)}.items()]))
    monkeypatch.setattr(cwl, 'TRACKS_CACHE_SHA256', sha(cache))
    populate(generation / 'identity.sqlite', generation / 'catalog.sqlite', roles)
    for name in ('CRATEMIND_DB_PATH', 'CRATEMIND_IDENTITY_DB_PATH'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('CRATEMIND_DATASET_ROOT', str(root))
    get_settings.cache_clear()
    stamps = iter(f'20260101T0000{n:02d}Z' for n in range(60))
    monkeypatch.setattr(cwl, 'stamp', lambda: next(stamps))
    yield root, generation, ['--json', '--sources', str(sources), '--input-manifest', str(manifest)]
    get_settings.cache_clear()


def run(capsys, argv, code=0):
    assert cwl.main(argv) == code
    return json.loads(capsys.readouterr().out)


def values(generation):
    return canonical_database_values(generation / 'identity.sqlite'), canonical_database_values(generation / 'catalog.sqlite')


def test_preview_runs_every_rule_and_leaves_both_files_byte_identical(dataset, capsys):
    root, generation, argv = dataset
    before = {name: sha(generation / name) for name in ('catalog.sqlite', 'identity.sqlite')}
    report = run(capsys, argv)
    assert report['ok'] and report['mode'] == 'preview' and report['skipped'] == {}
    assert all(report['rules'][rule]['changed'] > 0 for rule in ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R9'))
    assert {name: sha(generation / name) for name in before} == before
    assert not (root / 'backups').exists()


def test_apply_runs_each_rule_keeps_protected_rows_and_a_rerun_changes_nothing(dataset, capsys):
    root, generation, argv = dataset
    identity_before, catalog_before = values(generation)
    report = run(capsys, argv + ['--apply'])
    assert report['ok'] and all(v == 'ok' for v in report['assertions'].values())
    db = sqlite3.connect(generation / 'identity.sqlite')
    db.row_factory = sqlite3.Row
    meta, norm = (json.loads(x) for x in db.execute("SELECT metadata_json,normalized_json FROM entities WHERE id='spotify:track:a'").fetchone())
    # R1: filled from the entity's own observations; the conflicting performer stays as alternatives (R2).
    assert (meta['isrc'], meta['artist_uris'], meta['performer']) == ('gbaaa0000001', 'spotify:artist:x', 'Solo Act')
    assert (norm['isrc'], norm['isrc_key'], norm['label'], norm['genre']) == ('gbaaa0000001', 'GBAAA0000001', 'Label X', 'techno')
    repair = json.loads(db.execute("SELECT after_json FROM canonical_events WHERE action='source_observation_repair'").fetchone()[0])
    assert repair['format'] == 'diff-v1' and set(repair['changed']) == {'isrc', 'artist_uris'}
    assert report['rules']['R1']['recordings_refreshed'] == ['spotify:track:a'] and 'spotify:track:a' in report['rules']['R1']['credit_changes']
    assert db.execute("SELECT artist_id FROM recording_artists WHERE recording_id='spotify:track:a'").fetchone()[0] == 'spotify:artist:x'
    # R2: observations keep provenance and popularity only.
    assert meta['alternatives']['performer'] == ['Solo Act, Guest', 'Solo Act;Guest']
    assert all(set(o) <= {*SPOTIFY_OBSERVATION_KEEP, 'raw_metadata'} for o in meta['source_observations'])
    assert sorted(dump(o['raw_metadata']) for o in meta['source_observations']) == ['{"Popularity": "30"}', '{"Δημοτικότητα": "12"}']
    # R3: only the keys cards and mirrors read survive in the SoundCloud payload.
    sc = json.loads(db.execute("SELECT metadata_json FROM entities WHERE id='soundcloud:tracks:100'").fetchone()[0])
    assert sc['raw_metadata'] == {'artwork_url': 'https://img/a.jpg', 'description': 'd', 'duration': 30000} and sc['normalized_metadata']['genre'] == 'dub'
    # R4: the rows no endpoint ranks (top-3 per local, Recovery top-5 per remote) are gone; the blocked pair stays.
    pairs = {(r[0], r[1]) for r in db.execute('SELECT left_id,right_id FROM candidates')}
    doomed = {(f'local:{i + 1}', f'spotify:track:s{j}') for i in (0, 1) for j in range(4)} - {('local:1', 'spotify:track:s0')}
    assert not doomed & pairs and ('local:1', 'spotify:track:s0') in pairs and ('local:7', 'spotify:track:s0') in pairs
    assert report['rules']['R4']['pruned'] >= len(doomed)
    assert not db.execute("SELECT 1 FROM candidates WHERE evidence_json LIKE '%title_basis%'").fetchone()
    # R5: normalizer-only updates gone, other updates and machine credit migrations compacted, human history verbatim.
    events = [dict(r) for r in db.execute('SELECT recording_id,action,before_json,after_json FROM canonical_events ORDER BY id')]
    local1 = [(e['action'], e['before_json'] is None, json.loads(e['after_json'] or 'null')) for e in events if e['recording_id'] == 'local:1']
    assert [a for a, *_ in local1] == ['source_observation_update', 'credit_semantics_v2', 'source_observation_added']
    assert local1[0][2] == {'format': 'diff-v1', 'entity_id': 'local:1', 'changed': {'missing': [0, 1]}, 'normalized_changed': {}} and local1[0][1]
    assert local1[1][2]['format'] == 'role-diff-v1' and local1[1][2]['credits'] == [[0, 'artist:a', 'A', 'primary', 'collaborator']]
    human = [e for e in events if e['recording_id'] == 'local:8']
    assert [e['action'] for e in human] == ['credit_semantics_v2', 'accept'] and human[0]['before_json'] is not None
    # R6: proposal copies dropped except on the human recording.
    evidence = dict(db.execute('SELECT recording_id,evidence_json FROM canonical_recordings').fetchall())
    assert 'proposal' not in json.loads(evidence['local:1']) and 'proposal' in json.loads(evidence['local:8'])
    # R7: raw_membership dropped outside consolidation baselines; the stored baseline hash still matches.
    sources = dict(db.execute('SELECT collection_id,source_json FROM memberships').fetchall())
    assert json.loads(sources['sc:likes']) == {'kept': 1} and 'raw_membership' in json.loads(sources['sc:ref'])
    db.row_factory = sqlite3.Row
    baseline = json.loads(db.execute("SELECT baseline_json FROM collection_consolidations").fetchone()[0])
    assert fingerprint(db, 'sc:ref') == baseline['hashes']['sc:ref']
    db.close()
    # R9: catalog raw_json blanked where an identity entity exists; the orphan keeps its only copy.
    with closing(sqlite3.connect(generation / 'catalog.sqlite')) as catalog:
        assert dict(catalog.execute('SELECT soundcloud_track_id,raw_json FROM soundcloud_tracks')) == {100: '{}', 999: '{"only":"copy"}'}
    identity_after, catalog_after = values(generation)
    for table in ('identity_acceptances', 'canonical_blocks', 'canonical_base_entities', 'recording_recovery', 'recovery_events',
                  'collections', 'collection_consolidations', 'canonical_patterns'):
        assert identity_after.get(table) == identity_before.get(table), table
    human_row = lambda v: [r for r in v['canonical_recordings'] if r['state'] == 'human']
    assert human_row(identity_after) == human_row(identity_before)
    positions = lambda v: [{k: r.get(k) for k in ('collection_id', 'position', 'entity_id', 'added_at')} for r in v['memberships']]
    assert positions(identity_after) == positions(identity_before)
    assert {k: v for k, v in catalog_after.items() if k != 'soundcloud_tracks'} == {k: v for k, v in catalog_before.items() if k != 'soundcloud_tracks'}
    backup = Path(report['backup']['directory'])
    assert backup.parent == root / 'backups' and len(list(backup.glob('cratemind-*'))) == 1
    assert json.loads((backup / 'exchange-state.json').read_text())['lineage_id'] == 'lineage-before'
    assert json.loads((backup / 'report.json').read_text())['ok']
    again = run(capsys, argv + ['--apply'])
    assert again['ok'] and all(rule['changed'] == 0 for rule in again['rules'].values())
    assert again['drift'] == {'near_ties': 0, 'statuses': 0} and again['backup']['earliest'] == str(backup)
    assert all(rule['changed'] == 0 for rule in run(capsys, argv)['rules'].values())


def test_injected_assertion_failure_rolls_back_and_exits_nonzero(dataset, capsys, monkeypatch):
    root, generation, argv = dataset
    before = values(generation)
    original = cwl.r6_evidence
    def tamper(db):
        db.execute("UPDATE canonical_recordings SET artist='Overwritten' WHERE state='human'")
        return original(db)
    monkeypatch.setattr(cwl, 'r6_evidence', tamper)
    report = run(capsys, argv + ['--apply'], code=1)
    assert report['assertions']['protected_tables'] == {'failed': ['canonical_recordings.protected']}
    assert 'R9' not in report['rules'] and values(generation) == before
    assert not json.loads((Path(report['backup']['directory']) / 'report.json').read_text())['ok']


def test_unverified_cold_copies_skip_only_their_rules(dataset, capsys):
    root, generation, argv = dataset
    sources = Path(argv[argv.index('--sources') + 1])
    (sources / 'inputs/spotify/account2_exportify.zip').unlink()
    (sources / 'data/soundcloud/raw' / cwl.SOUNDCLOUD_SNAPSHOT / 'tracks_cache.json').write_text('edited')
    report = run(capsys, argv)
    assert report['ok'] and set(report['skipped']) == {'R2', 'R3', 'R7'}
    assert all(report['rules'][rule] == {'changed': 0, 'skipped': report['skipped'][rule]} for rule in ('R2', 'R7'))
    assert report['rules']['R3']['changed'] == 0 and report['rules']['R3']['source_keys_dropped'] == []
    assert all(report['rules'][rule]['changed'] > 0 for rule in ('R1', 'R4', 'R5', 'R6', 'R9'))


def test_observation_from_an_unverified_archive_skips_r2(dataset, capsys):
    root, generation, argv = dataset
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        entity(db, 'spotify:track:z', 'spotify', 'Other', 'Other', metadata={'source_observations': [{'archive_sha256': 'not-in-manifest'}]})
        db.commit()
    report = run(capsys, argv)
    assert report['ok'] and report['rules']['R2']['changed'] == 0 and 'R2' in report['skipped']


def test_partial_apply_rerun_then_rollback_restores_the_pre_cleanup_pair_and_saved_exchange_state(dataset, capsys, monkeypatch):
    root, generation, argv = dataset
    pristine, saved_state = values(generation), (generation / 'exchange-state.json').read_text()
    original = cwl.clean_catalog
    def failing_catalog(db, report, ids):
        db.execute('BEGIN IMMEDIATE')
        cwl.check(report, 'injected_catalog_failure', False)
    monkeypatch.setattr(cwl, 'clean_catalog', failing_catalog)
    first = run(capsys, argv + ['--apply'], code=1)
    monkeypatch.setattr(cwl, 'clean_catalog', original)
    second = run(capsys, argv + ['--apply'])
    assert second['rules']['R1']['changed'] == 0 and second['rules']['R9']['changed'] == 1
    assert second['backup']['earliest'] == first['backup']['directory'] != second['backup']['directory']
    (generation / 'exchange-state.json').write_text('{"later": "export"}')
    rolled = run(capsys, ['--json', '--rollback', first['backup']['directory']])
    active = json.loads((root / 'active.json').read_text())
    assert rolled['previous_generation'] == 'g1' and active['generation'] == rolled['generation'] != 'g1'
    restored = root / 'datasets' / active['generation']
    assert values(restored) == pristine and (restored / 'exchange-state.json').read_text() == saved_state
    assert (generation / 'identity.sqlite').is_file() and (generation / 'catalog.sqlite').is_file()


def test_refuses_while_the_dataset_lease_is_held(dataset):
    root, generation, argv = dataset
    before = {name: sha(generation / name) for name in ('catalog.sqlite', 'identity.sqlite')}
    with DatasetLease.acquire(root, 'idle-service'), pytest.raises(DatasetBusyError):
        cwl.main(argv + ['--apply'])
    assert {name: sha(generation / name) for name in before} == before and not (root / 'backups').exists()
