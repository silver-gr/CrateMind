"""DB-only preferred metadata. Source observations and audio are never modified."""
from __future__ import annotations
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from .metadata_reader import display_title_hints, infer_tags_from_filename, looks_like_label_name
from .identity_matching import text_key, version_terms, PROMO

ROLES = {'primary', 'collaborator', 'featured', 'remixer'}


def credits(artist, title, artist_uris=''):
    """Structured provider delimiters are authoritative; avoid splitting band names on 'and'."""
    remix = re.search(r'(?:[\[(]|\s-\s)([^\]()]+?)\s+(?:remix|rmx)\b', title or '', re.I)
    remixer = remix.group(1).strip() if remix else ''
    feature = re.split(r'\s+(?:feat\.?|ft\.?|featuring)\s+', artist or '', flags=re.I, maxsplit=1)
    names = (feature[0].split(';') if ';' in feature[0] else re.split(r'\s+(?:&|vs\.?)\s+', feature[0]))
    uris = re.findall(r'spotify:artist:[A-Za-z0-9]+', artist_uris or '')
    if len(uris) == 1:
        names = [feature[0]]
    elif len(uris) > 1:
        structured_names = re.split(r';\s*|,\s+', feature[0])
        if len(structured_names) == len(uris):
            names = structured_names
        else:
            names = [feature[0]]
    remixer_keys = {text_key(n) for n in re.split(r'\s+&\s+|;|,\s+', remixer)} if remixer else set()
    rows = []
    for name in names:
        name = name.strip()
        if not name:
            continue
        role = 'remixer' if text_key(name) in remixer_keys else ('primary' if not any(r['role']=='primary' for r in rows) else 'collaborator')
        rows.append({'name': name, 'role': role, 'provider_uri': uris[len(rows)] if len(uris) == len(names) else None})
    if len(feature) > 1:
        rows += [{'name': n.strip(), 'role': 'featured', 'provider_uri': None} for n in re.split(r'\s+&\s+|;', feature[1]) if n.strip()]
    title_feature = re.search(r'\b(?:feat\.?|ft\.?|featuring)\s+([^\]()]+)', title or '', re.I)
    if title_feature:
        for name in re.split(r'\s+&\s+|;', title_feature.group(1)):
            existing = next((r for r in rows if text_key(r['name']) == text_key(name)), None)
            if existing:
                existing['role'] = 'featured'
            else:
                rows.append({'name': name.strip(), 'role': 'featured', 'provider_uri': None})
    if remixer:
        for name in re.split(r'\s+&\s+|;', remixer):
            if text_key(name) not in {text_key(r['name']) for r in rows}:
                rows.append({'name': name, 'role': 'remixer', 'provider_uri': None})
    # Credit order is display order, not evidence of lead ownership.
    base = [r for r in rows if r['role'] in {'primary', 'collaborator'}]
    if len(base) > 1:
        for r in base:r['role'] = 'collaborator'
    return rows


def display_credit(rows):
    base = ' & '.join(r['name'] for r in rows if r['role'] in {'primary', 'collaborator'})
    featured = ' & '.join(r['name'] for r in rows if r['role'] == 'featured')
    return base + (' feat. ' + featured if featured else '')


def proposal(entity):
    n = json.loads(entity['normalized_json']); raw = json.loads(entity['metadata_json'])
    artist = n.get('artist') or ''  # SoundCloud uploader is deliberately not a fallback.
    title = entity['title'] or ''
    parsed = infer_tags_from_filename(Path(title + '.mp3'))
    patterns = []
    if entity['service'] != 'spotify' and parsed.get('artist') and parsed.get('title'):
        patterns.append('artist_inside_title')
        if looks_like_label_name(artist or n.get('uploader')):
            patterns.append('label_as_artist')
        if text_key(artist) == text_key(parsed['artist']):
            patterns.append('duplicated_artist_in_title')
        artist, title = parsed['artist'], parsed['title']
    if PROMO.search(entity['title'] or ''):
        patterns.append('promotional_noise')
    if re.search(r'\b\d{2,3}\s*bpm\b|^[\[(]\d{2,3}[\])]', entity['title'] or '', re.I):
        patterns.append('bpm_annotation')
    if re.match(r'^\d{1,4}[.) ]', entity['title'] or ''):
        patterns.append('leading_track_number')
    if re.search(r'\b[A-Z]{2,8}[-_]?\d{2,6}\b', entity['title'] or ''):
        patterns.append('catalogue_annotation')
    if ';' in artist or ' & ' in artist:
        patterns.append('collaboration_credit')
    # Existing parser may clean version parentheses. Never lose semantic versions.
    if set(version_terms(title)) != set(version_terms(entity['title'])):
        title = entity['title'] or title
        if parsed.get('artist'):
            title = re.sub(r'^.*?\s[-–—]\s', '', title, count=1)
    if entity['service'] != 'spotify' and not parsed.get('artist') and parsed.get('title') and not version_terms(entity['title']):
        title = parsed['title']
    title, _ = display_title_hints(title)
    rows = credits(artist, title, raw.get('artist_uris', ''))
    if any(r['role'] == 'remixer' for r in rows):
        patterns.append('remixer_credit')
    return {'title': title, 'artist': display_credit(rows), 'credits': rows,
            'version': ', '.join(version_terms(title)), 'release': n.get('album') or raw.get('album'),
            'source_id': entity['id'], 'patterns': patterns,
            'credit_ambiguity': bool(raw.get('artist_uris') and len(re.findall(r'spotify:artist:[A-Za-z0-9]+',raw['artist_uris'])) != sum(bool(r.get('provider_uri')) for r in rows))}


def corroborates(a, b):
    return bool(a['artist'] and a['title'] and text_key(a['artist']) == text_key(b['artist'])
                and text_key(a['title']) == text_key(b['title']) and a['version'] == b['version'])


def derive(groups):
    """Measure parser proposals against independent, accepted provider observations first."""
    report = defaultdict(lambda: {'occurrences': 0, 'corroborated': 0, 'contradicted': 0, 'examples': []})
    prepared = {}
    for rid, entities in groups.items():
        proposals = [(e, proposal(e)) for e in entities]
        prepared[rid] = proposals
        spotify = [p for e,p in proposals if e['service'] == 'spotify']
        for e,p in proposals:
            if e['service'] == 'spotify':
                continue
            for pattern in p['patterns']:
                r = report[pattern]; r['occurrences'] += 1
                if spotify:
                    r['corroborated' if any(corroborates(p,s) for s in spotify) else 'contradicted'] += 1
                if len(r['examples']) < 5:
                    r['examples'].append({'id': e['id'], 'before': {'artist':e['artist'],'title':e['title']}, 'proposal':p, 'provider_corroboration': bool(spotify and any(corroborates(p,s) for s in spotify))})
    for pattern,r in report.items():
        tested = r['corroborated'] + r['contradicted']
        r['measured_precision'] = r['corroborated']/tested if tested else None
        r['tested'] = tested
        # An observational agreement rate is not a human-labelled generalization estimate.
        r['measurement'] = 'exact normalized agreement with accepted Spotify identity; uncorroborated rows excluded'
        r['enabled'] = tested >= 10 and r['measured_precision'] >= .98
        r['proposed_action'] = 'apply corroborated rows; review other rows' if r['corroborated'] else 'review only'
    result = {}
    for rid, pairs in prepared.items():
        spotify = [(e,p) for e,p in pairs if e['service']=='spotify' and p['artist']]
        local = [(e,p) for e,p in pairs if e['service']=='local']
        preferred = (spotify or local or pairs)[0]
        e,p = preferred
        # Provider catalogue editions can disagree; surface rather than silently choose.
        disagreements = any(not corroborates(p,s) for _,s in spotify)
        validated_patterns = sorted({pattern for se,sp in pairs if se['service']!='spotify' and spotify and any(corroborates(sp,v) for _,v in spotify) for pattern in sp['patterns']})
        auto = bool(spotify and not disagreements and not p['credit_ambiguity'] and any(c['role'] in {'primary','collaborator'} for c in p['credits']))
        if not spotify:
            auto = bool(p['artist'] and not p['patterns'] and p['title'] == e['title'] and p['artist'] == e['artist'])
        local_e = local[0][0] if local else None
        fallback = {'artist':local_e['artist'], 'title':local_e['title']} if local_e else {'artist':e['artist'] if e['service']!='soundcloud' else '', 'title':e['title']}
        result[rid] = {'proposal':p, 'state':'derived' if auto else 'review',
                       'artist':p['artist'] if auto else fallback['artist'], 'title':p['title'] if auto else fallback['title'],
                       'patterns':sorted({v for _,v in pairs for v in v['patterns']}),
                       'validated_patterns':validated_patterns, 'provider_disagreement':disagreements,
                       'observations':[{'id':se['id'],'service':se['service'],'artist':se['artist'],'title':se['title'],'proposal':sp} for se,sp in pairs]}
    return result, dict(report)
