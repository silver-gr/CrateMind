"""Populate CrateMind's additive identity DB from verified sources + a fresh catalog backup.

Existing production tables/source files are never written. No cloud I/O.
Builds a temporary file and atomically publishes only after invariant checks.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.services.identity_matching import CandidateIndex, normalized_item, score_candidate, annotate_near_ties
from preview import FIELDS, clean, db_digest, read_rows, ro_db, sha, snapshot

SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE recordings(id TEXT PRIMARY KEY,title TEXT,status TEXT NOT NULL);
CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT NOT NULL,title TEXT,artist TEXT,duration_ms REAL,
 local_track_id INTEGER,permalink TEXT,recording_id TEXT REFERENCES recordings(id),status TEXT NOT NULL,
 metadata_json TEXT NOT NULL,normalized_json TEXT NOT NULL);
CREATE INDEX entities_recording ON entities(recording_id);
CREATE INDEX entities_service_status ON entities(service,status);
CREATE INDEX entities_title ON entities(title);
CREATE TABLE candidates(left_id TEXT REFERENCES entities(id),right_id TEXT REFERENCES entities(id),pair_type TEXT NOT NULL,
 score REAL NOT NULL,class TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(left_id,right_id));
CREATE INDEX candidates_right ON candidates(right_id,class);
CREATE INDEX candidates_class ON candidates(class,score);
CREATE TABLE collections(id TEXT PRIMARY KEY,name TEXT,service TEXT,kind TEXT,track_count INTEGER,provenance_json TEXT NOT NULL);
CREATE TABLE memberships(collection_id TEXT REFERENCES collections(id),position INTEGER NOT NULL,entity_id TEXT REFERENCES entities(id),
 added_at TEXT,source_json TEXT NOT NULL,PRIMARY KEY(collection_id,position));
CREATE INDEX memberships_entity ON memberships(entity_id);
'''


def dump(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def identity_items(stage, catalog):
    items = {}
    source = ro_db(catalog)
    profiles = {r['normalized_name']: dict(r) for r in source.execute('SELECT * FROM artist_profiles')}
    for r in source.execute('SELECT * FROM tracks'):
        t = dict(r); profile = profiles.get(t.get('artist_normalized'), {})
        aliases = [profile['canonical_name']] if profile.get('canonical_name') else []
        try:
            aliases += [a for a in json.loads(profile.get('aliases_json') or '[]') if isinstance(a, str)]
        except (ValueError, TypeError):
            pass
        item = {'id': 'local:' + str(t['id']), 'service': 'local', 'title': t['title'], 'artist': t['artist'],
                'artist_aliases': aliases, 'file_name': t['file_name'], 'duration_ms': t['duration'] * 1000 if t['duration'] is not None else None,
                'album': t['album'], 'label': t['label'], 'genre': t['genre'], 'year': t['year'], 'bpm': t['bpm'],
                'local_track_id': t['id'], 'kind': 'track', 'raw': clean(t), 'artist_profile': clean(profile)}
        items[item['id']] = normalized_item(item)
    accepted = [dict(r) for r in source.execute('SELECT * FROM track_soundcloud_matches')]
    history = [dict(r) for r in source.execute('SELECT * FROM soundcloud_match_candidates')]
    source.close()
    observations = collections.defaultdict(list)
    for observation in read_rows(stage / 'source_observations.jsonl'):
        observations[observation['source_item_id']].append(observation)
    for row in read_rows(stage / 'source_items.jsonl'):
        remote = row.get('remote_id')
        raw = row.get('raw_metadata', {})
        source_observations = observations[row['source_item_id']]
        spotify_fields = {FIELDS.get(k, k): v for k, v in source_observations[0]['raw_metadata'].items()} if source_observations else {}
        item = {'id': row['source_item_id'], 'service': row['service'], 'title': row.get('title'),
                'artist': row.get('performer'), 'uploader': row.get('uploader'), 'isrc': row.get('isrc'),
                'duration_ms': row.get('duration_ms'), 'album': row.get('album') or spotify_fields.get('album'), 'label': row.get('label_name') or raw.get('label_name') or spotify_fields.get('Record Label'),
                'genre': row.get('genre') or raw.get('genre') or spotify_fields.get('Genres'), 'year': (row.get('release_date') or '')[:4],
                'bpm': row.get('bpm'), 'kind': row.get('type', 'track'), 'permalink': row.get('service_url'),
                'raw': {**row, 'source_observations': source_observations}, 'remote_id': remote}
        # A long-form flag is review evidence; normalize duration classes consistently on both sides below.
        items[item['id']] = normalized_item(item)
    for t in items.values():
        if t['kind'] in ('track', 'long_form'):
            t['kind'] = 'long_form' if (t.get('duration_ms') or 0) >= 1200000 or re.search(r'\bdj\s*(?:mix|set)\b', t.get('title') or '', re.I) else 'track'
    return items, accepted, history


def compute_candidates(items, accepted, history, stage):
    anchors = {}
    for r in history:
        a, b = 'local:' + str(r['track_id']), 'soundcloud:tracks:' + str(r['soundcloud_track_id'])
        if r['status'] == 'rejected':
            anchors[(a, b)] = {'status': 'rejected', 'method': 'existing_rejection', 'original': clean(r)}
    for r in accepted:
        a, b = 'local:' + str(r['track_id']), 'soundcloud:tracks:' + str(r['soundcloud_track_id'])
        anchors[(a, b)] = {'trusted': True, 'method': 'existing_' + r['method'], 'original': clean(r)}
    historical = {}
    for r in read_rows(stage / 'match_candidates.jsonl'):
        if r['method'] == 'legacy_heuristic':
            historical.setdefault((r['left'], r['right']), []).append(r['evidence'])
    # Recognized explicit URLs only: a bare number in arbitrary comments is not an ID.
    url_index = {x.get('permalink', '').rstrip('/'): x['id'] for x in items.values() if x.get('permalink')}
    for t in items.values():
        if t['service'] != 'local':
            continue
        comment = t['raw'].get('comment') or ''
        for url in re.findall(r'https?://[^\s<>"\']+', comment):
            target = url_index.get(url.split('?', 1)[0].rstrip('/'))
            if target:
                anchors.setdefault((t['id'], target), {'trusted': True, 'method': 'explicit_provider_url', 'url': clean(url)})
        for sid in re.findall(r'\b(?:soundcloud:tracks:\d+|spotify:track:[A-Za-z0-9]+)\b', comment):
            if sid in items:
                anchors.setdefault((t['id'], sid), {'trusted': True, 'method': 'explicit_provider_id', 'id': sid})
    by_service = {s: [x for x in items.values() if x['service'] == s] for s in ('local', 'spotify', 'soundcloud')}
    results = {}
    for left_service, right_service in [('local', 'soundcloud'), ('local', 'spotify'), ('spotify', 'soundcloud')]:
        print('Generating', left_service, '<->', right_service, flush=True)
        index = CandidateIndex(by_service[right_service])
        for i, left in enumerate(by_service[left_service]):
            ids = set(index.retrieve(left))
            ids.update(b for a, b in anchors if a == left['id'] and b in index.items)
            ids.update(b for a, b in historical if a == left['id'] and b in index.items)
            for rid in ids:
                right = index.items[rid]
                anchor = anchors.get((left['id'], rid))
                result = score_candidate(left, right, anchor=anchor)
                evidence = result['evidence']
                # Low-relevance retrieval hits do not fill the review queue. No equality gate.
                if not anchor and not evidence['isrc_equal'] and (evidence['title_similarity'] < .40 or result['score'] < 43):
                    continue
                if (left['id'], rid) in historical:
                    evidence['historical_provenance'] = historical[(left['id'], rid)]
                result.update(left_id=left['id'], right_id=rid, pair_type=left_service + ':' + right_service)
                results[(left['id'], rid)] = result
            if i and i % 2000 == 0:
                print(' ', i, 'sources processed;', len(results), 'retained pairs', flush=True)
    # Neighborhood support must come from independently accepted track-level pairs,
    # never from the user's global transfer history alone.
    membership_rows = read_rows(stage / 'source_memberships.jsonl')
    locations = collections.defaultdict(list)
    sequences = collections.defaultdict(dict)
    collection_info = {c['collection_id']: c for c in read_rows(stage / 'source_collections.jsonl')}
    for m in membership_rows:
        if not m['is_likes']:
            locations[m['source_item_id']].append((m['collection_id'], m['position']))
            sequences[m['collection_id']][m['position']] = m['source_item_id']
    independent = {(r['left_id'], r['right_id']) for r in results.values() if r['class'] == 'ACCEPTED'}
    def neighbors(entity_id):
        out = set()
        for cid, pos in locations[entity_id]:
            for offset in (-2, -1, 1, 2):
                if pos + offset in sequences[cid]:
                    out.add(sequences[cid][pos + offset])
        return out
    neighbor_cache = {sid: neighbors(sid) for sid in items if items[sid]['service'] != 'local'}
    for pair, result in list(results.items()):
        a, b = pair
        context = {'left_collection_count': len(locations[a]), 'right_collection_count': len(locations[b]),
                   'global_transfer_history_is_not_track_identity': True}
        if result['pair_type'] == 'spotify:soundcloud':
            support = [(x, y) for x in neighbor_cache[a] for y in neighbor_cache[b] if (x, y) in independent]
            context['independently_anchored_neighbors'] = len(support)
            context['neighbor_examples'] = sorted(support)[:5]
            context['user_confirmed_sc_to_spotify_transfer'] = True
        if not context.get('independently_anchored_neighbors'):
            result['evidence']['collection_context'] = context
            continue
        refreshed = score_candidate(items[a], items[b], anchor=anchors.get(pair), context=context)
        if result['evidence'].get('historical_provenance'):
            refreshed['evidence']['historical_provenance'] = result['evidence']['historical_provenance']
        result.update(refreshed)
    # Only independently accepted components are equivalent alternatives.
    parent = {sid: sid for sid in items}
    def component(sid):
        while parent[sid] != sid:
            parent[sid] = parent[parent[sid]]
            sid = parent[sid]
        return sid
    for result in results.values():
        if result['class'] == 'ACCEPTED':
            a, b = component(result['left_id']), component(result['right_id'])
            parent[max(a,b)] = min(a,b)
    annotate_near_ties(list(results.values()), {sid: component(sid) for sid in items},
                       {sid: item['service'] for sid,item in items.items()})
    return sorted(results.values(), key=lambda r: (r['left_id'], r['right_id']))


def populate(path, items, candidates, stage):
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    parent = {sid: sid for sid in items}
    def find(sid):
        while parent[sid] != sid:
            parent[sid] = parent[parent[sid]]; sid = parent[sid]
        return sid
    for r in candidates:
        if r['class'] == 'ACCEPTED':
            a, b = find(r['left_id']), find(r['right_id'])
            parent[max(a, b)] = min(a, b)
    groups = collections.defaultdict(list)
    for sid in items:
        groups[find(sid)].append(sid)
    ranking = {'ACCEPTED': 6, 'HIGH_CONFIDENCE': 5, 'PROBABLE': 4, 'AMBIGUOUS': 3, 'CONFLICT': 2, 'NO_CANDIDATE': 1}
    status = {sid: 'NO_CANDIDATE' for sid in items}
    for r in candidates:
        for sid in (r['left_id'], r['right_id']):
            if ranking[r['class']] > ranking[status[sid]]:
                status[sid] = r['class']
    for root, group in groups.items():
        preferred = min(group, key=lambda sid: (items[sid]['service'] != 'local', not bool(items[sid].get('title')), sid))
        db.execute('INSERT INTO recordings VALUES (?,?,?)', (root, items[preferred].get('title'), 'ACCEPTED' if len(group) > 1 else 'PROVISIONAL'))
    for sid, item in items.items():
        db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                   (sid, item['service'], item.get('title'), item.get('artist') or item.get('uploader'), item.get('duration_ms'),
                    item.get('local_track_id'), item.get('permalink'), find(sid), status[sid], dump(clean(item['raw'])),
                    dump({k: v for k, v in item.items() if k not in ('raw', 'artist_profile')})))
    for r in candidates:
        db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', (r['left_id'], r['right_id'], r['pair_type'], r['score'], r['class'], dump(r['evidence'])))
    source_collections = read_rows(stage / 'source_collections.jsonl')
    for c in source_collections:
        db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)', (c['collection_id'], c['name'], c['service'], 'likes' if c['is_likes'] else 'source_snapshot', c['track_count'], dump(c)))
    for m in read_rows(stage / 'source_memberships.jsonl'):
        db.execute('INSERT INTO memberships VALUES (?,?,?,?,?)', (m['collection_id'], m['position'], m['source_item_id'], m.get('added_at'), dump(m)))
    preview = json.loads((stage / 'collection_preview.json').read_text())
    origin = preview['source_snapshot']['collection_id']
    db.execute('INSERT INTO collections VALUES (?,?,?,?,?,?)', ('local:collection:summer-proof', preview['source_snapshot']['name'], 'cratemind', 'local_copy', len(preview['source_entries']), dump({'origin_snapshot': origin, 'purpose': 'first unified collection', 'import_policy': 'new local collection, original unchanged'})))
    db.execute('INSERT INTO memberships SELECT ?,position,entity_id,added_at,source_json FROM memberships WHERE collection_id=?', ('local:collection:summer-proof', origin))
    summary = {'entities': len(items), 'candidate_pairs': len(candidates), 'classes': dict(collections.Counter(r['class'] for r in candidates)), 'by_pair': {}, 'coverage': {},
               'retained_nonmusic_spotify_entities': sum(t['service'] == 'spotify' and not t['id'].startswith('spotify:track:') for t in items.values()), 'collections': len(source_collections) + 1, 'proof_collection_id': 'local:collection:summer-proof', 'scores_are_probabilities': False,
               'basis': 'resolved = accepted recording component; candidates shown separately', 'built_at': datetime.now(timezone.utc).isoformat()}
    for pair in ('local:soundcloud', 'local:spotify', 'spotify:soundcloud'):
        summary['by_pair'][pair] = dict(collections.Counter(r['class'] for r in candidates if r['pair_type'] == pair))
    for service in ('local', 'spotify', 'soundcloud'):
        others = [s for s in ('local', 'spotify', 'soundcloud') if s != service]
        rows = [sid for sid in items if items[sid]['service'] == service and (service != 'spotify' or sid.startswith('spotify:track:'))]
        counts = collections.Counter()
        for sid in rows:
            services = {items[s]['service'] for s in groups[find(sid)]} - {service}
            counts['total'] += 1
            counts['resolved_to_' + others[0]] += others[0] in services
            counts['resolved_to_' + others[1]] += others[1] in services
            counts['resolved_to_both'] += len(services) == 2
            counts['no_accepted_cross_source_link'] += not services
            counts['status_' + status[sid]] += 1
        summary['coverage'][service] = dict(counts)
    db.execute('INSERT INTO metadata VALUES (?,?)', ('summary', dump(summary)))
    db.execute('INSERT INTO metadata VALUES (?,?)', ('policy', dump({'version': 1, 'remote_mutations': False, 'production_catalog_mutations': False, 'acceptance': 'preserved decisions, explicit provider identities, corroborated compatible ISRC; metadata scores are proposals'})))
    db.commit()
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert not db.execute('''SELECT c.id FROM collections c LEFT JOIN memberships m ON m.collection_id=c.id GROUP BY c.id HAVING count(m.position)!=c.track_count''').fetchall()
    db.close()
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, default=ROOT / 'reconciliation/runs/20260914-preview')
    parser.add_argument('--output', type=Path, default=ROOT / 'backend/data/identity.sqlite')
    args = parser.parse_args()
    # Canonical decisions are durable, unlike this replaceable candidate projection.
    target = args.output
    if target.exists():
        with sqlite3.connect(target.resolve().as_uri() + '?mode=ro', uri=True) as existing:
            if existing.execute("SELECT 1 FROM sqlite_master WHERE name='identity_acceptances'").fetchone():
                raise SystemExit('Canonical decisions exist. Build to a separate preview DB; never overwrite the acceptance ledger.')
    report = ROOT / 'reconciliation/identity'; report.mkdir(exist_ok=True)
    snapshot_path = report / 'catalog_snapshot.sqlite'
    live = ROOT / 'backend/data/cratemind.sqlite'
    if args.output.resolve() == live.resolve() or args.output.resolve().is_relative_to((ROOT / 'SoundCloud-Library-Download').resolve()):
        raise ValueError('Identity output must never replace a source catalog or source archive')
    c = ro_db(live); before = db_digest(c); c.close()
    if snapshot_path.exists():
        c = ro_db(snapshot_path); cached = db_digest(c); c.close()
        if cached != before:
            snapshot_path = report / ('catalog_snapshot_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite')
    if not snapshot_path.exists():
        snapshot(live, snapshot_path)
    items, accepted, history = identity_items(args.stage, snapshot_path)
    candidates = compute_candidates(items, accepted, history, args.stage)
    temp = args.output.with_suffix('.building.sqlite')
    if temp.exists():
        temp.unlink()  # only an importer-owned incomplete build, never the published catalog
    result = populate(temp, items, candidates, args.stage)
    # Existing accepted pairs must all remain explicitly accepted, not only connected transitively.
    accepted_pairs = {(r['left_id'], r['right_id']) for r in candidates if r['class'] == 'ACCEPTED'}
    assert all(('local:' + str(r['track_id']), 'soundcloud:tracks:' + str(r['soundcloud_track_id'])) in accepted_pairs for r in accepted)
    c = ro_db(live); after = db_digest(c); c.close()
    if before != after:
        raise RuntimeError('Live catalog changed during build; candidate database not published')
    os.replace(temp, args.output)
    (report / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (report / 'source_preservation.json').write_text(json.dumps({'logical_tables_unchanged': True, 'tables': before, 'snapshot_sha256': sha(snapshot_path)}, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
