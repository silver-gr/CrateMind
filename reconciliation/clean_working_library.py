"""Clean the working library: compact repeated payloads and prune the candidate cache, never audio or decisions.

R10 links obvious local x SoundCloud pairs (undoable from the UI); R11 drops the leftover suggestions on linked tracks.
Default PREVIEW: every rule and assertion runs inside BEGIN IMMEDIATE transactions, is reported, then rolled back.
--apply: a verified backup of the pair first, then the same transactions with COMMIT (identity, then catalog),
VACUUM and checks. --rollback BACKUP_DIR: restore that backup into a new generation and switch active.json to it.
Run from backend/: uv run python ../reconciliation/clean_working_library.py [--apply | --rollback DIR] [--json]
"""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
import sqlite3
import statistics
import sys
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.services.writer_context import writer_context

PROTECTED = ('human', 'kept_local', 'rejected')
COMPACTED_ACTIONS = ('source_observation_update', 'credit_semantics_v2', 'source_observation_repair')
SPOTIFY_ROLES = ('account1', 'account2', 'account3')
SOUNDCLOUD_SNAPSHOT = '20260913T225252Z'
# sha256 of raw/<snapshot>/tracks_cache.json as recorded in the archive's snapshot_sha256_manifest.json.
TRACKS_CACHE_SHA256 = 'b61a2f035cca1f8bd66f207d02647f74d623bffa2010e348c66881a32b2ab639'
# soundcloud_snapshot keys the SoundCloud cards read; R3 must never remove one of them.
SC_CARD_KEYS = ('soundcloud_track_id', 'urn', 'title', 'permalink_url', 'uploader_username', 'duration_ms', 'full_duration_ms',
                'genre', 'display_date', 'created_at', 'liked_at', 'likes_count', 'reposts_count', 'playback_count',
                'comment_count', 'available', 'artwork_url', 'fetched_at', 'duration', 'full_duration', 'downloadable')
TIES_SQL = ('SELECT DISTINCT e.recording_id FROM candidates c JOIN entities e ON e.id=CASE WHEN c.left_id=? THEN c.right_id '
            'ELSE c.left_id END WHERE (c.left_id=? OR c.right_id=?) AND c.score>=?')  # manual_identity.comparison wording
LABELS = {'R1': 'Επιδιόρθωση Spotify από τις ίδιες παρατηρήσεις', 'R2': 'Συμπύκνωση παρατηρήσεων Spotify',
          'R3': 'Συμπύκνωση στοιχείων SoundCloud', 'R4': 'Σύντομη λίστα υποψηφίων',
          'R5': 'Συμπύκνωση ιστορικού παρατηρήσεων', 'R6': 'Αφαίρεση αντιγράφων πρότασης',
          'R7': 'Συμπύκνωση θέσεων SoundCloud', 'R9': 'Άδειασμα παλιού raw_json SoundCloud',
          'R10': 'Προφανείς συνδέσεις με SoundCloud', 'R11': 'Αφαίρεση προτάσεων σε ήδη συνδεδεμένα κομμάτια'}
LIKES_DOWNLOAD_ALBUM = 'Likes of DJ PanoramixXX'  # album tag of the files from the user's SoundCloud Likes download
R10_TIERS = {'A': ('cleanup_policy_high_confidence', 'auto_high_confidence'), 'B': ('cleanup_download_provenance', 'deterministic')}
SETTLED_STATUSES = {'AMBIGUOUS', 'CONFLICT', 'NO_CANDIDATE'}


class CheckFailed(Exception):
    pass


def stamp(): return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
def dump(value): return json.dumps(value, ensure_ascii=False, sort_keys=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''): h.update(block)
    return h.hexdigest()


def connect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def digest_rows(rows):
    h = hashlib.sha256()
    for row in rows: h.update(repr(tuple(row)).encode() + b'\n')
    return h.hexdigest()


def digest(db, sql, args=()): return digest_rows(db.execute(sql, args))


def table_bytes(db): return dict(db.execute('SELECT name,SUM(pgsize) FROM dbstat GROUP BY name ORDER BY name').fetchall())
def fk_violations(db): return sorted(tuple(r) for r in db.execute('PRAGMA foreign_key_check'))
def file_sizes(*paths): return {Path(str(p) + s).name: Path(str(p) + s).stat().st_size for p in paths
                                for s in ('', '-wal', '-journal') if Path(str(p) + s).exists()}


def check(report, name, ok, detail=None):
    report['assertions'][name] = 'ok' if ok else {'failed': detail}
    if not ok: raise CheckFailed(name)


def differing(before, after): return sorted(str(k) for k in before.keys() | after.keys() if before.get(k) != after.get(k))[:20]


def cold_copies(sources, manifest_path):
    """(sha256 set of the verified Exportify zips or None, {rule: reason} for the rules whose cold copy is not verified)."""
    expected = {x['role']: x['sha256'] for x in json.loads(manifest_path.read_text())} if manifest_path.is_file() else {}
    def problem(path, wanted):
        if not path.is_file(): return f'λείπει το {path}'
        if not wanted or sha256(path) != wanted: return f'το sha256 του {path} δεν ταιριάζει'
    zips = {sources / 'inputs/spotify' / f'{role}_exportify.zip': expected.get(role) for role in SPOTIFY_ROLES}
    soundcloud = {sources / 'data/soundcloud/archives' / f'soundcloud_{SOUNDCLOUD_SNAPSHOT}.tar.gz': expected.get('soundcloud'),
                  sources / 'data/soundcloud/raw' / SOUNDCLOUD_SNAPSHOT / 'tracks_cache.json': TRACKS_CACHE_SHA256}
    spotify_problems = [p for p in (problem(*x) for x in zips.items()) if p]
    soundcloud_problems = [p for p in (problem(*x) for x in soundcloud.items()) if p]
    skip = {'R2': '; '.join(spotify_problems)} if spotify_problems else {}
    if soundcloud_problems: skip['R3'] = skip['R7'] = '; '.join(soundcloud_problems)
    return (None if spotify_problems else set(zips.values())), skip


# --- baselines -----------------------------------------------------------------------------------------------------------
def row_limits(db):
    """Last pre-existing rowid of the append-only ledgers R10 adds to; protected_state compares only rows up to it."""
    return {'identity_acceptances': db.execute('SELECT COALESCE(MAX(rowid),0) FROM identity_acceptances').fetchone()[0],
            'canonical_events': db.execute('SELECT COALESCE(MAX(id),0) FROM canonical_events').fetchone()[0]}


def protected_state(db, limits):
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'collection%' OR name IN ('identity_acceptances',"
        "'canonical_blocks','canonical_base_entities','canonical_patterns','recording_recovery','recovery_events')) ORDER BY name")]
    state = {t: digest(db, f'SELECT * FROM "{t}"' + (' WHERE rowid<=?' if t in limits else '') + ' ORDER BY rowid',
                       (limits[t],) if t in limits else ()) for t in tables}
    state['memberships'] = digest(db, 'SELECT collection_id,position,entity_id,added_at FROM memberships ORDER BY collection_id,position')
    state['canonical_events'] = digest(db, 'SELECT * FROM canonical_events WHERE action NOT IN (?,?,?) AND id<=? ORDER BY id',
                                       (*COMPACTED_ACTIONS, limits['canonical_events']))
    state['canonical_recordings.protected'] = digest(db, 'SELECT * FROM canonical_recordings WHERE state IN (?,?,?) ORDER BY recording_id', PROTECTED)
    state['entities.recording_id'] = dict(db.execute('SELECT id,recording_id FROM entities').fetchall())
    return state


def credits_state(db):
    return ({r[0]: tuple(r) for r in db.execute('SELECT * FROM canonical_artists')},
            [tuple(r) for r in db.execute('SELECT * FROM recording_artists ORDER BY recording_id,credit_order')])


def stored_hashes(db):
    for did, baseline, result in db.execute('SELECT id,baseline_json,result_json FROM collection_consolidations ORDER BY id').fetchall():
        for kind, values in (('baseline', json.loads(baseline).get('hashes') or {}), ('representative', json.loads(result).get('representative_hashes') or {})):
            yield from ((did, kind, cid, value) for cid, value in sorted(values.items()))


def matching_hashes(db):
    """Stored consolidation hashes that equal their collection's live fingerprint."""
    from app.services.collection_consolidation import fingerprint
    live, matched = {}, set()
    for did, kind, cid, value in stored_hashes(db):
        if cid not in live:
            try: live[cid] = fingerprint(db, cid)
            except ValueError: live[cid] = None
        if live[cid] == value: matched.add((did, kind, cid))
    return matched


def consolidation_rows(db, values):
    """collection_consolidations rows (rowid order) with {(decision, kind, collection): hash} written into their JSON."""
    rows = []
    for row in db.execute('SELECT * FROM collection_consolidations ORDER BY rowid').fetchall():
        row = dict(row)
        for kind, column, key in (('baseline', 'baseline_json', 'hashes'), ('representative', 'result_json', 'representative_hashes')):
            changes = {cid: h for (did, k, cid), h in values.items() if did == row['id'] and k == kind}
            if changes:
                value = json.loads(row[column]); value[key].update(changes); row[column] = json.dumps(value)  # the writer's format
        rows.append(row)
    return rows


def restamp(db, matched):
    """Rewrite the stored hashes that matched before R10 and no longer do: {(decision, kind, collection): [old, new]}.
    Decision ids and hashes that were already stale stay as they are."""
    from app.services.collection_consolidation import fingerprint
    live = {cid: fingerprint(db, cid) for cid in sorted({cid for _, _, cid in matched})}
    rewrites = {(did, kind, cid): [value, live[cid]] for did, kind, cid, value in stored_hashes(db)
                if (did, kind, cid) in matched and value != live[cid]}
    decisions = {did for did, _, _ in rewrites}
    for row in consolidation_rows(db, {k: new for k, (_, new) in rewrites.items()}):
        if row['id'] in decisions:
            db.execute('UPDATE collection_consolidations SET baseline_json=?,result_json=? WHERE id=?', (row['baseline_json'], row['result_json'], row['id']))
    return rewrites


def last_decisions(db):
    """api/identity.py pattern-accept lookup: is the recording's last event an 'accept'?"""
    last = {}
    for rid, action in db.execute('SELECT recording_id,action FROM canonical_events ORDER BY id'): last[rid] = action
    return {rid: action == 'accept' for rid, action in last.items()}


def provider_sources(db):
    from app.services.provider_resolution import source
    return {r['id']: source(r) for r in db.execute("SELECT * FROM entities WHERE service!='local' ORDER BY id")}


def display_state(db):
    from app.services.metadata_display import recordings
    ids = [r[0] for r in db.execute('SELECT recording_id FROM canonical_recordings ORDER BY recording_id')]
    return {rid: dump(v) for rid, v in recordings(db, ids).items()}


def suggestions(db):
    """Candidate rows per current local that point outside its recording (median / p90 / max)."""
    from app.services.identity_library import current_local_predicate
    counts = sorted(r[0] for r in db.execute(
        'SELECT (SELECT COUNT(*) FROM candidates c JOIN entities o ON o.id=CASE WHEN c.left_id=e.id THEN c.right_id ELSE c.left_id END '
        'WHERE (c.left_id=e.id OR c.right_id=e.id) AND o.recording_id!=e.recording_id) FROM entities e WHERE ' + current_local_predicate())) or [0]
    return {'locals': len(counts), 'rows': sum(counts), 'median': statistics.median(counts), 'p90': counts[int(.9 * (len(counts) - 1))], 'max': counts[-1]}


def review_state(db, remote_only):
    from app.services.recovery_prioritization import local_candidates
    items = [{'recording_id': rid, 'availability': {'remote_only': True}} for rid in sorted(remote_only)]
    local_candidates(db, items)
    ties = {}
    for left, right, score, evidence in db.execute("SELECT left_id,right_id,score,evidence_json FROM candidates "
                                                   "WHERE evidence_json LIKE '%near_tie_review%' ORDER BY left_id,right_id").fetchall():
        if json.loads(evidence).get('near_tie_review'):
            for x in (left, right): ties[(left, right, x)] = len(db.execute(TIES_SQL, (x, x, x, score - 5)).fetchall())
    rejected = {}
    for left, right, cls, evidence in db.execute("SELECT left_id,right_id,class,evidence_json FROM candidates WHERE evidence_json LIKE '%previously_rejected%'"):
        e = json.loads(evidence)
        if 'previously_rejected' in e.get('conflicts', []): rejected[(left, right)] = dump([cls, e.get('conflicts'), e.get('anchor')])
    return {'metadata_display': display_state(db),
            'recovery_top5': {v['recording_id']: dump([[i[k] for k in ('local_entity_id', 'provider_entity_id', 'class', 'score', 'guarded')]
                                                       for i in v['local_candidate_evidence']['items']]) for v in items},
            'near_tie_ties': ties, 'previously_rejected': rejected}


def library_metrics(db):
    from app.services import identity_library, library_completeness
    index, unified = library_completeness.index(db), identity_library.summary(db)
    return ({**library_completeness.metrics(index), 'unified_active_recordings': unified['active_recordings'],
             'unresolved_placeholders': unified['unresolved_placeholders']},
            {rid for rid, v in index.items() if v['availability']['remote_only']})


# --- identity rules ------------------------------------------------------------------------------------------------------
def r1_repair(db):
    from app.services import canonical_library as canonical
    from app.services.identity_compaction import observation_diff, repair_spotify_metadata
    from app.services.identity_matching import normalized_item
    from app.services.identity_sync import _canonical_row, _event, refresh_candidates
    repaired = {}
    for sid, rid, meta_json, norm_json in db.execute("SELECT id,recording_id,metadata_json,normalized_json FROM entities "
                                                     "WHERE service='spotify' ORDER BY id").fetchall():
        meta, norm = json.loads(meta_json), json.loads(norm_json)
        new_meta, changes = repair_spotify_metadata(meta, norm)
        if not changes: continue
        patch = {k: changes[k][1] for k in ('label', 'genre') if k in changes}
        if 'isrc' in changes and not norm.get('isrc'): patch['isrc'] = changes['isrc'][1]
        fields = normalized_item({**norm, **patch})
        new_norm = {**norm, **{k: fields[k] for k in (*patch, *(['isrc_key'] if 'isrc' in patch else []))}}
        db.execute('UPDATE entities SET metadata_json=?,normalized_json=? WHERE id=?', (canonical.dump(new_meta), canonical.dump(new_norm), sid))
        _event(db, 'source_observation_repair', after=observation_diff(meta, new_meta, norm, new_norm, sid), recording_id=rid)
        repaired[sid] = rid
    def credit(rid):
        artist = db.execute('SELECT artist FROM canonical_recordings WHERE recording_id=?', (rid,)).fetchone()
        return {'artist': artist[0] if artist else None, 'credits': [list(r) for r in db.execute(
            'SELECT ra.artist_id,a.name,ra.role FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id '
            'WHERE ra.recording_id=? ORDER BY ra.credit_order', (rid,))]}
    refreshed, protected, credit_changes = [], [], {}
    for sid, rid in sorted(repaired.items()):
        if rid in refreshed or rid in protected: continue
        state = db.execute('SELECT state FROM canonical_recordings WHERE recording_id=?', (rid,)).fetchone()
        if state and state[0] in PROTECTED:
            protected.append(rid); continue
        before = credit(rid); _canonical_row(db, sid); after = credit(rid); refreshed.append(rid)
        if before != after: credit_changes[rid] = {'before': before, 'after': after}
    return {'changed': len(repaired), 'entities': sorted(repaired), 'recordings_refreshed': refreshed,
            'recordings_protected_skipped': protected, 'credit_changes': credit_changes,
            'candidates_rescored': refresh_candidates(db, set(repaired)) if repaired else 0}


def r2_spotify(db, verified, skip):
    from app.services.identity_compaction import compact_spotify_observation, spotify_alternatives
    if 'R2' not in skip:
        archives = {r[0] for r in db.execute("SELECT DISTINCT json_extract(o.value,'$.archive_sha256') FROM entities e, "
                                             "json_each(e.metadata_json,'$.source_observations') o WHERE e.service='spotify'")}
        if archives - verified: skip['R2'] = f'{len(archives - verified)} αρχεία παρατηρήσεων δεν ανήκουν στα επαληθευμένα Exportify zip'
    if 'R2' in skip: return {'changed': 0, 'skipped': skip['R2']}
    changed = alternatives = observations = 0
    for sid, meta_json in db.execute("SELECT id,metadata_json FROM entities WHERE service='spotify' AND "
                                     "json_type(metadata_json,'$.source_observations')='array' ORDER BY id").fetchall():
        meta = json.loads(meta_json); alts = spotify_alternatives(meta)
        new = {**meta, 'source_observations': [compact_spotify_observation(o) if isinstance(o, dict) else o for o in meta['source_observations']]}
        if alts: new['alternatives'] = alts  # same key and shape as the importer's merge_spotify_items
        if new != meta:
            db.execute('UPDATE entities SET metadata_json=? WHERE id=?', (dump(new), sid))
            changed += 1; alternatives += bool(alts); observations += len(new['source_observations'])
    return {'changed': changed, 'observations': observations, 'with_alternatives': alternatives}


def r3_soundcloud(db, skip):
    from app.services.identity_compaction import slim_soundcloud_raw
    if 'R3' in skip: return {'changed': 0, 'skipped': skip['R3']}
    changed = 0
    for sid, meta_json in db.execute("SELECT id,metadata_json FROM entities WHERE service='soundcloud' AND "
                                     "json_type(metadata_json,'$.raw_metadata')='object' ORDER BY id").fetchall():
        meta = json.loads(meta_json); slim = slim_soundcloud_raw(meta['raw_metadata'])
        if slim != meta['raw_metadata']:
            db.execute('UPDATE entities SET metadata_json=? WHERE id=?', (dump({**meta, 'raw_metadata': slim}), sid)); changed += 1
    return {'changed': changed}


def check_sources(report, before, after):
    """source() is unchanged except SoundCloud snapshot keys only R3's dropped raw payload supplied (never a card key)."""
    dropped, bad = set(), []
    for sid, value in before.items():
        new = after.get(sid)
        snapshot, new_snapshot = value.get('soundcloud_snapshot'), (new or {}).get('soundcloud_snapshot')
        if snapshot is not None and new_snapshot is not None:
            lost = set(snapshot) - set(new_snapshot)
            dropped |= lost
            value = {**value, 'soundcloud_snapshot': {k: v for k, v in snapshot.items() if k not in lost}}
            if lost & set(SC_CARD_KEYS): bad.append(sid)
        if new != value and sid not in bad: bad.append(sid)
    report['rules']['R3']['source_keys_dropped'] = sorted(dropped)
    check(report, 'provider_sources', not bad, bad[:20])


def download_tracks(catalog):
    """Catalog ids of the files from the SoundCloud Likes download (album 'Likes of DJ PanoramixXX…', any case)."""
    with closing(sqlite3.connect(Path(catalog).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        return {r[0] for r in db.execute('SELECT id FROM tracks WHERE album LIKE ?', (LIKES_DOWNLOAD_ALBUM + '%',))}


def obvious_links(db, downloads):
    """R10 selection on the live rows in (left, right) order: ([(tier, left, right, evidence, local rec, soundcloud rec)],
    candidates per tier, {tier: {exclusion: count}}). Tier A = policy-eligible HIGH_CONFIDENCE; tier B = download provenance."""
    from app.services.identity_library import current_local_predicate
    from app.services.identity_policy import automatic_eligible
    from app.services.manual_identity import comparison
    liked = {r[0] for r in db.execute("SELECT m.entity_id FROM memberships m JOIN collections k ON k.id=m.collection_id "
                                      "WHERE k.service='soundcloud' AND k.kind='likes'")}
    current = {r[0] for r in db.execute(f'SELECT e.id FROM entities e WHERE {current_local_predicate()}')}
    def tier(cls, ev, track, sid):
        delta = ev.get('duration_delta_seconds')
        if cls == 'HIGH_CONFIDENCE' and automatic_eligible(ev): return 'A'
        if (track in downloads and sid in liked and ev.get('title_similarity', 0) >= .95 and delta is not None and abs(delta) <= 1
                and set(ev.get('conflicts') or []) <= {'artist_conflict'}): return 'B'
    def exists(sql, *args): return db.execute(sql, args).fetchone() is not None
    def excluded_by(t, left, right, lrec, srec):
        # A revoked acceptance is a human undo; an active one is a decision already taken.
        if exists('SELECT 1 FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', left, right, right, left):
            return 'existing_acceptance'
        if exists('SELECT 1 FROM canonical_recordings WHERE recording_id IN (?,?) AND state IN (?,?,?)', lrec, srec, *PROTECTED):
            return 'protected_recording'
        if exists(f'SELECT 1 FROM entities e WHERE e.recording_id=? AND {current_local_predicate()}', srec): return 'soundcloud_recording_has_local'
        if exists("SELECT 1 FROM entities WHERE recording_id=? AND service='soundcloud'", lrec): return 'local_recording_has_soundcloud'
        hard = {d['conflict'] for d in comparison(db, left, right)['hard_block_details']}
        if hard - ({'artist_conflict'} if t == 'B' else set()): return 'hard_block'
    claims, tiers, excluded = [], Counter(), Counter()
    for left, right, cls, evidence, lid, track, lrec, sid, srec in db.execute(
            "SELECT c.left_id,c.right_id,c.class,c.evidence_json,l.id,l.local_track_id,l.recording_id,s.id,s.recording_id FROM candidates c "
            "JOIN entities l ON l.service='local' AND (l.id=c.left_id OR l.id=c.right_id) "
            "JOIN entities s ON s.service='soundcloud' AND s.id=CASE WHEN l.id=c.left_id THEN c.right_id ELSE c.left_id END "
            "WHERE c.pair_type='local:soundcloud' ORDER BY c.left_id,c.right_id").fetchall():
        ev = json.loads(evidence); t = tier(cls, ev, track, sid)
        if not t: continue
        tiers[t] += 1
        if lid not in current: excluded[t, 'local_not_current'] += 1
        elif lrec == srec: excluded[t, 'already_one_recording'] += 1
        else: claims.append((t, left, right, ev, lrec, srec))
    # One-to-one over every claim: a recording two claims share (two files, two uploads) is not obvious.
    uses = Counter(r for p in claims for r in p[4:])
    selected = []
    for p in claims:
        reason = 'not_one_to_one' if uses[p[4]] > 1 or uses[p[5]] > 1 else excluded_by(p[0], *p[1:3], *p[4:])
        if reason: excluded[p[0], reason] += 1
        else: selected.append(p)
    report = {}
    for (t, reason), n in sorted(excluded.items()): report.setdefault(t, {})[reason] = n
    return selected, dict(sorted(tiers.items())), report


def r10_links(db, downloads):
    """Link the obvious pairs like manual_identity.link (target = the local's recording); returns (report, moved, touched)."""
    from app.services.identity_matching import refresh_entity_statuses, refresh_near_ties
    from app.services.manual_identity import link_automatic, members
    selected, tiers, excluded = obvious_links(db, downloads)
    moved, touched, pairs = {}, set(), []
    for t, left, right, evidence, lrec, srec in selected:
        method, mode = R10_TIERS[t]
        target = link_automatic(db, left, right, {**evidence, 'tier': t}, method=method, mode=mode)['recording_id']
        moved.update({e['id']: target for e in members(db, target)}); touched |= {lrec, srec}
        pairs.append([t, left, right, method, mode])
    report = {'changed': len(pairs), 'tier_a': sum(p[0] == 'A' for p in pairs), 'tier_b': sum(p[0] == 'B' for p in pairs),
              'candidates_per_tier': tiers, 'excluded': excluded,
              'near_ties_refreshed': refresh_near_ties(db), 'statuses_refreshed': refresh_entity_statuses(db), 'pairs': pairs}
    return report, moved, touched


def r4_shortlist(db):
    from app.services.identity_compaction import SLIM_EVIDENCE_KEYS, shortlist_prune, slim_candidate_evidence
    pruned, slimmed = shortlist_prune(db), 0
    for rowid, evidence in db.execute('SELECT rowid,evidence_json FROM candidates WHERE ' + ' OR '.join(
            f"json_type(evidence_json,'$.{k}') IS NOT NULL" for k in SLIM_EVIDENCE_KEYS)).fetchall():
        db.execute('UPDATE candidates SET evidence_json=? WHERE rowid=?', (dump(slim_candidate_evidence(json.loads(evidence))), rowid)); slimmed += 1
    return {'changed': pruned + slimmed, 'pruned': pruned, 'slimmed': slimmed, 'kept': db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]}


def r11_settled(db, r4):
    """The writers' settled shortlist: leftover AMBIGUOUS/CONFLICT suggestions on tracks already linked to SoundCloud."""
    from app.services.identity_compaction import SHORTLIST_RULE_VERSION, shortlist_prune
    from app.services.identity_matching import refresh_entity_statuses, refresh_near_ties
    before = {(r[0], r[1]): r[2] for r in db.execute('SELECT left_id,right_id,class FROM candidates')}
    statuses = dict(db.execute('SELECT id,status FROM entities').fetchall())
    dropped = shortlist_prune(db, settled=True)
    gone = before.keys() - {(r[0], r[1]) for r in db.execute('SELECT left_id,right_id FROM candidates')}
    report = {'changed': dropped, 'dropped_classes': dict(Counter(before[p] for p in gone)),
              'near_ties_refreshed': refresh_near_ties(db), 'statuses_refreshed': refresh_entity_statuses(db)}
    changes = {sid: (statuses.get(sid), new) for sid, new in db.execute('SELECT id,status FROM entities') if statuses.get(sid) != new}
    report['status_changes'] = {f'{old}->{new}': n for (old, new), n in sorted(Counter(changes.values()).items())}
    kept = db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]
    if r4['changed'] or dropped:
        db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('candidate_shortlist', dump(
            {'rule_version': SHORTLIST_RULE_VERSION, 'pruned': r4['pruned'], 'settled_pruned': dropped, 'slimmed': r4['slimmed'],
             'kept': kept, 'applied_at': datetime.now(timezone.utc).isoformat()})))
    return report, changes, {x for p in gone for x in p}


def role_diff(before, after):
    def roles(old, new): return [[n.get('credit_order', i), n.get('id'), n.get('name'), o.get('role'), n.get('role')]
                                 for i, (o, n) in enumerate(zip(old, new)) if o.get('role') != n.get('role')]
    old, new = before.get('proposal') or {}, after.get('proposal') or {}
    result = {'format': 'role-diff-v1', 'credits': roles(before.get('credits') or [], after.get('credits') or []),
              'proposal_credits': roles(old.get('credits') or [], new.get('credits') or []),
              'proposal': {k: [old.get(k), new.get(k)] for k in sorted(old.keys() | new.keys()) if k != 'credits' and old.get(k) != new.get(k)}}
    if before.get('artist') != after.get('artist'): result['artist'] = [before.get('artist'), after.get('artist')]
    return result


def r5_events(db):
    from app.services.identity_compaction import observation_diff
    deleted = compacted = credits = kept = 0
    for eid, before, after in db.execute("SELECT id,before_json,after_json FROM canonical_events WHERE action='source_observation_update' "
                                         'AND before_json IS NOT NULL ORDER BY id').fetchall():
        b, a = json.loads(before), json.loads(after)
        diff = observation_diff(json.loads(b['metadata_json']), a['metadata'], json.loads(b['normalized_json']), a['normalized'],
                                a.get('entity_id') or b['id'])
        if diff is None:
            db.execute('DELETE FROM canonical_events WHERE id=?', (eid,)); deleted += 1
        else:
            db.execute('UPDATE canonical_events SET before_json=NULL,after_json=? WHERE id=?', (dump(diff), eid)); compacted += 1
    for eid, state, before, after in db.execute(
            "SELECT e.id,c.state,e.before_json,e.after_json FROM canonical_events e LEFT JOIN canonical_recordings c ON "
            "c.recording_id=e.recording_id WHERE e.action='credit_semantics_v2' AND e.before_json IS NOT NULL ORDER BY e.id").fetchall():
        if state in PROTECTED: kept += 1; continue
        db.execute('UPDATE canonical_events SET before_json=NULL,after_json=? WHERE id=?', (dump(role_diff(json.loads(before), json.loads(after))), eid))
        credits += 1
    return {'changed': deleted + compacted + credits, 'deleted_normalizer_only': deleted, 'compacted_updates': compacted,
            'compacted_credit_roles': credits, 'protected_kept_verbatim': kept}


def r6_evidence(db):
    from app.services.identity_compaction import slim_canonical_evidence
    changed = 0
    for rid, evidence in db.execute("SELECT recording_id,evidence_json FROM canonical_recordings WHERE state NOT IN (?,?,?) "
                                    "AND evidence_json LIKE '%\"proposal\"%' ORDER BY recording_id", PROTECTED).fetchall():
        value = json.loads(evidence); slim = slim_canonical_evidence(value)
        if slim != value:
            db.execute('UPDATE canonical_recordings SET evidence_json=? WHERE recording_id=?', (dump(slim), rid)); changed += 1
    return {'changed': changed}


def referenced_collections(db):
    found = set()
    def walk(value):
        if isinstance(value, str): found.add(value)
        elif isinstance(value, dict): [walk(x) for pair in value.items() for x in pair]
        elif isinstance(value, list): [walk(x) for x in value]
    for baseline, result in db.execute('SELECT baseline_json,result_json FROM collection_consolidations'):
        walk(json.loads(baseline)); walk(json.loads(result))
    return found


def r7_memberships(db, skip):
    if 'R7' in skip: return {'changed': 0, 'skipped': skip['R7']}
    referenced, changed, kept = referenced_collections(db), 0, 0
    for rowid, cid, source in db.execute("SELECT m.rowid,m.collection_id,m.source_json FROM memberships m JOIN collections c ON "
                                         "c.id=m.collection_id WHERE c.service='soundcloud' AND "
                                         "json_type(m.source_json,'$.raw_membership') IS NOT NULL ORDER BY m.rowid").fetchall():
        if cid in referenced: kept += 1; continue
        value = json.loads(source); value.pop('raw_membership')
        db.execute('UPDATE memberships SET source_json=? WHERE rowid=?', (dump(value), rowid)); changed += 1
    return {'changed': changed, 'kept_in_consolidation_baselines': kept}


def clean_identity(db, report, verified, skip, downloads):
    """Steps 1-13 of the plan plus R10/R11 inside one transaction; the caller commits or rolls back."""
    from app.services.identity_matching import refresh_entity_statuses, refresh_near_ties
    rules = report['rules']
    db.execute('BEGIN IMMEDIATE')
    report['bytes']['identity'] = {'before': table_bytes(db)}
    report['metrics']['before'], remote_only = library_metrics(db)
    limits = row_limits(db)
    protected, credits, fk, hashes, last = protected_state(db, limits), credits_state(db), fk_violations(db), matching_hashes(db), last_decisions(db)
    candidates = db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]
    rules['R1'] = r1_repair(db)
    sources = provider_sources(db)
    rules['R2'] = r2_spotify(db, verified or set(), skip)
    rules['R3'] = r3_soundcloud(db, skip)
    check_sources(report, sources, provider_sources(db))
    del sources
    report['drift'] = {'near_ties': refresh_near_ties(db), 'statuses': refresh_entity_statuses(db)}
    display, matched = display_state(db), matching_hashes(db)
    rules['R10'], moved, touched = r10_links(db, downloads)
    rewrites = restamp(db, matched)
    rules['R10']['consolidation_hashes'] = {'matched_before': len(matched), 'restamped': len(rewrites),
                                            'decisions': len({k[0] for k in rewrites}),
                                            'review_decisions': len({k[0] for k in rewrites if k[0].startswith('review:')})}
    check(report, 'consolidation_hashes_restamped', matching_hashes(db) == matched, sorted(map(list, matched ^ matching_hashes(db)))[:20])
    report['suggestions_per_local'] = {'before_R4': suggestions(db)}
    review = review_state(db, remote_only)
    rules['R4'] = r4_shortlist(db)
    check(report, 'refresh_near_ties_changes_nothing', refresh_near_ties(db) == 0)
    check(report, 'refresh_entity_statuses_changes_nothing', refresh_entity_statuses(db) == 0)
    after = review_state(db, remote_only)
    for name in review: check(report, f'unchanged_{name}', review[name] == after[name], differing(review[name], after[name]))
    report['suggestions_per_local']['after_R4'] = suggestions(db)
    rules['R11'], changes, lost = r11_settled(db, rules['R4'])
    check(report, 'r11_drops_only_ambiguous_or_conflict', set(rules['R11']['dropped_classes']) <= {'AMBIGUOUS', 'CONFLICT'})
    check(report, 'r11_refresh_near_ties_changes_nothing', rules['R11']['near_ties_refreshed'] == 0)
    services = dict(db.execute('SELECT id,service FROM entities').fetchall())
    bad = sorted(sid for sid, statuses in changes.items()
                 if services[sid] != 'soundcloud' or sid not in lost or not set(statuses) <= SETTLED_STATUSES)
    check(report, 'r11_status_changes_only_on_soundcloud_entities_that_lost_rows', not bad, bad[:20])
    after = display_state(db)
    bad = sorted(rid for rid in display if rid not in touched and display[rid] != after.get(rid))
    check(report, 'metadata_display_unchanged_outside_r10_recordings', not bad, bad[:20])
    report['suggestions_per_local']['after_R11'] = suggestions(db)
    rules['R5'] = r5_events(db)
    # Same answer for every recording; a human recording never loses its last event (the route reads fetchone()[0]).
    new_last = last_decisions(db)
    humans = {r[0] for r in db.execute("SELECT recording_id FROM canonical_recordings WHERE state='human'")}
    changed = sorted(r for r in last if r not in touched and (last[r] != new_last.get(r, False) or (r in humans and r not in new_last)))
    check(report, 'last_decision_lookup', not changed, changed[:20])
    rules['R6'] = r6_evidence(db)
    rules['R7'] = r7_memberships(db, skip)
    check(report, 'consolidation_hashes', hashes <= matching_hashes(db), sorted(map(list, hashes - matching_hashes(db)))[:20])
    # Pre-existing rows byte-equal except exactly R10's group moves and hash re-stamps; the new rows are exactly R10's links.
    after = protected_state(db, limits)
    after['collection_consolidations'] = digest_rows(tuple(r.values()) for r in consolidation_rows(db, {k: old for k, (old, _) in rewrites.items()}))
    expected = {**protected, 'entities.recording_id': {**protected['entities.recording_id'], **moved}}
    check(report, 'protected_tables', expected == after, differing(expected, after))
    r10_pairs = [p[1:] for p in rules['R10']['pairs']]
    new = sorted((r[0], r[1], r[2], r[4], r[7]) for r in db.execute('SELECT * FROM identity_acceptances WHERE rowid>?', (limits['identity_acceptances'],)))
    check(report, 'new_acceptances_are_the_r10_links', new == sorted((l, r, 'cleanup_obvious_link', m, mode) for l, r, m, mode in r10_pairs))
    new = sorted((a, json.loads(x).get('left_id'), json.loads(x).get('right_id')) for a, x in db.execute(
        'SELECT action,after_json FROM canonical_events WHERE id>? AND action NOT IN (?,?,?)', (limits['canonical_events'], *COMPACTED_ACTIONS)))
    check(report, 'new_events_are_the_r10_links', new == sorted((a, l, r) for l, r, *_ in r10_pairs
                                                                for a in ('automatic_identity_link', 'legacy_soundcloud_mirror_intent')))
    affected = set(rules['R1']['recordings_refreshed'])
    (artists, links), (new_artists, new_links) = credits, credits_state(db)
    outside = [r for r in new_links if r[0] not in affected]
    added = new_artists.keys() - artists.keys()
    check(report, 'credits_outside_repaired_recordings',
          all(new_artists.get(k) == v for k, v in artists.items()) and [r for r in links if r[0] not in affected] == outside
          and not {r[1] for r in outside} & added)
    rules['R1']['canonical_artists_added'] = len(added)
    check(report, 'identity_foreign_keys', not set(fk_violations(db)) - set(fk))
    report['candidates'] = {'before': candidates, 'after': db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]}
    report['metrics']['after'] = library_metrics(db)[0]
    report['bytes']['identity']['after'] = table_bytes(db)
    return len(fk)


def clean_catalog(db, report, soundcloud_ids):
    """R9: blank the unread catalog raw_json of SoundCloud tracks that have an identity entity; everything else byte-equal."""
    db.execute('BEGIN IMMEDIATE')
    report['bytes']['catalog'] = {'before': table_bytes(db)}
    fk = fk_violations(db)
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='soundcloud_tracks' "
                                       "AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")]
    columns = ','.join(f'"{r[1]}"' for r in db.execute('PRAGMA table_info(soundcloud_tracks)') if r[1] != 'raw_json')
    def state(): return {**{t: digest(db, f'SELECT * FROM "{t}"') for t in tables},
                         'soundcloud_tracks': digest(db, f'SELECT {columns} FROM soundcloud_tracks ORDER BY soundcloud_track_id')}
    before = state()
    changed = db.execute("UPDATE soundcloud_tracks SET raw_json='{}' WHERE raw_json!='{}' AND "
                         "'soundcloud:tracks:'||soundcloud_track_id IN (SELECT value FROM json_each(?))",
                         (json.dumps(sorted(soundcloud_ids)),)).rowcount
    report['rules']['R9'] = {'changed': changed,
                             'kept_without_identity': db.execute("SELECT COUNT(*) FROM soundcloud_tracks WHERE raw_json!='{}'").fetchone()[0]}
    after = state()
    check(report, 'catalog_unchanged_except_raw_json', before == after, differing(before, after))
    check(report, 'catalog_foreign_keys', not set(fk_violations(db)) - set(fk))
    report['bytes']['catalog']['after'] = table_bytes(db)
    return len(fk)


# --- modes ---------------------------------------------------------------------------------------------------------------
def clean(ds, args):
    from app.services.active_dataset import resolve_active_dataset
    from app.services.backup import create_backup, verify_backup
    root = ds.dataset_root
    if root is None or ds.identity is None:
        raise ValueError('Απαιτείται ενεργή βιβλιοθήκη (CRATEMIND_DATASET_ROOT) με βάση identity.')
    active = resolve_active_dataset(root)
    report = {'ok': False, 'mode': 'apply' if args.apply else 'preview', 'dataset_root': str(root), 'generation': active.generation,
              'preconditions': {}, 'skipped': {}, 'rules': {}, 'assertions': {}, 'bytes': {}, 'metrics': {},
              'files': {'before': file_sizes(ds.catalog, ds.identity)}}
    need, free = 3 * sum(report['files']['before'].values()), shutil.disk_usage(root).free
    report['preconditions']['free_space'] = {'free': free, 'required': need}
    if free < need:
        report['error'] = f'Ανεπαρκής ελεύθερος χώρος: {free} bytes, απαιτούνται {need}.'
        return report
    verified, skip = cold_copies(args.sources.resolve(), args.input_manifest.resolve())
    report['skipped'] = skip
    if args.apply:
        backup_dir = root / 'backups' / f'working-library-cleanup-{stamp()}'
        if backup_dir.exists(): raise FileExistsError(f'Το αντίγραφο {backup_dir} υπάρχει ήδη.')
        bundle = create_backup(ds.catalog, backup_dir, identity_path=ds.identity, keep=None, reuse=False)
        verify_backup(bundle)
        for name in ('exchange-state.json', 'manifest.json'):
            if (active.generation_dir / name).is_file(): shutil.copy2(active.generation_dir / name, backup_dir / name)
        report['backup'] = {'directory': str(backup_dir), 'bundle': str(bundle),
                            'earliest': str(sorted((root / 'backups').glob('working-library-cleanup-*'))[0]),
                            'saved_exchange_state': (backup_dir / 'exchange-state.json').is_file(),
                            'rollback_command': f'cd backend && uv run python ../reconciliation/clean_working_library.py --rollback "{backup_dir}"'}
    fk, downloads = {}, download_tracks(ds.catalog)
    with closing(connect(ds.identity)) as db:
        soundcloud_ids = [r[0] for r in db.execute("SELECT id FROM entities WHERE service='soundcloud'")]
        try:
            fk['identity'] = clean_identity(db, report, verified, skip, downloads)
        except CheckFailed:
            db.execute('ROLLBACK')
            return finish(report)
        db.execute('COMMIT' if args.apply else 'ROLLBACK')
    with closing(connect(ds.catalog)) as db:
        try:
            fk['catalog'] = clean_catalog(db, report, soundcloud_ids)
        except CheckFailed:
            db.execute('ROLLBACK')
            return finish(report)
        db.execute('COMMIT' if args.apply else 'ROLLBACK')
    if args.apply:
        compact(ds, report, fk)
        report['files']['after'] = file_sizes(ds.catalog, ds.identity)
    report['ok'] = all(v == 'ok' for v in report['assertions'].values())
    return finish(report)


def compact(ds, report, fk):
    """VACUUM both files with no other connection open, then integrity, foreign keys and schema compatibility."""
    from app import db as catalog_db
    from app.services.schema_contract import SchemaCompatibilityError, validate_schema_compatibility
    if catalog_db._engine is not None: catalog_db._engine.dispose()
    for path, label in ((ds.identity, 'identity'), (ds.catalog, 'catalog')):
        with closing(sqlite3.connect(path, isolation_level=None)) as db:
            if label == 'catalog': db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.execute('VACUUM')
            if label == 'catalog': db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            integrity, violations = db.execute('PRAGMA integrity_check').fetchone()[0], len(fk_violations(db))
            report['assertions'][f'{label}_integrity'] = 'ok' if integrity == 'ok' else {'failed': integrity}
            # Pre-existing violations are tolerated (they were there before); none may be new.
            report['assertions'][f'{label}_foreign_keys_after_vacuum'] = 'ok' if violations <= fk[label] else {'failed': violations}
            report['bytes'][label]['after_vacuum'] = table_bytes(db)
    try:
        validate_schema_compatibility(ds.catalog, ds.identity)
        report['assertions']['schema_compatibility'] = 'ok'
    except SchemaCompatibilityError as error:
        report['assertions']['schema_compatibility'] = {'failed': str(error)}


def finish(report):
    if 'backup' in report: (Path(report['backup']['directory']) / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def rollback(ds, backup_dir):
    """Restore the saved pair into a NEW generation, give it the saved exchange state and point active.json at it."""
    from app.library_exchange.operations import _pointer
    from app.services.active_dataset import resolve_active_dataset
    from app.services.backup import restore_backup, verify_backup
    root, backup_dir = ds.dataset_root, backup_dir.resolve()
    if root is None: raise ValueError('Απαιτείται ενεργή βιβλιοθήκη (CRATEMIND_DATASET_ROOT).')
    bundles = [p for p in backup_dir.glob('cratemind-*') if p.is_dir() and not p.is_symlink()]
    if len(bundles) != 1: raise ValueError(f'Ο φάκελος {backup_dir} πρέπει να περιέχει ακριβώς ένα αντίγραφο cratemind-*.')
    manifest = verify_backup(bundles[0])
    previous, generation = resolve_active_dataset(root).generation, f'rollback-{stamp()}'
    target = restore_backup(bundles[0], root / 'datasets' / generation)
    saved = backup_dir / 'exchange-state.json'
    if saved.is_file(): shutil.copy2(saved, target / 'exchange-state.json')
    _pointer(root, generation, 'identity' in manifest['databases'])
    return {'ok': True, 'mode': 'rollback', 'dataset_root': str(root), 'previous_generation': previous, 'generation': generation,
            'backup': str(bundles[0]), 'exchange_state_restored': saved.is_file()}


def summary(report):
    mb = lambda n: f'{n / 1e6:.1f} MB'
    if report['mode'] == 'rollback':
        return [f"Επαναφορά: νέα γενιά {report['generation']} (η προηγούμενη {report['previous_generation']} διατηρείται).",
                'Κατάσταση ανταλλαγής: ' + ('επαναφέρθηκε από το αντίγραφο.' if report['exchange_state_restored'] else 'δεν υπήρχε στο αντίγραφο.')]
    lines = ['Λειτουργία: ' + ('εφαρμογή' if report['mode'] == 'apply' else 'προεπισκόπηση (δεν αποθηκεύτηκε καμία αλλαγή)')]
    if report.get('error'): return lines + [report['error']]
    lines += [f"{key} {LABELS[key]}: {value['changed']} αλλαγές" + (' (παραλείφθηκε)' if 'skipped' in value else '')
              for key, value in sorted(report['rules'].items(), key=lambda kv: int(kv[0][1:]))]
    if 'R10' in report['rules']:
        r10 = report['rules']['R10']
        lines.append(f"Συνδέσεις SoundCloud: {r10['tier_a']} με υψηλή εμπιστοσύνη, {r10['tier_b']} από τη λήψη των Likes· "
                     f"ενημερωμένα αποτυπώματα συλλογών: {r10['consolidation_hashes']['restamped']}")
    if report.get('suggestions_per_local', {}).get('after_R11'):
        s = report['suggestions_per_local']
        lines.append('Προτάσεις ανά τοπικό κομμάτι (διάμεσος/p90/μέγιστο): ' + ' -> '.join(
            f"{s[k]['median']}/{s[k]['p90']}/{s[k]['max']}" for k in ('before_R4', 'after_R4', 'after_R11')))
    lines += [f'Παραλείφθηκε {key}: {reason}' for key, reason in sorted(report['skipped'].items())]
    failed = [k for k, v in report['assertions'].items() if v != 'ok']
    lines.append('Έλεγχοι: ' + ('όλοι επιτυχείς' if not failed else 'αποτυχία ' + ', '.join(failed)))
    if 'drift' in report: lines.append(f"Ενημερώσεις πριν από τη σύντομη λίστα: near-tie {report['drift']['near_ties']}, κατάσταση {report['drift']['statuses']}")
    for label, value in report['bytes'].items():
        after = value.get('after_vacuum') or value.get('after')
        if after: lines.append(f"{label}: {mb(sum(value['before'].values()))} -> {mb(sum(after.values()))}")
    if report['metrics'].get('after'):
        lines.append(f"Γνωστές ηχογραφήσεις: {report['metrics']['before']['known_recordings']} -> {report['metrics']['after']['known_recordings']}")
        lines.append(f"Ενεργές ηχογραφήσεις (Unified): {report['metrics']['before']['unified_active_recordings']} -> "
                     f"{report['metrics']['after']['unified_active_recordings']}, αναφορές μόνο με αναγνωριστικό: "
                     f"{report['metrics']['before']['unresolved_placeholders']} -> {report['metrics']['after']['unresolved_placeholders']}")
    if 'backup' in report: lines += [f"Αντίγραφο ασφαλείας: {report['backup']['directory']}", f"Επαναφορά: {report['backup']['rollback_command']}"]
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description='Καθαρισμός της βιβλιοθήκης εργασίας (προεπισκόπηση από προεπιλογή).')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='εφαρμογή μετά από επαληθευμένο αντίγραφο ασφαλείας')
    mode.add_argument('--rollback', type=Path, metavar='BACKUP_DIR', help='επαναφορά από φάκελο αντιγράφου του καθαρισμού')
    parser.add_argument('--json', action='store_true', help='πλήρης αναφορά JSON')
    parser.add_argument('--sources', type=Path, default=ROOT / 'SoundCloud-Library-Download', help='φάκελος με τα αρχικά exports')
    parser.add_argument('--input-manifest', type=Path, default=ROOT / 'verification/input_manifest.json')
    args = parser.parse_args(argv)
    with writer_context('clean-working-library') as ds:
        report = rollback(ds, args.rollback) if args.rollback else clean(ds, args)
    print(json.dumps(report, ensure_ascii=False, indent=2, default=list) if args.json else '\n'.join(summary(report)))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
