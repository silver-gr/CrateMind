"""Automatic source links and folds of duplicate remote records (the auto_v1 rules).

plan() only reads the identity catalog and decides. apply() writes each decision through
manual_identity.link_automatic: one ledger row (method auto_v1:<rule>, its kind and batch in evidence_json) plus
the event manual_identity.undo reads, so every decision can be listed and undone, alone or as a batch.
Nothing here calls promote, revoke or materialize (they rebuild every canonical row and can drop hand-made ones),
and no audio file is opened. Rules, guards and measured precision: .omc/plans/2026-11-26-source-linking.md and
.omc/research/source-linking-2026-11-26/catch-up-dry-run/.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone

from . import canonical_library as canonical, manual_identity, source_keys
from .identity_library import live_entity_predicate, placeholder_ids

METHOD = 'auto_v1:'
MAX_DELTA = 2.0                      # seconds; beyond it identical text is another cut of the song
REVIEW_DELTA = 5.0                   # a rule match at 2-5 s is shown for review
REMOTE = ('soundcloud:tracks:', 'spotify:track:')
PROTECTED = ('human', 'kept_local', 'rejected')
# 95% lower bound of each rule set's judged precision, weighted by the rules' share of the decisions.
CONFIDENCE = {'link': 98.6, 'fold': 98.5}
REVIEW_EVENT = 'automatic_link_review_set'


def load(db):
    """Every entity as a plain record for source_keys; 'live' as the app counts recordings."""
    records = {}
    for row in db.execute('SELECT e.*,(' + live_entity_predicate() + ') AS live FROM entities e'):
        raw, normalized = json.loads(row['metadata_json']), json.loads(row['normalized_json'])
        publisher = ((raw.get('raw_metadata') or {}).get('publisher_metadata') or {}) if row['service'] == 'soundcloud' else {}
        records[row['id']] = {
            'id': row['id'], 'service': row['service'], 'title': row['title'] or '', 'artist': row['artist'] or '',
            'dur': row['duration_ms'] / 1000 if row['duration_ms'] else None, 'recording_id': row['recording_id'],
            'live': bool(row['live']), 'kind': normalized.get('kind') or raw.get('type') or '',
            'album': normalized.get('album') or raw.get('album') or publisher.get('album_title') or '',
            'isrc': normalized.get('isrc_key') or '', 'uploader': raw.get('uploader') or '',
            'file_name': raw.get('file_name') or '', 'sc_pub_artist': publisher.get('artist') or ''}
    return records


class _Recordings:
    """The recordings as they stand after the decisions planned so far."""

    def __init__(self, db, records):
        self.records = records
        self.of = {sid: r['recording_id'] for sid, r in records.items()}
        self.members = defaultdict(list)
        for sid, rid in self.of.items():
            self.members[rid].append(sid)
        self.protected = {r[0] for r in db.execute('SELECT recording_id FROM canonical_recordings WHERE state IN (?,?,?)', PROTECTED)}
        # Recordings an undone decision once held together are never joined again, not even through other members:
        # each undone pair puts its two recordings in one class, and a join carries the class along.
        self.apart, self.rejected = {}, defaultdict(set)
        for left, right in db.execute('SELECT left_id,right_id FROM identity_acceptances WHERE revoked_at IS NOT NULL'):
            if left in self.of and right in self.of:
                self.apart[self.kin(self.of[left])] = self.kin(self.of[right])
        rejected = db.execute("SELECT left_id,right_id FROM canonical_blocks WHERE reason IN ('human_rejection','historical_rejection')").fetchall()
        rejected += [r[:2] for r in db.execute("SELECT left_id,right_id,evidence_json FROM candidates WHERE evidence_json LIKE '%previously_rejected%'")
                     if 'previously_rejected' in json.loads(r[2]).get('conflicts', [])]
        for left, right in rejected:
            self.rejected[left].add(right)
            self.rejected[right].add(left)
        self.lists = Counter(r[0] for r in db.execute('SELECT entity_id FROM memberships'))
        self.version_marks = {}

    def live(self, rid):
        return [self.records[sid] for sid in self.members[rid] if self.records[sid]['live']]

    def has_local(self, rid):
        return any(r['service'] == 'local' for r in self.live(rid))

    def services(self, rid):
        return {r['service'] for r in self.live(rid) if r['id'].startswith(REMOTE)}

    def marks(self, record):
        if record['id'] not in self.version_marks:
            self.version_marks[record['id']] = source_keys.version_marks(record)
        return self.version_marks[record['id']]

    def blocked(self, a, b):
        """Why recordings a and b must stay apart, or None. Every pair of members across the two is checked,
        not only the pair that matched. Stored machine blocks (contradictory_isrc, component_*) are not read."""
        if a in self.protected or b in self.protected:
            return 'edited_by_hand'
        if self.has_local(a) and self.has_local(b):
            return 'two_local_files'
        theirs = set(self.members[b])
        if any(self.rejected.get(sid, set()) & theirs for sid in self.members[a]):
            return 'rejected_before'
        if self.kin(a) == self.kin(b):
            return 'undone_before'
        for x in self.live(a):
            for y in self.live(b):
                if x['kind'] != 'track' or y['kind'] != 'track':
                    return 'not_a_single_track'
                if x['dur'] is None or y['dur'] is None:
                    return 'length_unknown'
                if abs(x['dur'] - y['dur']) > MAX_DELTA:
                    return 'length_differs'
                if not source_keys.same_version(self.marks(x), self.marks(y)):
                    return 'version_differs'
        return None

    def keeper(self, a, b):
        """The recording that keeps its title and artist: the one with a local file, else the one with a
        Spotify record, else the one in the most lists."""
        def order(rid):
            live = self.live(rid)
            return (not any(r['service'] == 'local' for r in live), not any(r['service'] == 'spotify' for r in live),
                    -sum(self.lists[sid] for sid in self.members[rid]), rid)
        return min(a, b, key=order)

    def kin(self, rid):
        while self.apart.get(rid, rid) != rid:
            rid = self.apart[rid]
        return rid

    def join(self, a, b, target):
        self.apart[self.kin(a)] = self.kin(b)
        for sid in self.members.pop(b if target == a else a):
            self.of[sid] = target
            self.members[target].append(sid)


def plan(db, allowed=None):
    """Decide the folds, then the links, for the catalog as it is. Reads only.

    allowed: the reviewed pair file as a set of (left_id, right_id); a pair outside it is never decided.
    Returns folds and links in the order they must be written, the manual-review set of unlinked local tracks,
    the pairs a guard stopped and (with `allowed`) the passing pairs that are not in the file.
    """
    records = load(db)
    groups = _Recordings(db, records)
    remotes = sorted((r for r in records.values() if r['live'] and r['id'].startswith(REMOTE)), key=lambda r: r['id'])
    folds, links, review, stopped, outside = [], [], [], [], []

    def decide(kind, rule, left, right, delta, basis, target=None):
        a, b = groups.of[left], groups.of[right]
        reason = groups.blocked(a, b)
        if reason:
            stopped.append({'kind': kind, 'rule': rule, 'left_id': left, 'right_id': right, 'reason': reason})
            return reason
        decision = {'kind': kind, 'rule': rule, 'left_id': left, 'right_id': right, 'delta': round(delta, 3),
                    'basis': basis, 'target': target or groups.keeper(a, b)}
        if allowed is not None and (left, right) not in allowed:
            if not any((d['left_id'], d['right_id']) == (left, right) for d in outside):  # a looser rule finds it again
                outside.append(decision)
            return 'not_in_file'
        groups.join(a, b, decision['target'])
        (folds if kind == 'fold' else links).append(decision)
        return None

    keys = {r['id']: source_keys.fold_keys(r) for r in remotes if r['dur'] is not None}
    for rule in source_keys.FOLD_RULES:
        buckets = defaultdict(list)
        for r in remotes:
            for key in keys.get(r['id'], {}).get(rule, ()):
                buckets[key].append(r)
        for key in sorted(buckets):
            bucket = sorted(buckets[key], key=lambda r: (r['dur'], r['id']))
            near = []
            for i, a in enumerate(bucket):
                for b in bucket[i + 1:]:
                    if b['dur'] - a['dur'] > MAX_DELTA:
                        break
                    near.append((b['dur'] - a['dur'], *sorted((a['id'], b['id']))))
            for delta, left, right in sorted(near):  # closest lengths first; a chain never bridges more than MAX_DELTA
                if groups.of[left] != groups.of[right]:
                    decide('fold', rule, left, right, delta, key if isinstance(key, str) else ' | '.join(key))

    index = source_keys.RemoteIndex(remotes)
    wanted, claims = {}, Counter()
    for local in sorted((r for r in records.values() if r['live'] and r['service'] == 'local'), key=lambda r: r['id']):
        own = groups.of[local['id']]
        held = groups.services(own)
        if local['dur'] is None or held == {'spotify', 'soundcloud'}:
            continue
        found = {rid: (rule, basis, abs(local['dur'] - records[rid]['dur'])) for rid, (rule, basis) in index.pairs(local).items()
                 if groups.of[rid] != own and records[rid]['dur'] is not None}
        auto = {rid: v for rid, v in found.items() if v[0] in source_keys.LINK_RULES and v[2] <= MAX_DELTA}
        best = min(auto, key=lambda rid: (source_keys.RANK[auto[rid][0]], auto[rid][2], rid), default=None)
        clusters = {groups.of[rid] for rid in auto}
        if len(clusters) == 1:
            wanted[local['id']] = (best, groups.of[best], *auto[best])
            claims[groups.of[best]] += 1
        elif not held:  # only an unlinked track is worth a manual look
            lead = None
            if clusters:
                lead = ('several_candidates', best, auto[best][2])
            else:
                title_only = sorted((v[2], rid) for rid, v in found.items() if v[0] == 'title_only' and v[2] <= MAX_DELTA)
                close = sorted((v[2], rid) for rid, v in found.items()
                               if v[0] in source_keys.LINK_RULES[:6] and v[2] <= REVIEW_DELTA)
                similar = None if title_only or close else index.fuzzy(local)
                if title_only:
                    lead = ('title_only', title_only[0][1], title_only[0][0])
                elif close:
                    lead = ('length_2_5', close[0][1], close[0][0])
                elif similar and similar[2]:
                    lead = ('similar_title', similar[0], similar[1])
            if lead:
                review.append({'local_id': local['id'], 'remote_id': lead[1], 'reason': lead[0], 'delta': round(lead[2], 3)})
    for sid in sorted(wanted):
        rid, cluster, rule, basis, delta = wanted[sid]
        own, theirs = groups.of[sid], groups.of[rid]
        held = groups.services(own)
        # One remote recording, with no local file, that no second local file claims, on a service the track lacks.
        if claims[cluster] > 1 or held & groups.services(theirs):
            reason = 'claimed_twice' if claims[cluster] > 1 else 'has_that_service'
            stopped.append({'kind': 'link', 'rule': rule, 'left_id': sid, 'right_id': rid, 'reason': reason})
        else:
            reason = decide('link', rule, sid, rid, delta, basis, target=own)
        if reason and reason != 'not_in_file' and not held:
            review.append({'local_id': sid, 'remote_id': rid, 'reason': 'stopped_by_guard', 'guard': reason, 'delta': round(delta, 3)})
    # A fold another pair achieved is not a stop: keep each pair once, and only if its recordings ended apart.
    stopped = list({(s['left_id'], s['right_id']): s for s in reversed(stopped)
                    if groups.of[s['left_id']] != groups.of[s['right_id']]}.values())[::-1]
    return {'folds': folds, 'links': links, 'review': review, 'stopped': stopped, 'outside': outside}


def _stored_hashes(db):
    """{(decision id, column, key, collection id): hash} of collection_consolidations."""
    found = {}
    for did, baseline, result in db.execute('SELECT id,baseline_json,result_json FROM collection_consolidations').fetchall():
        for column, key, text in (('baseline_json', 'hashes', baseline), ('result_json', 'representative_hashes', result)):
            for cid, value in (json.loads(text).get(key) or {}).items():
                found[did, column, key, cid] = value
    return found


@contextmanager
def _collection_hashes(db):
    """A collection decision stores a fingerprint of its lists' recordings, and a link or an undo moves
    recordings. Re-stamp the fingerprints that matched before the change; one that was stale stays stale
    (as clean_working_library.restamp)."""
    from .collection_consolidation import fingerprint, installed
    if not installed(db):
        yield
        return
    live = {}

    def current(cid):
        if cid not in live:
            try:
                live[cid] = fingerprint(db, cid)
            except ValueError:
                live[cid] = None
        return live[cid]

    matched = {k for k, value in _stored_hashes(db).items() if current(k[3]) == value}
    yield
    live.clear()
    for (did, column, key, cid), value in _stored_hashes(db).items():
        if (did, column, key, cid) in matched and value != current(cid):
            stored = json.loads(db.execute(f'SELECT {column} FROM collection_consolidations WHERE id=?', (did,)).fetchone()[0])
            stored[key][cid] = current(cid)
            db.execute(f'UPDATE collection_consolidations SET {column}=? WHERE id=?', (json.dumps(stored), did))


def _refresh(db, changed=()):
    from .identity_matching import refresh_entity_statuses, refresh_near_ties
    from .identity_sync import refresh_candidates
    refresh_candidates(db, sorted(changed))
    refresh_near_ties(db)
    refresh_entity_statuses(db)


def apply(db, decided, batch=None):
    """Write a plan's folds, then its links, and store its review set; the caller owns the transaction and has
    made the backup. Returns the batch id every row carries."""
    batch = batch or datetime.now(timezone.utc).strftime('auto-%Y%m%dT%H%M%S%fZ')
    with _collection_hashes(db):
        for d in decided['folds'] + decided['links']:
            evidence = {'policy': 'auto_v1', 'batch': batch, 'kind': d['kind'], 'rule': d['rule'],
                        'delta_seconds': d['delta'], 'matched': d['basis']}
            manual_identity.link_automatic(db, d['left_id'], d['right_id'], evidence, method=METHOD + d['rule'],
                                           mode='auto_high_confidence', target=d['target'], confidence=CONFIDENCE[d['kind']])
    _refresh(db)
    db.execute('INSERT INTO canonical_events(action,after_json,created_at) VALUES (?,?,?)',
               (REVIEW_EVENT, canonical.dump({'batch': batch, 'items': decided['review']}), canonical.now()))
    return batch


def _row(db, left, right):
    row = db.execute('SELECT left_id,right_id,method FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)',
                     (left, right, right, left)).fetchone()
    if not row or not row['method'].startswith(METHOD):
        raise ValueError('Εδώ αναιρούνται μόνο οι αυτόματες συνδέσεις.')
    return row


def undo(db, left, right):
    """Undo one automatic link or fold; the pair is never linked automatically again."""
    row = _row(db, left, right)
    with _collection_hashes(db):
        return manual_identity.undo(db, row['left_id'], row['right_id'])


def undo_batch(db, batch):
    """Undo every decision of one batch that is still active, newest first, with one refresh at the end."""
    rows = db.execute("SELECT left_id,right_id FROM identity_acceptances WHERE method LIKE 'auto_v1:%' AND revoked_at IS NULL "
                      "AND json_extract(evidence_json,'$.batch')=? ORDER BY rowid DESC", (batch,)).fetchall()
    if not rows:
        raise ValueError('Δεν υπάρχουν ενεργές αυτόματες συνδέσεις σε αυτή την παρτίδα.')
    with _collection_hashes(db):
        for left, right in rows:
            manual_identity.undo(db, left, right, refresh_matching=False)
    _refresh(db, {sid for row in rows for sid in row})
    return {'undone': len(rows), 'batch': batch}


def decisions(db, kind='link', rule='', batch='', limit=50, offset=0):
    """The active automatic decisions for the review tab: title-only links first, then the newest."""
    source = 'automatic_fold' if kind == 'fold' else 'automatic_link'
    where, args = "a.method LIKE 'auto_v1:%' AND a.revoked_at IS NULL AND a.match_source=?", [source]
    if rule:
        where += ' AND a.method=?'
        args.append(METHOD + rule)
    if batch:
        where += " AND json_extract(a.evidence_json,'$.batch')=?"
        args.append(batch)
    side = ("{0}.id AS {1}_id,{0}.service AS {1}_service,{0}.title AS {1}_title,{0}.artist AS {1}_artist,{0}.duration_ms AS {1}_duration_ms,"
            "{0}.permalink AS {1}_permalink,json_extract({0}.metadata_json,'$.file_name') AS {1}_file_name")
    title_only = ','.join(f"'{METHOD}{r}'" for r in source_keys.TITLE_ONLY_RULES)
    rows = db.execute(
        f"SELECT {side.format('l', 'left')},{side.format('r', 'right')},substr(a.method,{len(METHOD) + 1}) AS rule,a.accepted_at,"
        "json_extract(a.evidence_json,'$.batch') AS batch,json_extract(a.evidence_json,'$.delta_seconds') AS delta_seconds "
        f"FROM identity_acceptances a JOIN entities l ON l.id=a.left_id JOIN entities r ON r.id=a.right_id WHERE {where} "
        f"ORDER BY a.method IN ({title_only}) DESC,a.accepted_at DESC,a.rowid DESC LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    counts = db.execute("SELECT match_source,substr(method,?) AS rule,json_extract(evidence_json,'$.batch') AS batch,count(*) AS n,"
                        "max(accepted_at) AS accepted_at FROM identity_acceptances WHERE method LIKE 'auto_v1:%' AND revoked_at IS NULL "
                        "GROUP BY 1,2,3", (len(METHOD) + 1,)).fetchall()
    rules, batches = {'link': Counter(), 'fold': Counter()}, {}
    for c in counts:
        name = 'fold' if c['match_source'] == 'automatic_fold' else 'link'
        rules[name][c['rule']] += c['n']
        entry = batches.setdefault(c['batch'], {'id': c['batch'], 'link': 0, 'fold': 0, 'accepted_at': c['accepted_at']})
        entry[name] += c['n']
        entry['accepted_at'] = max(entry['accepted_at'], c['accepted_at'])
    return {'total': db.execute(f'SELECT count(*) FROM identity_acceptances a WHERE {where}', args).fetchone()[0],
            'items': [dict(r) for r in rows], 'rules': {k: dict(v) for k, v in rules.items()},
            'batches': sorted(batches.values(), key=lambda b: b['accepted_at'], reverse=True)}


def review(db):
    """The last catch-up's manual-review set, less the tracks linked and the pairs decided since."""
    stored = db.execute('SELECT after_json FROM canonical_events WHERE action=? ORDER BY id DESC LIMIT 1', (REVIEW_EVENT,)).fetchone()
    items = []
    for item in json.loads(stored[0])['items'] if stored else []:
        pair = (item['local_id'], item['remote_id'], item['remote_id'], item['local_id'])
        local = db.execute('SELECT e.recording_id FROM entities e WHERE e.id=? AND ' + live_entity_predicate(), (item['local_id'],)).fetchone()
        if (not local
                or db.execute("SELECT 1 FROM entities WHERE recording_id=? AND (id LIKE 'soundcloud:tracks:%' OR id LIKE 'spotify:track:%')",
                              (local[0],)).fetchone()
                or db.execute('SELECT 1 FROM identity_acceptances WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)', pair).fetchone()
                or db.execute("SELECT 1 FROM canonical_blocks WHERE reason='human_rejection' AND ((left_id=? AND right_id=?) OR (left_id=? AND right_id=?))",
                              pair).fetchone()):
            continue
        items.append(item)
    return {'items': items}


def headline(db):
    """The numbers the owner follows, counted as library_completeness counts them but without touching a file:
    local tracks, those linked to a source record, remote records, their recordings and «Μόνο σε πηγές»."""
    groups = defaultdict(list)
    for sid, service, rid in db.execute('SELECT e.id,e.service,e.recording_id FROM entities e WHERE ' + live_entity_predicate()):
        groups[rid].append((sid, service))
    placeholders = placeholder_ids(db)
    remote = lambda members, extra=(): any(sid.startswith(REMOTE + extra) for sid, _ in members)
    local = lambda members: sum(service == 'local' for _, service in members)
    return {'local_tracks': sum(local(m) for m in groups.values()),
            'linked_local_tracks': sum(local(m) for m in groups.values() if remote(m)),
            'remote_records': sum(sid.startswith(REMOTE) for m in groups.values() for sid, _ in m),
            'remote_recordings': sum(remote(m) for m in groups.values()),
            'remote_only': sum(1 for rid, m in groups.items() if rid not in placeholders and not local(m)
                               and remote(m, ('spotify:episode:',)))}
