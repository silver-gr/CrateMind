"""Pure evidence scoring shared by the offline importer and CrateMind identity UI.

No network, file reads, database writes or acceptance based on popularity.
The scanner's filename parser remains the common cleaning foundation.
"""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from .metadata_reader import infer_tags_from_filename
from .identity_policy import POLICY_VERSION, automatic_eligible, weak_artist
from . import soundcloud

VERSION_RE = re.compile(r'\b(remix|rmx|edit|live|remaster(?:ed)?|bootleg|dub|instrumental|acoustic|extended|radio)\b', re.I)
PROMO = re.compile(r'\b(?:official\s+(?:audio|video|music video)|free\s*(?:download|dowload|dl)|premiere|out now|full version|youtube|soundcloud)\b', re.I)
NOISE_BRACKET = re.compile(r'[\[(](?:\s*(?:19|20)\d{2}\s*|\s*\d{2,3}\s*(?:bpm)?\s*|\s*[A-Z]{2,8}[-_ ]?\d{2,6}\s*)[\])]')
CATALOG_PREFIX = re.compile(r'^\s*(?:\d{1,4}[.)_ ]+|[A-Z]{2,8}[-_]?\d{2,6}\s*[-:]\s*)')


def text_key(value: str | None) -> str:
    # The established SC normalizer owns Unicode, punctuation, extensions,
    # download noise and featuring forms. Only collaboration spelling is adapted.
    value = (value or '').replace('&', ' and ').replace('_', ' ')
    return soundcloud.normalize_match_text(value)



def version_terms(value: str | None) -> list[str]:
    return sorted({'remix' if t.lower() == 'rmx' else 'remaster' if t.lower().startswith('remaster') else t.lower()
                   for t in VERSION_RE.findall(value or '')})


def clean_variant(value: str | None) -> str:
    value = unicodedata.normalize('NFKC', value or '').replace('—', '-').replace('–', '-')
    value = PROMO.sub(' ', value)
    value = re.sub(r'\(\s*original\s+mix\s*\)', ' ', value, flags=re.I)
    value = NOISE_BRACKET.sub(' ', value)
    value = re.sub(r'\b\d{2,3}\s*bpm\b', ' ', value, flags=re.I)
    value = CATALOG_PREFIX.sub('', value)
    return value.strip(' -[]()')


def normalized_item(item: dict) -> dict:
    """Keep full persisted/provider identity and a small set of explained alternatives."""
    titles: list[tuple[str, str]] = []
    artists: list[tuple[str, str]] = []

    def add_title(value, basis):
        if value and text_key(value):
            titles.append((text_key(clean_variant(value)), basis))

    def add_artist(value, basis):
        if not weak_artist(value):
            artists.append((text_key(value), basis))

    add_title(item.get('title'), 'persisted_or_provider_title')
    add_artist(item.get('artist'), 'persisted_or_provider_artist')
    # Uploader is a separate, weaker role throughout scoring.
    uploader = text_key(item.get('uploader'))
    for name in item.get('artist_aliases', []):
        add_artist(name, 'artist_profile_alias')
    for value, basis in [(item.get('title'), 'title_parser'), (item.get('file_name'), 'filename_parser')]:
        if not value:
            continue
        value = clean_variant(value)
        # Reuse the existing pure parser without touching the audio file.
        parsed = infer_tags_from_filename(Path(value if basis == 'filename_parser' else value + '.mp3'))
        add_title(parsed.get('title'), basis)
        add_artist(parsed.get('artist'), basis)
        parts = re.split(r'\s+-\s+', value)
        if len(parts) >= 3:
            # Retain alternatives for uploader/label - performer - title wrappers.
            add_title(' - '.join(parts[2:]), basis + '_nested')
            add_artist(parts[1], basis + '_nested')
        # Some old files contain only the entire wrapper, not real title tags.
        add_title(value.rsplit('.', 1)[0] if basis == 'filename_parser' else value, basis + '_whole')
    def unique(values):
        return [{'text': t, 'basis': b} for t, b in dict.fromkeys(values) if t]
    # Inspect the song portion of wrappers: an artist named "Live Magnet" or
    # "Kayros Live" is not evidence of a live recording. Filename song terms
    # still repair version information missing from persisted titles.
    versions = set()
    for value, is_filename in ((item.get('title'), False), (item.get('file_name'), True)):
        if value:
            parsed = infer_tags_from_filename(Path(value if is_filename else value + '.mp3'))
            # Only remove the wrapper prefix; the parser's cleaned title can
            # intentionally drop parentheticals such as "(2014 Edit)".
            parts = re.split(r'\s+[-–—]\s+', value, maxsplit=1)
            subject = parts[1] if parsed.get('artist') and len(parts) == 2 else value
            versions.update(version_terms(subject))
    versions = sorted(versions)
    return {**item, 'title_variants': unique(titles), 'artist_variants': unique(artists), 'uploader_key': uploader,
            'versions': versions, 'isrc_key': re.sub(r'[^A-Z0-9]', '', (item.get('isrc') or '').upper()),
            'normalization_version': 4}


def similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    overlap = soundcloud._token_jaccard(left, right)
    dice = 2 * overlap / (1 + overlap)
    ratio = SequenceMatcher(None, left, right, autojunk=False).ratio()
    return max(dice, ratio * .95)


def best_similarity(left: list[dict], right: list[dict]) -> tuple[float, dict]:
    best = (0.0, {})
    for a in left:
        for b in right:
            score = similarity(a['text'], b['text'])
            if score > best[0]:
                best = (score, {'left': a, 'right': b})
    return best


def score_candidate(left: dict, right: dict, anchor: dict | None = None, context: dict | None = None) -> dict:
    title, title_basis = best_similarity(left['title_variants'], right['title_variants'])
    # Older persisted normalizations may still contain numeric/label credits.
    left_artists = [a for a in left['artist_variants'] if not weak_artist(a['text'])]
    right_artists = [a for a in right['artist_variants'] if not weak_artist(a['text'])]
    artist, artist_basis = best_similarity(left_artists, right_artists)
    uploader = max([similarity(a['text'], right['uploader_key']) for a in left_artists] +
                   [similarity(a['text'], left['uploader_key']) for a in right_artists] + [0.0])
    ld, rd = left.get('duration_ms'), right.get('duration_ms')
    delta = abs(ld - rd) / 1000 if ld is not None and rd is not None else None
    duration = soundcloud.duration_similarity(delta, window_seconds=18.0)
    same_isrc = bool(left['isrc_key'] and left['isrc_key'] == right['isrc_key'])
    flags = []
    if left['isrc_key'] and right['isrc_key'] and not same_isrc:
        flags.append('contradictory_isrc')
    lv, rv = set(left['versions']), set(right['versions'])
    # Original mix is neutral; semantic alternate versions are not.
    if lv != rv:
        flags.append('version_mismatch')
    # Preserve named remixer conflicts even where both titles contain "remix".
    remix_l = re.findall(r'[\[(]([^\])]*(?:remix|rmx|edit))[^\])]*[\])]',
                        ' '.join(filter(None, (left.get('title'), left.get('file_name')))), re.IGNORECASE)
    remix_r = re.findall(r'[\[(]([^\])]*(?:remix|rmx|edit))[^\])]*[\])]',
                        ' '.join(filter(None, (right.get('title'), right.get('file_name')))), re.IGNORECASE)
    if remix_l and remix_r and similarity(text_key(' '.join(remix_l)), text_key(' '.join(remix_r))) < .8:
        flags.append('remixer_mismatch')
    if delta is not None and delta > max(30, .08 * max(ld, rd) / 1000):
        flags.append('duration_conflict')
    if left.get('kind', 'track') != right.get('kind', 'track'):
        flags.append('media_type_conflict')
    if left.get('kind') in {'episode', 'local', 'unknown'} or right.get('kind') in {'episode', 'local', 'unknown'}:
        flags.append('non_music_identity')
    primary_artist_left = text_key(left.get('artist'))
    primary_artist_right = text_key(right.get('artist'))
    primary_artist_similarity = similarity(primary_artist_left, primary_artist_right)
    if (not weak_artist(left.get('artist')) and not weak_artist(right.get('artist'))
            and primary_artist_similarity < .28 and artist >= .8):
        flags.append('supplemental_artist_contradicts_primary')
    # Strong contradictory performer evidence must not be rescued by duration/context.
    if left_artists and right_artists and artist < .28 and title > .8:
        flags.append('artist_conflict')
    provenance = 0.0
    if left.get('album') == 'Likes of DJ PanoramixXX' and right['service'] == 'soundcloud' or right.get('album') == 'Likes of DJ PanoramixXX' and left['service'] == 'soundcloud':
        provenance = 2.0
    label = similarity(text_key(left.get('label')), text_key(right.get('label')))
    genre = similarity(text_key(left.get('genre')), text_key(right.get('genre')))
    context = context or {}
    context_bonus = min(2.0, float(context.get('independently_anchored_neighbors', 0)))
    # Weak/context signals total <= 5; none can remove a conflict or prove identity.
    weak = min(5.0, provenance + label + genre + context_bonus)
    metadata_score = 100 * soundcloud.weighted_metadata_score(title, max(artist, uploader * .65), duration, artist_weight=.25)
    # Neighborhood affects ranking only. Even a plausible imperfect migration
    # must independently meet the confidence threshold without neighbor points.
    intrinsic_score = min(99.0, metadata_score + min(5.0, provenance + label + genre))
    score = min(99.0, metadata_score + weak)
    if same_isrc:
        score = max(score, 94.0)
        intrinsic_score = max(intrinsic_score, 94.0)
    provider_performer = any(
        item.get('service') in {'spotify', 'soundcloud'} and any(
            a['basis'] != 'artist_profile_alias' for a in artists)
        for item, artists in ((left, left_artists), (right, right_artists)))
    eligibility = {
        'conflicts': flags, 'score_without_neighborhood': intrinsic_score,
        'title_similarity': title, 'artist_similarity': artist,
        'duration_delta_seconds': delta,
        'weak_artist_performer_evidence': provider_performer and (
            weak_artist(left.get('artist')) or weak_artist(right.get('artist'))),
        'identity_policy': POLICY_VERSION,
    }
    category = 'AMBIGUOUS'
    if flags:
        category = 'CONFLICT'
    elif same_isrc and title >= .8 and delta is not None and delta <= 5 and artist >= .65:
        category = 'ACCEPTED'
    elif automatic_eligible(eligibility):
        category = 'HIGH_CONFIDENCE'
    elif intrinsic_score >= 72 and title >= .67:
        category = 'PROBABLE'
    if anchor:
        if anchor.get('status') == 'rejected':
            category = 'CONFLICT'; flags.append('previously_rejected')
        elif anchor.get('trusted'):
            category = 'ACCEPTED'
            # Preserve contradictory evidence on existing accepted decisions, never silently replace them.
            score = 100.0
    return {'score': round(score, 2), 'class': category,
            'evidence': {**eligibility, 'primary_title_similarity': round(similarity(text_key(left.get('title')), text_key(right.get('title'))), 4),
                         'primary_artist_similarity': round(primary_artist_similarity, 4),
                         'metadata_authority': 'persisted/provider fields primary; parsed alternatives supplemental',
                         'shared_scoring_service': 'app.services.soundcloud', 'title_similarity': round(title, 4), 'title_basis': title_basis,
                         'artist_similarity': round(artist, 4), 'artist_basis': artist_basis,
                         'uploader_similarity': round(uploader, 4), 'duration_delta_seconds': delta,
                         'isrc_equal': same_isrc, 'version_left': sorted(lv), 'version_right': sorted(rv),
                         'conflicts': flags, 'provenance_bonus': provenance, 'weak_bonus': weak,
                         'score_without_neighborhood': round(intrinsic_score, 2),
                         'neighborhood_changes_confidence_class': False,
                         'collection_context': context, 'anchor': anchor, 'genre_similarity': round(genre, 4),
                         'label_similarity': round(label, 4), 'year_left': left.get('year'), 'year_right': right.get('year'),
                         'bpm_left': left.get('bpm'), 'bpm_right': right.get('bpm'), 'popularity_used_for_identity': False,
                         'score_is_probability': False}}


class CandidateIndex:
    """Inverted title/artist/trigram/ISRC retrieval, bounded before pair scoring."""
    def __init__(self, items: list[dict]):
        self.items = {}
        self.tokens = defaultdict(set)
        self.grams = defaultdict(set)
        self.artists = defaultdict(set)
        self.isrcs = defaultdict(set)
        self.exact_titles = defaultdict(set)
        for item in items:
            self.add(item)

    def _memberships(self, item: dict):
        for t in item['title_variants']:
            yield self.exact_titles, t['text']
            for token in set(t['text'].split()):
                if len(token) > 2:
                    yield self.tokens, token
            compressed = t['text'].replace(' ', '')
            for gram in {compressed[i:i + 3] for i in range(len(compressed) - 2)}:
                yield self.grams, gram
        for a in item['artist_variants']:
            for token in set(a['text'].split()):
                if len(token) > 2:
                    yield self.artists, token
        if item['isrc_key']:
            yield self.isrcs, item['isrc_key']

    def add(self, item: dict) -> None:
        """Insert or replace an item without retaining its previous lookup keys."""
        item_id = item['id']
        previous = self.items.get(item_id)
        if previous is not None:
            for index, key in self._memberships(previous):
                ids = index.get(key)
                if ids is not None:
                    ids.discard(item_id)
                    if not ids:
                        del index[key]
        self.items[item_id] = item
        for index, key in self._memberships(item):
            index[key].add(item_id)

    def retrieve(self, item: dict, limit: int = 35) -> list[str]:
        votes = Counter()
        n = len(self.items)
        for token in {t for v in item['title_variants'] for t in v['text'].split() if len(t) > 2}:
            ids = self.tokens.get(token, ())
            if len(ids) < n * .2:
                weight = math.log(2 + n / (1 + len(ids)))
                for sid in ids:
                    votes[sid] += weight
        for token in {t for v in item['artist_variants'] for t in v['text'].split() if len(t) > 2}:
            ids = self.artists.get(token, ())
            if len(ids) < 250:
                for sid in ids:
                    votes[sid] += 2.0
        # Trigrams recover misspellings even when token equality yields nothing.
        grams = {v['text'].replace(' ', '')[i:i + 3] for v in item['title_variants'] for i in range(len(v['text'].replace(' ', '')) - 2)}
        for gram in sorted(grams, key=lambda g: len(self.grams.get(g, ())))[:12]:
            ids = self.grams.get(gram, ())
            if len(ids) < 180:
                for sid in ids:
                    votes[sid] += .65
        for sid in list(votes):
            a, b = item.get('duration_ms'), self.items[sid].get('duration_ms')
            if a is not None and b is not None and abs(a - b) < 10000:
                votes[sid] += 2.0
        ranked = sorted(votes, key=lambda sid: (-votes[sid], sid))[:limit]
        strong = set(self.isrcs.get(item['isrc_key'], ()))
        for variant in item['title_variants']:
            strong.update(self.exact_titles.get(variant['text'], ()))
        return sorted(set(ranked) | strong)


def annotate_near_ties(results, component_ids, services):
    """Rank distinct accepted components, so equivalent source copies do not compete."""
    competing = defaultdict(list)
    for result in results:
        evidence = result['evidence']
        original = evidence.pop('near_tie_original_class', None)
        if original:
            result['class'] = original
        evidence.pop('near_tie_review', None)
        if result['class'] not in {'HIGH_CONFIDENCE', 'PROBABLE'}:
            continue
        for source, other in ((result['left_id'], result['right_id']),
                              (result['right_id'], result['left_id'])):
            if component_ids[source] != component_ids[other]:
                competing[(source, services[other])].append((component_ids[other], result))
    ambiguous = set()
    for rows in competing.values():
        scores = {}
        for component, result in rows:
            scores[component] = max(scores.get(component, 0), result['score'])
        ranked = sorted(scores.values(), reverse=True)
        if len(ranked) > 1 and ranked[0] - ranked[1] < 3:
            for component, result in rows:
                if ranked[0] - scores[component] < 3:
                    ambiguous.add((result['left_id'], result['right_id']))
    for result in results:
        if (result['left_id'], result['right_id']) in ambiguous:
            result['evidence']['near_tie_review'] = True
            result['evidence']['near_tie_original_class'] = result['class']
            if result['class'] == 'HIGH_CONFIDENCE':
                result['class'] = 'AMBIGUOUS'
    return results


def refresh_near_ties(db):
    """Refresh only plausible/previously annotated pairs, without per-pair reads."""
    import json
    from .identity_library import current_local_predicate
    eligibility = ("(e.service!='local' OR (" + current_local_predicate() + ")) AND "
                   "COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired' AND "
                   "COALESCE(json_type(e.metadata_json,'$.catalog_current'),'')!='false'")
    entities = {r['id']: dict(r) for r in db.execute(
        'SELECT e.id,e.service,e.recording_id,e.normalized_json,(' + eligibility + ') AS eligible FROM entities e')}
    results = []
    originals = {}
    normalized = {}
    rows = db.execute("SELECT left_id,right_id,score,class,evidence_json FROM candidates WHERE "
                      "class IN ('HIGH_CONFIDENCE','PROBABLE') OR "
                      "json_type(evidence_json,'$.near_tie_review') IS NOT NULL OR "
                      "json_type(evidence_json,'$.near_tie_original_class') IS NOT NULL")
    for row in rows:
        result = dict(row)
        a, b = (entities[result[k]] for k in ('left_id', 'right_id'))
        if not a['eligible'] or not b['eligible']:
            continue
        evidence = json.loads(result.pop('evidence_json'))
        originals[(result['left_id'], result['right_id'])] = (result['class'], dict(evidence))
        # Older imports lack the pre-ambiguity class. Decode normalized source
        # evidence once per needed observation, preserving rejection history.
        if evidence.get('near_tie_review') and not evidence.get('near_tie_original_class'):
            for entity in (a, b):
                if entity['id'] not in normalized:
                    normalized[entity['id']] = json.loads(entity['normalized_json'])
            refreshed = score_candidate(normalized[a['id']], normalized[b['id']],
                                        evidence.get('anchor'), evidence.get('collection_context'))
            result['class'] = refreshed['class'] if 'previously_rejected' not in evidence.get('conflicts', []) else 'CONFLICT'
        result['evidence'] = evidence
        results.append(result)
    annotate_near_ties(results, {sid:e['recording_id'] for sid,e in entities.items()},
                       {sid:e['service'] for sid,e in entities.items()})
    changed = 0
    for result in results:
        old_class, old_evidence = originals[(result['left_id'], result['right_id'])]
        if old_class != result['class'] or old_evidence != result['evidence']:
            db.execute('UPDATE candidates SET class=?,evidence_json=? WHERE left_id=? AND right_id=?',
                       (result['class'], json.dumps(result['evidence'], ensure_ascii=False, sort_keys=True),
                        result['left_id'], result['right_id']))
            changed += 1
    return changed


def refresh_entity_statuses(db):
    """Refresh current display badges; preserve base evidence and historical rows."""
    from .identity_library import current_local_predicate
    eligible = ("(e.service!='local' OR (" + current_local_predicate() + ")) AND "
                "COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired' AND "
                "COALESCE(json_type(e.metadata_json,'$.catalog_current'),'')!='false'")
    entities = {r['id']:dict(r) for r in db.execute(
        'SELECT e.id,e.recording_id,e.status FROM entities e WHERE ' + eligible)}
    component_sizes = Counter(row['recording_id'] for row in entities.values())
    ranking = {'ACCEPTED':6,'HIGH_CONFIDENCE':5,'PROBABLE':4,'AMBIGUOUS':3,'CONFLICT':2,'NO_CANDIDATE':1}
    desired = {sid:'ACCEPTED' if component_sizes[row['recording_id']]>1 else 'NO_CANDIDATE'
               for sid,row in entities.items()}
    rejected = {frozenset(row) for row in db.execute(
        "SELECT left_id,right_id FROM canonical_blocks WHERE reason IN ('human_rejection','historical_rejection')")}
    revoked, active = set(), set()
    for row in db.execute('SELECT left_id,right_id,revoked_at FROM identity_acceptances'):
        (revoked if row['revoked_at'] else active).add(frozenset((row['left_id'],row['right_id'])))
    revoked -= active
    for row in db.execute('SELECT left_id,right_id,class FROM candidates'):
        left,right = row['left_id'],row['right_id']
        if left not in entities or right not in entities:
            continue
        pair = frozenset((left,right)); category = row['class']
        if pair in rejected:
            category = 'CONFLICT'
        elif pair in revoked and category in {'ACCEPTED','HIGH_CONFIDENCE'}:
            category = 'AMBIGUOUS'
        elif category == 'ACCEPTED':
            # Scoring can propose deterministic identity without committing it.
            # Only the current accepted component can claim the accepted badge.
            category = 'HIGH_CONFIDENCE'
        for sid in (left,right):
            if ranking.get(category,0)>ranking[desired[sid]]:
                desired[sid] = category
    changed = 0
    for sid,status in desired.items():
        if status != entities[sid]['status']:
            db.execute('UPDATE entities SET status=? WHERE id=?',(status,sid))
            changed += 1
    return changed
