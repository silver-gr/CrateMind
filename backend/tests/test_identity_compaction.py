import json
import random

from app.services import canonical_library as canonical
from app.services import identity_compaction as ic
from tests.test_canonical import fixture_db


def make_db():
    db = fixture_db()
    db.executescript(canonical.SCHEMA)
    return db


def add(db, sid, service, recording=None, metadata=None, local_id=None):
    recording = recording or sid
    db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)', (recording, sid, 'PROVISIONAL'))
    if service == 'local' and local_id is None:
        local_id = int(sid.split(':')[1])
    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',
               (sid, service, sid, 'A', 300000, local_id, None, recording, 'NO_CANDIDATE',
                json.dumps(metadata or {}), '{}'))


def cand(db, a, b, cls='AMBIGUOUS', score=70, **evidence):
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', (a, b, 'x', score, cls, json.dumps(evidence)))


def pairs(db):
    return {tuple(r) for r in db.execute('SELECT left_id,right_id FROM candidates')}


def test_slim_candidate_evidence():
    ev = {'title_basis': 1, 'artist_basis': 2, 'metadata_authority': 3, 'shared_scoring_service': 4, 'conflicts': ['x'], 'near_tie_review': True}
    assert ic.slim_candidate_evidence(ev) == {'conflicts': ['x'], 'near_tie_review': True}
    assert 'title_basis' in ev
    assert ic.slim_candidate_evidence(ic.slim_candidate_evidence(ev)) == {'conflicts': ['x'], 'near_tie_review': True}


def test_slim_canonical_evidence_drops_only_proposals():
    ev = {'proposal': {'a': 1}, 'keep': 1, 'observations': [{'proposal': {}, 'id': 'x'}, {'id': 'y'}]}
    out = ic.slim_canonical_evidence(ev)
    assert out == {'keep': 1, 'observations': [{'id': 'x'}, {'id': 'y'}]}
    assert ev['observations'][0]['proposal'] == {}
    assert ic.slim_canonical_evidence(out) == out
    assert ic.slim_canonical_evidence({'observations': 'text'}) == {'observations': 'text'}


def test_compact_spotify_observation_keeps_popularity_only_and_is_idempotent():
    obs = {'observation_id': 'o', 'source_item_id': 's', 'archive_sha256': 'h', 'member': 'liked.csv', 'member_index': 0,
           'position': 3, 'observed_at': None, 'observation_time_basis': 'b', 'metadata': {'title': 'T'},
           'raw_metadata': {'Δημοτικότητα': '5', 'Όνομα κομματιού': 'T'}}
    out = ic.compact_spotify_observation(obs)
    assert out == {**{k: obs[k] for k in ic.SPOTIFY_OBSERVATION_KEEP}, 'raw_metadata': {'Δημοτικότητα': '5'}}
    assert ic.compact_spotify_observation(out) == out
    english = ic.compact_spotify_observation({**obs, 'raw_metadata': {'Popularity': '9', 'Track Name': 'T'}})
    assert english['raw_metadata'] == {'Popularity': '9'}
    assert ic.compact_spotify_observation({**obs, 'raw_metadata': {'Track Name': 'T'}})['raw_metadata'] == {}


def test_compact_keeps_provider_resolution_source_identical():
    from app.services.provider_resolution import source
    obs = [{'observation_id': 'o1', 'archive_sha256': 'h', 'position': 1, 'metadata': {'title': 'T'},
            'raw_metadata': {'Popularity': '7', 'ISRC': 'X'}},
           {'observation_id': 'o2', 'archive_sha256': 'h2', 'position': 2, 'raw_metadata': {'Δημοτικότητα': '1', 'x': 'y'}}]
    entity = {'id': 'spotify:track:1', 'service': 'spotify', 'recording_id': 'r', 'permalink': 'u', 'artist': 'A', 'title': 'T',
              'duration_ms': 1.0, 'normalized_json': '{"album":"Al"}',
              'metadata_json': json.dumps({'source_observations': obs, 'availability': 'unknown'})}
    compact = {**entity, 'metadata_json': json.dumps({'source_observations': [ic.compact_spotify_observation(o) for o in obs],
                                                      'availability': 'unknown'})}
    assert source(entity) == source(compact)


def test_slim_soundcloud_raw():
    raw = {'artwork_url': 'a', 'publisher_metadata': {'p': 1}, 'description': 'd', 'tag_list': 't', 'waveform_url': 'w',
           'duration': 30000, 'full_duration': 300000, 'downloadable': False, 'comment_count': 4, 'user': {'big': 1}}
    out = ic.slim_soundcloud_raw(raw)
    assert set(out) == set(ic.SOUNDCLOUD_RAW_KEEP)
    assert ic.slim_soundcloud_raw(out) == out
    assert ic.slim_soundcloud_raw({'comment_count': 1}) == {}


def obs(archive, position, **fields):
    raw = fields.pop('raw', {})
    return {'archive_sha256': archive, 'member': 'liked.csv', 'position': position, 'observation_id': f'{archive}{position}',
            'metadata': fields, 'raw_metadata': raw}


def test_spotify_alternatives_reports_only_disagreement():
    meta = {'title': 'Song', 'performer': 'A;B', 'isrc': 'I1', 'artist_uris': 'u1',
            'source_observations': [obs('a', 1, title='Song', performer='A;B', isrc='I1', artist_uris='u1'),
                                    obs('b', 1, title='Song', performer='A, B', isrc='', artist_uris='u1')]}
    assert ic.spotify_alternatives(meta) == {'performer': ['A, B']}
    meta['source_observations'] = meta['source_observations'][:1]
    assert ic.spotify_alternatives(meta) == {}
    assert ic.spotify_alternatives({}) == {}


def test_spotify_alternatives_raw_headers_english_and_greek():
    meta = {'title': 'Song', 'source_observations': [
        obs('a', 1, title='Song', raw={'Album Name': 'Al', 'Record Label': 'L1', 'Genres': 'techno', 'Duration (ms)': '1000'}),
        obs('b', 1, title='Song', raw={'Όνομα άλμπουμ': 'Al2', 'Είδη καλλιτέχνη': 'house', 'Record Label': 'L2'}, duration_ms=1000.0)]}
    out = ic.spotify_alternatives(meta)
    assert out == {'album': ['Al2'], 'label': ['L2'], 'genres': ['house']}


def test_repair_fills_blank_only_and_is_deterministic():
    meta = {'title': 'T', 'isrc': '', 'artist_uris': None, 'performer': 'Keep', 'source_observations': [
        obs('b', 1, isrc='ZZ', artist_uris='ub', performer='Other'),
        obs('a', 9, isrc='AA', artist_uris='ua', performer='Other2'),
        obs('a', 2, isrc='AB', artist_uris='uc')]}
    new, changes = ic.repair_spotify_metadata(meta)
    assert new['isrc'] == 'AB' and new['artist_uris'] == 'uc' and new['performer'] == 'Keep'
    assert changes == {'isrc': ['', 'AB'], 'artist_uris': [None, 'uc']}
    assert meta['isrc'] == ''
    assert ic.repair_spotify_metadata(new)[1] == {}
    reversed_meta = {**meta, 'source_observations': list(reversed(meta['source_observations']))}
    assert {k: v for k, v in ic.repair_spotify_metadata(reversed_meta)[0].items() if k != 'source_observations'} == \
        {k: v for k, v in new.items() if k != 'source_observations'}


def test_repair_label_genre_only_when_normalized_blank():
    meta = {'source_observations': [obs('a', 1, raw={'Record Label': 'Lab', 'Genres': 'techno'})]}
    assert ic.repair_spotify_metadata(meta)[1] == {}
    assert ic.repair_spotify_metadata(meta, {'label': None, 'genre': ''})[1] == {'label': [None, 'Lab'], 'genre': ['', 'techno']}
    assert ic.repair_spotify_metadata(meta, {'label': 'Kept', 'genre': 'x'})[1] == {}


def test_merge_spotify_items():
    o1, o2 = obs('a', 1), obs('b', 1)
    primary = {'title': 'Song', 'isrc': '', 'performer': 'A;B', 'source_observations': [o1]}
    other = {'title': 'Song 2', 'isrc': 'I1', 'performer': '', 'album': None, 'source_observations': [o1, o2]}
    merged = ic.merge_spotify_items(primary, other)
    assert merged['title'] == 'Song' and merged['isrc'] == 'I1' and merged['performer'] == 'A;B'
    assert merged['alternatives'] == {'title': ['Song 2']}
    assert [o['observation_id'] for o in merged['source_observations']] == ['a1', 'b1']
    assert primary['isrc'] == ''
    assert ic.merge_spotify_items(merged, other) == merged
    assert ic.merge_spotify_items(merged, merged) == merged
    third = ic.merge_spotify_items(merged, {'title': 'Alpha'})
    assert third['alternatives']['title'] == ['Alpha', 'Song 2']
    assert 'alternatives' not in ic.merge_spotify_items({'title': 'x'}, {'title': 'x', 'isrc': ''})
    # a richer later observation does not lose to an empty first one, in either order
    assert ic.merge_spotify_items({'isrc': 'I'}, {'isrc': None})['isrc'] == 'I'
    assert ic.merge_spotify_items({'isrc': None}, {'isrc': 'I'})['isrc'] == 'I'


def test_observation_diff():
    meta = {'title': 'A', 'isrc': ''}
    norm = {'title': 'a', 'normalization_version': 3, 'title_variants': [1], 'artist_variants': [1], 'label': None}
    assert ic.observation_diff(meta, dict(meta), norm, dict(norm), 'e1') is None
    diff = ic.observation_diff(meta, {**meta, 'isrc': 'I'}, norm,
                               {**norm, 'normalization_version': 4, 'title_variants': [2], 'label': 'L'}, 'e1')
    assert diff == {'format': 'diff-v1', 'entity_id': 'e1', 'changed': {'isrc': ['', 'I']}, 'normalized_changed': {'label': [None, 'L']}}
    kind = ic.observation_diff(meta, dict(meta), {**norm, 'kind': 'track'}, {**norm, 'kind': 'long_form'}, 'e3')
    assert kind == {'format': 'diff-v1', 'entity_id': 'e3', 'changed': {}, 'normalized_changed': {'kind': ['track', 'long_form']}}
    assert ic.observation_diff(meta, dict(meta), norm, {**norm, 'normalization_version': 9, 'title_variants': []}, 'e1') is None
    added = ic.observation_diff({}, {'new': 1}, {}, {}, 'e2')
    assert added['changed'] == {'new': [None, 1]}


# --- shortlist ---------------------------------------------------------------------------------------------------------
def shortlist_fixture():
    db = make_db()
    # local entities 1..4 current; spotify s1..s12 (own recordings); a retired local; a soundcloud
    for i in range(1, 5):
        add(db, f'local:{i}', 'local', recording='rcur' if i == 4 else None)
    add(db, 'local:9', 'local', metadata={'asset_lifecycle': {'state': 'retired'}})
    for i in range(1, 13):
        add(db, f'spotify:track:s{i:02d}', 'spotify', recording='rcur')  # not remote-only: Recovery keeps nothing here
    add(db, 'soundcloud:1', 'soundcloud', recording='rcur')
    return db


def test_shortlist_keeps_mandatory_rows_and_top_three():
    db = shortlist_fixture()
    s = lambda i: f'spotify:track:s{i:02d}'
    cand(db, 'local:1', s(1), 'HIGH_CONFIDENCE', 95)                       # class
    cand(db, 'local:1', s(2), 'AMBIGUOUS', 40)                            # acceptance
    db.execute("INSERT INTO identity_acceptances VALUES ('local:1',?,'x',1,'m','{}','t','human','2026-01-01')", (s(2),))
    cand(db, s(3), 'local:1', 'CONFLICT', 20)                             # block (reverse order)
    db.execute("INSERT INTO canonical_blocks VALUES ('local:1',?,'human_rejection')", (s(3),))
    for i, marker in enumerate(['near_tie_review', 'near_tie_original_class', 'historical_provenance', 'revoked_identity_decision', 'anchor'], 4):
        cand(db, 'local:1', s(i), 'AMBIGUOUS', 10, **{marker: {'x': 1} if marker == 'anchor' else True})
    cand(db, 'local:1', s(9), 'CONFLICT', 10, conflicts=['previously_rejected'])
    cand(db, 'local:2', s(10), 'AMBIGUOUS', 61)                           # display pool (current local x provider >= 60)
    cand(db, 'local:2', s(11), 'AMBIGUOUS', 59)                           # top-3 for local:2, not pool
    cand(db, 'local:9', s(12), 'AMBIGUOUS', 10)                           # retired endpoint, nothing protects it
    kept = ic.shortlist_keep(db)
    assert kept == pairs(db) - {('local:9', s(12))}
    assert ic.shortlist_prune(db) == 1
    assert ('local:9', s(12)) not in pairs(db)
    assert ic.shortlist_prune(db) == 0


def test_shortlist_top_three_is_by_class_then_score_then_other_id():
    db = shortlist_fixture()
    s = lambda i: f'spotify:track:s{i:02d}'
    # pool needs score >= 60, so keep everything below that; ranking sees class first, then score, then other id
    cand(db, 'local:3', s(1), 'CONFLICT', 59)
    cand(db, 'local:3', s(2), 'AMBIGUOUS', 40)
    cand(db, 'local:3', s(3), 'AMBIGUOUS', 50)
    cand(db, 'local:3', s(5), 'AMBIGUOUS', 40)
    cand(db, 'local:3', s(4), 'AMBIGUOUS', 40)
    # the other endpoints each only have this one row, so they keep it themselves unless their endpoint is ineligible
    db.execute("UPDATE entities SET metadata_json='{\"catalog_current\": false}' WHERE service='spotify'")
    kept = ic.shortlist_keep(db)
    assert kept == set()  # ineligible endpoints: nothing ranks, nothing mandatory
    db.execute("UPDATE entities SET metadata_json='{}'")
    db.execute("UPDATE entities SET metadata_json='{\"catalog_current\": false}' WHERE id IN (?,?)", (s(1), s(5)))
    # s01 and s05 now ineligible: their rows cannot rank, remaining rows for local:3: s03(50), s02(40), s04(40)
    kept = ic.shortlist_keep(db)
    assert {r for r in kept} == {('local:3', s(3)), ('local:3', s(2)), ('local:3', s(4))}


def test_shortlist_recovery_top_five_per_remote_only_recording():
    db = shortlist_fixture()
    for i in range(1, 8):  # 7 non-current locals linking to one remote-only recording
        add(db, f'local:{100 + i}', 'local', metadata={'asset_lifecycle': {'state': 'retired'}})
    add(db, 'spotify:track:r', 'spotify')
    for i in range(1, 8):
        cand(db, f'local:{100 + i}', 'spotify:track:r', 'AMBIGUOUS', 10 + i)
    kept = ic.shortlist_keep(db)
    # retired locals make every row ineligible for ranking; Recovery keeps the best five by score
    assert kept == {(f'local:{100 + i}', 'spotify:track:r') for i in range(3, 8)}
    add(db, 'local:108', 'local', metadata={'asset_lifecycle': {'state': 'retired'}})
    cand(db, 'local:108', 'spotify:track:r', 'AMBIGUOUS', 13)  # tied with the 5th: Recovery's scan order may show it
    assert ic.shortlist_keep(db) == kept | {('local:108', 'spotify:track:r')}


def test_scoped_shortlist_equals_global_restricted():
    rng = random.Random(3)
    db = shortlist_fixture()
    for i in range(1, 20):
        add(db, f'spotify:track:x{i:02d}', 'spotify', recording=f'rx{i}' if i % 3 else 'rshared')
    locals_ = [f'local:{i}' for i in (1, 2, 3, 4, 9)]
    others = [r[0] for r in db.execute("SELECT id FROM entities WHERE service!='local'")]
    seen = set()
    for _ in range(90):
        a, b = rng.choice(locals_), rng.choice(others)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        cand(db, a, b, rng.choice(['AMBIGUOUS', 'AMBIGUOUS', 'CONFLICT', 'PROBABLE']), rng.choice([30, 45, 55, 62, 80]))
    db.execute("UPDATE entities SET metadata_json='{\"catalog_current\": false}' WHERE id IN (?,?)", (others[0], others[1]))
    glob = ic.shortlist_keep(db)
    everything = pairs(db)
    assert 0 < len(glob) < len(everything)
    entities = [r[0] for r in db.execute('SELECT id FROM entities')]
    for _ in range(25):
        chosen = set(rng.sample(entities, rng.choice([1, 2, 5])))
        incident = {p for p in everything if p[0] in chosen or p[1] in chosen}
        assert ic.shortlist_keep(db, chosen) == glob & incident
    chosen = set(rng.sample(entities, 6))
    incident = {p for p in everything if p[0] in chosen or p[1] in chosen}
    removed = ic.shortlist_prune(db, chosen)
    assert pairs(db) == everything - (incident - glob) and removed == len(incident - glob)
    assert ic.shortlist_prune(db, chosen) == 0
    assert ic.shortlist_prune(db, []) == 0
    ic.shortlist_prune(db)
    assert pairs(db) == glob


def test_near_tie_witness_rows_are_kept():
    db = shortlist_fixture()
    s = lambda i: f'spotify:track:s{i:02d}'
    # near-tie row l1-s1 (score 50); witnesses incident to either endpoint within 5 points survive, others are prunable
    cand(db, 'local:1', s(1), 'AMBIGUOUS', 50, near_tie_review=True)
    cand(db, 'local:2', s(1), 'AMBIGUOUS', 46)      # incident to right endpoint, within 5
    cand(db, 'local:1', s(2), 'AMBIGUOUS', 45)      # incident to left endpoint, within 5
    cand(db, s(3), 'local:1', 'AMBIGUOUS', 46)  # reverse orientation
    # fill local:1 and s1 with better rows so the witnesses do not rank into the top three
    for i in range(4, 8):
        cand(db, 'local:1', s(i), 'PROBABLE', 90)
    cand(db, 'local:3', s(1), 'PROBABLE', 90)
    cand(db, 'local:4', s(1), 'PROBABLE', 90)
    cand(db, 'local:1', s(8), 'AMBIGUOUS', 44)      # too low to witness (< 45)
    kept = ic.shortlist_keep(db)
    for p in (('local:1', s(1)), ('local:2', s(1)), ('local:1', s(2)), (s(3), 'local:1')):
        assert p in kept
    assert ic.shortlist_keep(db, {s(1)}) == {p for p in kept if s(1) in p}


# --- settled suggestions (R11) ---------------------------------------------------------------------------------------
def test_settled_drops_leftovers_on_linked_locals_and_keeps_protected_rows():
    db = shortlist_fixture()  # local:4 shares its recording with soundcloud:1, i.e. it is already linked to SoundCloud
    sc = lambda i: f'soundcloud:{i + 10}'
    for i in range(12):
        add(db, sc(i), 'soundcloud')
    add(db, 'spotify:track:o', 'spotify')
    add(db, 'soundcloud:9', 'soundcloud', recording='local:9')  # the retired local's recording is linked, but it is not current
    cand(db, 'local:4', sc(0), 'AMBIGUOUS', 40)                  # dropped
    cand(db, sc(1), 'local:4', 'CONFLICT', 30)                   # dropped (reverse orientation)
    cand(db, 'local:4', sc(2), 'PROBABLE', 50)                   # class
    cand(db, 'local:4', sc(3), 'AMBIGUOUS', 40)                  # revoked acceptance
    db.execute("INSERT INTO identity_acceptances VALUES ('local:4',?,'x',1,'m','{}','t','human','2026-01-01')", (sc(3),))
    cand(db, 'local:4', sc(4), 'AMBIGUOUS', 40)                  # block
    db.execute("INSERT INTO canonical_blocks VALUES (?,'local:4','hard_guard_or_near_tie')", (sc(4),))
    for i, marker in enumerate(['near_tie_original_class', 'historical_provenance', 'revoked_identity_decision', 'anchor'], 5):
        cand(db, 'local:4', sc(i), 'AMBIGUOUS', 40, **{marker: {'x': 1} if marker == 'anchor' else True})
    cand(db, 'local:4', sc(9), 'CONFLICT', 20, conflicts=['previously_rejected'])
    cand(db, 'local:4', sc(10), 'AMBIGUOUS', 50, near_tie_review=True)
    cand(db, 'local:4', sc(11), 'AMBIGUOUS', 47)                 # near-tie witness (>= 50 - 5)
    cand(db, 'local:1', sc(0), 'AMBIGUOUS', 40)                  # local:1 is not linked to SoundCloud
    cand(db, 'local:4', 'spotify:track:o', 'AMBIGUOUS', 40)      # not a SoundCloud suggestion
    cand(db, 'local:9', sc(1), 'AMBIGUOUS', 40)                  # not a current local
    cand(db, 'local:4', 'soundcloud:1', 'AMBIGUOUS', 40)         # same recording
    er3, settled = ic.shortlist_keep(db), ic.shortlist_keep(db, settled=True)
    assert er3 == pairs(db) and er3 - settled == {('local:4', sc(0)), (sc(1), 'local:4')} and settled < er3
    assert ic.shortlist_keep(db, {'local:4'}, settled=True) == {p for p in settled if 'local:4' in p}
    assert ic.shortlist_prune(db) == 0 and ic.shortlist_prune(db, settled=True) == 2
    assert pairs(db) == settled and ic.shortlist_prune(db, settled=True) == 0


def test_settled_scoped_shortlist_equals_global_restricted():
    rng = random.Random(5)
    db = shortlist_fixture()
    for i in range(14):
        add(db, f'soundcloud:{i + 10}', 'soundcloud', recording='rcur' if i == 0 else 'rsc' if i < 3 else None)
    add(db, 'soundcloud:9', 'soundcloud', recording='local:2')
    locals_ = [f'local:{i}' for i in (1, 2, 3, 4, 9)]
    others = [r[0] for r in db.execute("SELECT id FROM entities WHERE service!='local'")]
    seen = set()
    for _ in range(140):
        a, b = rng.choice(locals_), rng.choice(others)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        marker = rng.choice([{}] * 10 + [{'near_tie_review': True}, {'historical_provenance': True}])
        cand(db, a, b, rng.choice(['AMBIGUOUS', 'AMBIGUOUS', 'CONFLICT', 'PROBABLE']), rng.choice([30, 45, 48, 55, 62, 80]), **marker)
    glob, everything = ic.shortlist_keep(db, settled=True), pairs(db)
    assert 0 < len(glob) and glob < ic.shortlist_keep(db)
    entities = [r[0] for r in db.execute('SELECT id FROM entities')]
    for _ in range(25):
        chosen = set(rng.sample(entities, rng.choice([1, 2, 5])))
        incident = {p for p in everything if p[0] in chosen or p[1] in chosen}
        assert ic.shortlist_keep(db, chosen, settled=True) == glob & incident
    chosen = set(rng.sample(entities, 6))
    incident = {p for p in everything if p[0] in chosen or p[1] in chosen}
    assert ic.shortlist_prune(db, chosen, settled=True) == len(incident - glob)
    # The settled drop happens after the ER3 ranking, so a row a dropped row outranked may rank in on a later prune.
    ic.shortlist_prune(db, settled=True)
    assert pairs(db) >= glob and ic.shortlist_prune(db, settled=True) == 0
