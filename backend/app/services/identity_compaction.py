"""Shared, deterministic payload compaction and candidate-shortlist rules for the identity database.

Used by the working-library cleanup command and by the writers that would otherwise regrow what it removed.
"""
from __future__ import annotations
import copy
import json

SLIM_EVIDENCE_KEYS = ('title_basis', 'artist_basis', 'metadata_authority', 'shared_scoring_service')
# duration/full_duration/downloadable: the catalog mirror (identity_sync._legacy_soundcloud_snapshot) parses them first.
SOUNDCLOUD_RAW_KEEP = ('artwork_url', 'publisher_metadata', 'description', 'tag_list', 'waveform_url',
                       'duration', 'full_duration', 'downloadable')
SPOTIFY_OBSERVATION_KEEP = ('observation_id', 'source_item_id', 'archive_sha256', 'member', 'member_index',
                            'position', 'observed_at', 'observation_time_basis')
POPULARITY_KEYS = ('Popularity', 'Δημοτικότητα')
SHORTLIST_RULE_VERSION = 'er3-v1'
_NORMALIZED_DIFF_SKIP = {'normalization_version', 'title_variants', 'artist_variants'}


def _empty(value):
    return value is None or value == '' or value == [] or value == {}


def slim_candidate_evidence(evidence):
    return {k: v for k, v in evidence.items() if k not in SLIM_EVIDENCE_KEYS}


def slim_canonical_evidence(evidence):
    result = {k: v for k, v in evidence.items() if k != 'proposal'}
    if isinstance(result.get('observations'), list):
        result['observations'] = [{k: v for k, v in o.items() if k != 'proposal'} if isinstance(o, dict) else o
                                  for o in result['observations']]
    return result


def compact_spotify_observation(obs):
    result = {k: obs[k] for k in SPOTIFY_OBSERVATION_KEEP if k in obs}
    if 'raw_metadata' in obs:
        raw = obs['raw_metadata'] or {}
        result['raw_metadata'] = {k: raw[k] for k in POPULARITY_KEYS if k in raw}
    return result


def slim_soundcloud_raw(raw):
    return {k: raw[k] for k in SOUNDCLOUD_RAW_KEEP if k in raw}


# --- Spotify same-ID observations ------------------------------------------------------------------------------------
# field -> (key in the parsed observation metadata, Exportify headers: English, Greek)
_OBS_FIELDS = {
    'title': ('title', ('Track Name', 'Όνομα κομματιού')),
    'performer': ('performer', ('Artist Name(s)', 'Όνομα/τα καλλιτέχνη')),
    'artist_uris': ('artist_uris', ('Artist URI(s)', 'URI καλλιτέχνη/ων')),
    'album': (None, ('Album Name', 'Όνομα άλμπουμ')),
    'release_date': ('release_date', ('Release Date', 'Ημερομηνία κυκλοφορίας άλμπουμ')),
    'isrc': ('isrc', ('ISRC',)),
    'duration_ms': ('duration_ms', ('Duration (ms)', 'Διάρκεια κομματιού (ms)')),
    'label': (None, ('Record Label',)),
    'genres': (None, ('Genres', 'Είδη καλλιτέχνη')),
}


def _observations(metadata):
    obs = [o for o in (metadata.get('source_observations') or []) if isinstance(o, dict)]
    return sorted(obs, key=lambda o: (str(o.get('archive_sha256') or ''), str(o.get('member') or ''),
                                      o['position'] if isinstance(o.get('position'), int) else 0))


def _clean(value):
    return value.strip() if isinstance(value, str) else value


def _obs_value(obs, field):
    key, headers = _OBS_FIELDS[field]
    value = _clean((obs.get('metadata') or {}).get(key)) if key else None
    if _empty(value):
        raw = obs.get('raw_metadata') or {}
        value = next((_clean(raw[h]) for h in headers if not _empty(_clean(raw.get(h)))), None)
        if field == 'duration_ms' and isinstance(value, str):
            try:
                value = float(value)
            except ValueError:
                value = None
    return None if _empty(value) else value


def spotify_alternatives(metadata):
    """Distinct non-empty observation values that differ from the chosen one (first by archive/member/position)."""
    observations = _observations(metadata)
    result = {}
    for field in _OBS_FIELDS:
        values = [v for v in (_obs_value(o, field) for o in observations) if v is not None]
        chosen = _clean(metadata.get(field))
        if _empty(chosen):
            chosen = values[0] if values else None
        distinct = {json.dumps(v, sort_keys=True, ensure_ascii=False): v for v in values
                    if json.dumps(v, sort_keys=True, ensure_ascii=False) != json.dumps(chosen, sort_keys=True, ensure_ascii=False)}
        if distinct:
            result[field] = [distinct[k] for k in sorted(distinct)]
    return result


def repair_spotify_metadata(metadata, normalized=None):
    """Fill blank isrc/artist_uris/performer from the entity's own observations; never overwrite.

    With `normalized`, `label`/`genre` are also reported when blank there and derivable from an observation.
    """
    result, changes = dict(metadata), {}
    observations = _observations(metadata)
    for field in ('isrc', 'artist_uris', 'performer'):
        if not _empty(result.get(field)):
            continue
        value = next((v for v in (_obs_value(o, field) for o in observations) if v is not None), None)
        if value is not None:
            changes[field] = [result.get(field), value]
            result[field] = value
    if normalized is not None:
        for field, source in (('label', 'label'), ('genre', 'genres')):
            if _empty(normalized.get(field)):
                value = next((v for v in (_obs_value(o, source) for o in observations) if v is not None), None)
                if value is not None:
                    changes[field] = [normalized.get(field), value]
    return result, changes


def merge_spotify_items(primary, other):
    """Field-wise merge: empty never overwrites, conflicts keep primary and record the other value as an alternative."""
    result = copy.deepcopy(primary)
    alternatives = result.setdefault('alternatives', {})
    for field, values in (other.get('alternatives') or {}).items():
        alternatives[field] = list(alternatives.get(field, [])) + [v for v in values if v not in alternatives.get(field, [])]
    for field, value in other.items():
        if field == 'alternatives':
            continue
        if field == 'source_observations':
            seen = {json.dumps(o, sort_keys=True, ensure_ascii=False) for o in result.get(field) or []}
            seen_ids = {o.get('observation_id') for o in result.get(field) or [] if isinstance(o, dict)}
            merged = list(result.get(field) or [])
            for o in value or []:
                if json.dumps(o, sort_keys=True, ensure_ascii=False) in seen or (isinstance(o, dict) and o.get('observation_id') in seen_ids):
                    continue
                merged.append(copy.deepcopy(o))
            result[field] = merged
        elif _empty(value):
            result.setdefault(field, copy.deepcopy(value))
        elif _empty(result.get(field)):
            result[field] = copy.deepcopy(value)
        elif result[field] != value:
            bucket = alternatives.setdefault(field, [])
            if value not in bucket:
                bucket.append(copy.deepcopy(value))
    for field in list(alternatives):
        primary_value = result.get(field)
        alternatives[field] = sorted((v for v in alternatives[field] if v != primary_value),
                                     key=lambda v: json.dumps(v, sort_keys=True, ensure_ascii=False))
        if not alternatives[field]:
            del alternatives[field]
    if not alternatives:
        result.pop('alternatives')
    return result


def observation_diff(before_metadata, after_metadata, before_normalized, after_normalized, entity_id):
    """Compact diff-v1 payload for a source_observation_update event; None when only normalization_version/title_variants/artist_variants changed."""
    def diff(before, after, skip=()):
        return {k: [before.get(k), after.get(k)] for k in sorted(set(before) | set(after))
                if k not in skip and before.get(k) != after.get(k)}
    changed = diff(before_metadata, after_metadata)
    normalized_changed = diff(before_normalized, after_normalized, _NORMALIZED_DIFF_SKIP)
    if not changed and not normalized_changed:
        return None
    return {'format': 'diff-v1', 'entity_id': entity_id, 'changed': changed, 'normalized_changed': normalized_changed}


# --- Candidate shortlist (ER3) ---------------------------------------------------------------------------------------
_CLASS_RANK = {'ACCEPTED': 0, 'HIGH_CONFIDENCE': 1, 'PROBABLE': 2, 'AMBIGUOUS': 3}
_RECOVERY_RANK = {'HIGH_CONFIDENCE': 0, 'PROBABLE': 1, 'AMBIGUOUS': 2}
_UNGUARDED_BLOCKS = {'insufficient_independent_evidence', 'hard_guard_or_near_tie'}
_CHUNK = 400
TOP_PER_ENTITY = 3
TOP_RECOVERY = 5


def _marks(items):
    return ','.join('?' * len(items))


def _chunks(items):
    items = sorted(items)
    for i in range(0, len(items), _CHUNK):
        yield items[i:i + _CHUNK]


def _scoped(db, sql, ids, tail=''):
    """Run `sql` (ending in a WHERE-ready clause, `{scope}` marks the candidate scope) globally or per id chunk."""
    if ids is None:
        yield from db.execute(sql.format(scope='1=1') + tail)
        return
    for chunk in _chunks(ids):
        yield from db.execute(sql.format(scope=f'(c.left_id IN ({_marks(chunk)}) OR c.right_id IN ({_marks(chunk)}))') + tail,
                              (*chunk, *chunk))


def _rows(db, ids):
    seen = {}
    for r in _scoped(db, 'SELECT c.rowid,c.left_id,c.right_id,c.class,c.score FROM candidates c WHERE {scope}', ids):
        seen[r[0]] = tuple(r)
    return list(seen.values())


def _mandatory(db, ids):
    from .identity_library import current_local_predicate
    queries = [
        "SELECT c.rowid FROM candidates c WHERE {scope} AND c.class IN ('ACCEPTED','HIGH_CONFIDENCE','PROBABLE')",
        "SELECT c.rowid FROM candidates c WHERE {scope} AND EXISTS(SELECT 1 FROM identity_acceptances a WHERE "
        "(a.left_id=c.left_id AND a.right_id=c.right_id) OR (a.left_id=c.right_id AND a.right_id=c.left_id))",
        "SELECT c.rowid FROM candidates c WHERE {scope} AND EXISTS(SELECT 1 FROM canonical_blocks b WHERE "
        "(b.left_id=c.left_id AND b.right_id=c.right_id) OR (b.left_id=c.right_id AND b.right_id=c.left_id))",
        "SELECT c.rowid FROM candidates c WHERE {scope} AND (json_type(c.evidence_json,'$.near_tie_review') IS NOT NULL OR "
        "json_type(c.evidence_json,'$.near_tie_original_class') IS NOT NULL OR c.evidence_json LIKE '%previously_rejected%' OR "
        "json_type(c.evidence_json,'$.historical_provenance') IS NOT NULL OR "
        "json_type(c.evidence_json,'$.revoked_identity_decision') IS NOT NULL OR json_type(c.evidence_json,'$.anchor')='object')",
        "SELECT c.rowid FROM candidates c JOIN entities l ON (l.id=c.left_id OR l.id=c.right_id) "
        "JOIN entities p ON p.id=CASE WHEN l.id=c.left_id THEN c.right_id ELSE c.left_id END "
        f"WHERE {{scope}} AND {current_local_predicate('l')} AND p.service IN ('spotify','soundcloud') AND c.score>=60",
    ]
    return {r[0] for q in queries for r in _scoped(db, q, ids)}


def _near_tie_witnesses(db, full, ids):
    """Rows manual_identity.comparison counts to word a near-tie reason: every row incident to either endpoint of a
    near_tie_review row with score >= that row's score - 5."""
    scores = {r[0]: r for r in full}
    near = []
    for chunk in _chunks(scores):
        near += [scores[r[0]] for r in db.execute(
            f"SELECT rowid FROM candidates WHERE rowid IN ({_marks(chunk)}) AND json_type(evidence_json,'$.near_tie_review') IS NOT NULL "
            "AND json_extract(evidence_json,'$.near_tie_review') NOT IN (0,'null')", chunk)]
    if not near:
        return set()
    xs = {x for r in near for x in (r[1], r[2])}
    pool = full if ids is None else _rows(db, xs)
    keep = set()
    for _, left, right, _, score in near:
        for x in (left, right):
            keep.update(r[0] for r in pool if (r[1] == x or r[2] == x) and r[4] >= score - 5)
    return keep


def _eligible(db, entity_ids):
    from .identity_library import current_local_predicate
    sql = ("SELECT e.id FROM entities e WHERE (e.service!='local' OR (" + current_local_predicate() + ")) AND "
           "COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired' AND "
           "COALESCE(json_type(e.metadata_json,'$.catalog_current'),'')!='false' AND e.id IN ({})")
    return {r[0] for chunk in _chunks(entity_ids) for r in db.execute(sql.format(_marks(chunk)), chunk)}


def _top_per_entity(db, rows, full):
    ents = {x for r in rows for x in (r[1], r[2])}
    eligible = _eligible(db, {x for r in full for x in (r[1], r[2])})
    per = {}
    for rid, left, right, cls, score in full:
        if left in eligible and right in eligible:
            for ent, other in ((left, right), (right, left)):
                if ent in ents:
                    per.setdefault(ent, []).append((_CLASS_RANK.get(cls, 4), -score, other, rid))
    keep = set()
    for items in per.values():
        keep.update(x[3] for x in sorted(items)[:TOP_PER_ENTITY])
    return keep


def _recovery_keep(db, rows, ids):
    """Rows Recovery shows (top 5 per remote-only recording, its own ordering) for recordings touched by `rows`."""
    from .identity_library import current_local_predicate
    recordings = None
    if ids is not None:
        ents = {x for r in rows for x in (r[1], r[2])}
        recordings = {rec for chunk in _chunks(ents)
                      for (rec,) in db.execute(f"SELECT recording_id FROM entities WHERE service!='local' AND id IN ({_marks(chunk)})", chunk)}
        if not recordings:
            return set()
    current = set()
    if recordings is None:
        current = {r[0] for r in db.execute('SELECT DISTINCT e.recording_id FROM entities e WHERE ' + current_local_predicate())}
    else:
        for chunk in _chunks(recordings):
            current.update(r[0] for r in db.execute(
                f'SELECT DISTINCT e.recording_id FROM entities e WHERE e.recording_id IN ({_marks(chunk)}) AND ' + current_local_predicate(), chunk))
    active, revoked = set(), set()
    for left, right, revoked_at in db.execute('SELECT left_id,right_id,revoked_at FROM identity_acceptances'):
        (revoked if revoked_at else active).add(frozenset((left, right)))
    blocks = {frozenset((r[0], r[1])): r[2] for r in db.execute('SELECT left_id,right_id,reason FROM canonical_blocks')}
    select = ("SELECT c.rowid,c.left_id,c.right_id,c.class,c.score,c.evidence_json,a.id,b.recording_id FROM candidates c "
              "JOIN entities a ON a.id=c.{x} AND a.service='local' JOIN entities b ON b.id=c.{y} "
              "WHERE b.service!='local' AND a.recording_id!=b.recording_id")
    per = {}
    for chunk in (_chunks(recordings) if recordings is not None else [None]):
        extra = '' if chunk is None else f' AND b.recording_id IN ({_marks(chunk)})'
        for x, y in (('left_id', 'right_id'), ('right_id', 'left_id')):
            for rid, left, right, cls, score, evidence, local_id, rec in db.execute(select.format(x=x, y=y) + extra, chunk or ()):
                pair = frozenset((left, right))
                if rec in current or pair in active:
                    continue
                block = blocks.get(pair)
                guarded = (cls == 'CONFLICT' or bool(json.loads(evidence).get('conflicts')) or pair in revoked
                           or bool(block and block not in _UNGUARDED_BLOCKS))
                per.setdefault(rec, {})[rid] = (guarded, _RECOVERY_RANK.get(cls, 3), -score, local_id, rid)
    keep = set()
    for items in per.values():
        # Recovery keeps tied rows in scan order, so every row tied with the 5th (guarded, rank, -score) key stays.
        ranked = sorted(items.values())
        cut = ranked[:TOP_RECOVERY][-1][:3]
        keep.update(k[4] for k in ranked if k[:3] <= cut)
    return keep


def shortlist_keep(db, entity_ids=None):
    """(left_id, right_id) pairs of the candidate rows to keep; with entity_ids only rows incident to those entities."""
    ids = None if entity_ids is None else set(entity_ids)
    if ids is not None and not ids:
        return set()
    rows = _rows(db, ids)
    if not rows:
        return set()
    ents = {x for r in rows for x in (r[1], r[2])}
    full = rows if ids is None else _rows(db, ents)
    keep = (_mandatory(db, ids) | _near_tie_witnesses(db, full, ids) | _top_per_entity(db, rows, full)
            | _recovery_keep(db, rows, ids))
    return {(r[1], r[2]) for r in rows if r[0] in keep}


def shortlist_prune(db, entity_ids=None):
    """Delete candidate rows outside the shortlist; returns the number of rows deleted."""
    ids = None if entity_ids is None else set(entity_ids)
    if ids is not None and not ids:
        return 0
    keep = shortlist_keep(db, ids)
    doomed = [(r[1], r[2]) for r in _rows(db, ids) if (r[1], r[2]) not in keep]
    for i in range(0, len(doomed), 5000):
        db.executemany('DELETE FROM candidates WHERE left_id=? AND right_id=?', doomed[i:i + 5000])
    return len(doomed)
