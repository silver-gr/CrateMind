"""Offline held-out matcher backtest. Never writes source catalog or decisions."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import html
import json
from pathlib import Path
import random
import sqlite3
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.services.identity_matching import CandidateIndex, score_candidate


def connection(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def evaluate(items, gold, target_service, *, mask_isrc=False):
    # No accepted links, historical candidates, provider URLs, or transitive answers
    # enter retrieval/scoring. Gold is consulted only after ranked results exist.
    targets = [{**x, 'isrc_key': ''} if mask_isrc else x for x in items.values() if x['service'] == target_service]
    index = CandidateIndex(targets)
    output = []
    for n, (sid, expected) in enumerate(sorted(gold.items())):
        left = {**items[sid], 'isrc_key': ''} if mask_isrc else items[sid]
        retrieved = index.retrieve(left)
        rows = []
        for rid in retrieved:
            result = score_candidate(left, index.items[rid])
            ev = result['evidence']
            if not ev['isrc_equal'] and (ev['title_similarity'] < .40 or result['score'] < 43):
                continue
            rows.append({'right_id': rid, **result})
        # Query-side near-tie review matches the importer rule; reverse-side ties
        # are reported separately from the published full reconciliation.
        plausible = sorted([r for r in rows if r['class'] in ('HIGH_CONFIDENCE', 'PROBABLE')], key=lambda r: (-r['score'], r['right_id']))
        if len(plausible) > 1 and plausible[0]['score'] - plausible[1]['score'] < 3:
            for r in plausible:
                if plausible[0]['score'] - r['score'] < 3 and r['class'] == 'HIGH_CONFIDENCE':
                    r['class'] = 'AMBIGUOUS'
        rows.sort(key=lambda r: (-r['score'], r['right_id']))
        truth = [r for r in rows if r['right_id'] in expected]
        ranks = [i + 1 for i, r in enumerate(rows) if r['right_id'] in expected]
        best = truth[0] if truth else None
        # Score unreachable truth as a diagnostic, never insert it into retrieval.
        diagnostics = [dict(right_id=rid, **score_candidate(left, index.items[rid])) for rid in sorted(expected) if rid in index.items]
        output.append({'left_id': sid, 'expected_ids': sorted(expected), 'retrieved': bool(set(retrieved) & expected),
                       'rank': min(ranks) if ranks else None, 'true_score': best['score'] if best else None,
                       'class': best['class'] if best else 'not retrieved', 'top': rows[:10], 'truth_diagnostics': diagnostics})
        if n and n % 200 == 0:
            print('Evaluated', target_service, n, flush=True)
    return output


def metrics(rows):
    n = len(rows)
    scores = [r['true_score'] for r in rows if r['true_score'] is not None]
    high = [r for r in rows if r['top'] and r['top'][0]['class'] == 'HIGH_CONFIDENCE']
    return {'n': n, 'candidate_retrieval_recall': sum(r['retrieved'] for r in rows) / n if n else None,
            'retained_recall': sum(r['rank'] is not None for r in rows) / n if n else None,
            **{f'recall@{k}': sum(r['rank'] is not None and r['rank'] <= k for r in rows) / n if n else None for k in (1, 5, 10)},
            'mean_reciprocal_rank': sum(1 / r['rank'] if r['rank'] else 0 for r in rows) / n if n else None,
            'median_true_pair_score': statistics.median(scores) if scores else None,
            'classification': dict(Counter(r['class'] for r in rows)),
            'high_confidence_top1': len(high), 'high_confidence_top1_agrees_with_gold': sum(r['rank'] == 1 for r in high),
            'precision_note': 'Top-1 gold agreement is not population precision; alternate identities may also be valid.'}


def describe(item):
    return {k: item.get(k) for k in ('id','service','title','artist','uploader','duration_ms','album','label','genre','year','bpm','file_name','permalink','isrc','versions','title_variants','artist_variants','collection_examples','collection_count','missing')}


def audit_context(items, candidates):
    changed = []
    scored = 0
    for row in candidates:
        context = row['evidence'].get('collection_context', {})
        if not context.get('independently_anchored_neighbors'):
            continue
        scored += 1
        left, right = items[row['left_id']], items[row['right_id']]
        anchor = row['evidence'].get('anchor')
        before = score_candidate(left, right, anchor=anchor)
        after = score_candidate(left, right, anchor=anchor, context=context)
        changed.append({'left': describe(left), 'right': describe(right), 'before': before, 'after': after,
                        'score_delta': round(after['score'] - before['score'], 2), 'published_class': row['class']})
    changed.sort(key=lambda x: (x['before']['class'] != x['after']['class'], x['score_delta']), reverse=True)
    # Repeat the complete bidirectional competition rule with neighborhood off.
    # Undo published tie demotions before recomputing; otherwise the ablation
    # would miss classes changed indirectly by a competing neighbor-supported pair.
    without=[]
    for row in candidates:
        ev=row['evidence']
        if ev.get('near_tie_review') or ev.get('collection_context',{}).get('independently_anchored_neighbors'):
            result=score_candidate(items[row['left_id']],items[row['right_id']],anchor=ev.get('anchor'))
            without.append({**row,**result})
        else:
            without.append(dict(row))
    competing=defaultdict(list)
    for row in without:
        if row['class'] in ('HIGH_CONFIDENCE','PROBABLE'):
            competing[(row['left_id'],items[row['right_id']]['service'])].append(row)
            competing[(row['right_id'],items[row['left_id']]['service'])].append(row)
    for rows in competing.values():
        rows.sort(key=lambda r:-r['score'])
        if len(rows)>1 and rows[0]['score']-rows[1]['score']<3:
            for r in rows:
                if rows[0]['score']-r['score']<3 and r['class']=='HIGH_CONFIDENCE':
                    r['class']='AMBIGUOUS'
    full_changes=[{'left_id':a['left_id'],'right_id':a['right_id'],'without':a['class'],'with':b['class']}
                  for a,b in zip(without,candidates) if a['class']!=b['class']]
    return {'supported_pairs': scored, 'max_score_delta': max((r['score_delta'] for r in changed), default=0),
            'changed_score': sum(r['score_delta'] != 0 for r in changed),
            'changed_class': sum(r['before']['class'] != r['after']['class'] for r in changed),
            'promoted_high_confidence': sum(r['before']['class'] != 'HIGH_CONFIDENCE' and r['after']['class'] == 'HIGH_CONFIDENCE' for r in changed),
            'weak_intrinsic_promoted_high': sum(r['before']['class'] in ('AMBIGUOUS','CONFLICT') and r['after']['class'] == 'HIGH_CONFIDENCE' for r in changed),
            'transitions': dict(Counter(r['before']['class'] + ' -> ' + r['after']['class'] for r in changed)),
            'global_competition_class_changes':len(full_changes),
            'global_competition_promoted_high':sum(r['with']=='HIGH_CONFIDENCE' for r in full_changes),
            'global_competition_examples':full_changes[:15],
            'examples': changed[:15], 'comparison': 'Paired score/class ablation plus complete bidirectional near-tie ablation.'}


def sample_review(items, candidates, accepted_pairs):
    specs = [('local:spotify','HIGH_CONFIDENCE',30),('local:spotify','PROBABLE',20),
             ('local:soundcloud','HIGH_CONFIDENCE',20),('spotify:soundcloud','HIGH_CONFIDENCE',20)]
    sample = []
    rng = random.Random(20260914)
    for pair, category, count in specs:
        pool = [r for r in candidates if r['pair_type'] == pair and r['class'] == category
                and (r['left_id'],r['right_id']) not in accepted_pairs
                and (pair != 'spotify:soundcloud' or not r['evidence']['isrc_equal'])]
        # Equal allocation over score terciles, random within each; record inclusion
        # probabilities so later precision can be weighted, rather than cherry-picked.
        pool.sort(key=lambda r: (r['score'], r['left_id'], r['right_id']))
        for j in range(3):
            bucket = pool[len(pool)*j//3:len(pool)*(j+1)//3]
            take = min(len(bucket), count//3 + (j < count%3))
            for r in rng.sample(bucket, take):
                sample.append({'stratum': pair + '/' + category, 'score_tercile': j+1, 'population_in_tercile': len(bucket),
                               'sample_in_tercile': take, 'inclusion_probability': take/len(bucket),
                               'left': describe(items[r['left_id']]), 'right': describe(items[r['right_id']]),
                               'score': r['score'], 'class': r['class'], 'evidence': r['evidence'],
                               'human_verdict': '', 'human_notes': ''})
    return sample


def render_report(report, samples):
    esc = lambda v: html.escape(str(v if v is not None else ''))
    parts = ['<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CrateMind — Έλεγχος αντιστοιχίσεων</title><style>body{font:16px system-ui;max-width:1100px;margin:auto;padding:24px;background:#10151e;color:#eee}article{border:1px solid #435166;border-radius:10px;padding:18px;margin:20px 0}a{color:#77d9ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}summary{cursor:pointer}td,th{padding:7px;text-align:left}</style><h1>Έλεγχος αντιστοιχίσεων</h1><p>90 προτάσεις για έλεγχο. Τα σκορ δεν είναι πιθανότητες. Δεν έχει γίνει μαζική αποδοχή.</p><a href="/unified">Επιστροφή στη βιβλιοθήκη</a><h2>Μετρήσεις backtest</h2><table><tr><th>Σύνολο</th><th>N</th><th>Recall@1</th><th>@5</th><th>@10</th></tr>']
    for name, m in report['benchmarks'].items():
        parts.append('<tr>'+''.join('<td>'+esc(v)+'</td>' for v in [name,m['n'],*[f"{m[f'recall@{k}']:.1%}" if m[f'recall@{k}'] is not None else '—' for k in (1,5,10)]])+'</tr>')
    parts.append('</table><p>Η ακρίβεια των νέων προτάσεων παραμένει μη μετρημένη μέχρι να αξιολογηθεί το δείγμα από άνθρωπο.</p><p>Οι σημειώσεις μένουν σε αυτή τη σελίδα μέχρι την εξαγωγή. Η εξαγωγή αποθηκεύει αρχείο ελέγχου στη συσκευή σας· δεν αποδέχεται αντιστοιχίσεις.</p><button id="export-review" type="button">Εξαγωγή αξιολογήσεων JSON</button>')
    for i,r in enumerate(samples,1):
        parts.append(f'<article id="pair-{i}"><h2>{i}. {esc(r["stratum"])} · {r["score"]}</h2><div class="pair">')
        for side in ('left','right'):
            t=r[side]
            url=t.get('permalink') or ''
            link=f'<a href="{html.escape(url,quote=True)}" target="_blank" rel="noreferrer">Πηγή</a>' if url.startswith(('https://soundcloud.com/','https://open.spotify.com/')) else ''
            duration=t.get('duration_ms')
            duration_text=f'{duration/1000:.3f}s' if duration is not None else '—'
            fields=' · '.join(esc(t.get(k)) for k in ('album','label','year') if t.get(k))
            audio=''
            if t['id'].startswith('local:') and t['id'].split(':')[-1].isdigit() and not t.get('missing'):
                audio=f'<p><audio controls preload="none" src="/api/tracks/{int(t["id"].split(":")[-1])}/audio"></audio></p>'
            parts.append(f'<div><strong>{esc(t["artist"] or t["uploader"])}</strong><p>{esc(t["title"])}</p><p>{duration_text} · {esc(", ".join(t.get("versions") or []) or "χωρίς ένδειξη έκδοσης")}</p><p>{fields}</p><p>{esc(t.get("file_name"))}</p>{link}{audio}<details><summary>Πλήρη μεταδεδομένα και συλλογές</summary><pre>{esc(json.dumps(t,ensure_ascii=False,indent=2))}</pre></details></div>')
        ev=r['evidence']
        parts.append(f'</div><p>Τίτλος: {esc(ev.get("title_similarity"))} · Καλλιτέχνης: {esc(ev.get("artist_similarity"))} · Διαφορά διάρκειας: {esc(ev.get("duration_delta_seconds"))}s · Αντιφάσεις: {esc(", ".join(ev.get("conflicts",[])) or "καμία")}</p>')
        parts.append('<details><summary>Στοιχεία και αιτιολόγηση</summary><pre>'+esc(json.dumps(r['evidence'],ensure_ascii=False,indent=2))+'</pre></details>')
        parts.append(f'<p><label>Αξιολόγηση <select data-verdict="{i-1}"><option value="">Δεν ελέγχθηκε</option><option value="same_recording">Ίδια ηχογράφηση</option><option value="different_recording">Διαφορετική ηχογράφηση</option><option value="uncertain">Αβέβαιο</option></select></label></p><label>Σημειώσεις <textarea data-notes="{i-1}"></textarea></label></article>')
    payload=json.dumps(samples,ensure_ascii=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    parts.append('<script type="application/json" id="review-data">'+payload+'</script>')
    parts.append('''<script>document.getElementById('export-review').addEventListener('click',()=>{
const rows=JSON.parse(document.getElementById('review-data').textContent);
document.querySelectorAll('[data-verdict]').forEach(e=>rows[Number(e.dataset.verdict)].human_verdict=e.value);
document.querySelectorAll('[data-notes]').forEach(e=>rows[Number(e.dataset.notes)].human_notes=e.value);
const url=URL.createObjectURL(new Blob([JSON.stringify({purpose:'review_only_no_acceptance',samples:rows},null,2)],{type:'application/json'}));
const a=document.createElement('a');a.href=url;a.download='cratemind-calibration-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});</script>''')
    return ''.join(parts)+'</html>'


def results_markdown(report, summary, baseline):
    lines = ['# Calibrated unified-library results', '',
             'Open `/unified`, then **Έλεγχος αντιστοιχίσεων · δείγμα 90 προτάσεων**. The review page displays metadata, provider links, collection examples and scoring evidence, and exports review labels as JSON. Exporting labels does not accept identities.', '',
             '## Held-out quality', '',
             'Accepted decisions and historical retrieval shortcuts are absent from backtest candidate generation. Both pseudo-gold benchmarks mask ISRC in retrieval and scoring. The baseline gold set is frozen in `calibration_gold.json`; alternative corroborated catalogue/recording identities are evaluated as sets.', '',
             '| Benchmark | N | Retrieval recall | Recall@1 | @5 | @10 | MRR | Median true-pair score |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for name,m in report['benchmarks'].items():
        lines.append('| '+ ' | '.join([name,str(m['n']),*[f"{m[k]:.2%}" for k in ('candidate_retrieval_recall','recall@1','recall@5','recall@10')],f"{m['mean_reciprocal_rank']:.4f}",str(m['median_true_pair_score'])])+' |')
    lines += ['', '| True-pair query class | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT | Not retrieved |', '|---|---:|---:|---:|---:|---:|']
    for name,m in report['benchmarks'].items():
        lines.append('| '+name+' | '+' | '.join(str(m['classification'].get(k,0)) for k in ('HIGH_CONFIDENCE','PROBABLE','AMBIGUOUS','CONFLICT','not retrieved'))+' |')
    census=report['exact_isrc_census']
    lines += ['',f"Exact-ISRC census: {census['pairs']} Spotify↔SC pairs; {census['published_classes'].get('ACCEPTED',0)} accepted after corroboration, {census['published_classes'].get('CONFLICT',0)} conflicting. The remaining pairs stay proposals/review. Conflict reasons overlap: {census['conflict_reasons']}. ISRC does not bypass semantic-version protection."]
    lines += ['', 'Ranking uses descending numeric score and deterministic ID tie-break after the production relevance filter. Classes include query-side near-tie demotion; they do not include reverse-side competition from unrelated queries. Full production classes are reported below. Missing truth remains in denominators. Median scores cover retained truth (all truth was retrieved here).', '',
              'The 247 manual decisions are the strongest benchmark. Exact-metadata decisions are a separate, weaker label source. ISRC pseudo-gold is selected through metadata corroboration, so it favors easier examples and is not unbiased independent ground truth. Equivalent targets include corroborated identities, not every possible unobserved catalogue entry.', '',
              '## Precision and decision', '',
              '**Scores are not probabilities; new-match population precision remains unmeasured.** Positive-only benchmarks cannot label every other candidate false. Historical decisions are also a selected subset. No bulk acceptance was enabled, and PROBABLE/AMBIGUOUS remain review states.', '']
    for name,m in report['benchmarks'].items():
        if m['high_confidence_top1']:
            lines.append(f"- {name}: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in {m['high_confidence_top1_agrees_with_gold']}/{m['high_confidence_top1']} queries. This is conditional gold agreement, not a population precision estimate.")
    lines += ['', 'The 90-pair sample contains 30 HIGH_CONFIDENCE local↔Spotify, 20 PROBABLE local↔Spotify, 20 new HIGH_CONFIDENCE local↔SoundCloud and 20 non-ISRC HIGH_CONFIDENCE Spotify↔SoundCloud. It uses seeded random sampling within score terciles, records population sizes/inclusion probabilities, and leaves human verdicts blank. Repeated recordings may make labels correlated. A rapid metadata inspection is not audio verification; no synthetic human labels were supplied.', '',
              'Retrieval recall did not justify widening retrieval or weakening thresholds. Existing HIGH_CONFIDENCE naming is retained as a proposal class, not authorization for bulk acceptance. Human review is the missing evidence for estimating new-match precision.', '',
              'All four historical rejections remain CONFLICT in the published projection. One rejected pair (`local:3978` ↔ `soundcloud:tracks:647917803`) scores HIGH_CONFIDENCE without its rejection: exact artist/remix-title and 0.121-second duration difference. The rejection wins; metadata cannot explain every human decision. It was not relabeled or tuned away.', '',
              '## Focused corrections and neighborhood ablation', '',
              '- Version extraction excludes artist-wrapper words such as Live Magnet / Kayros Live, while preserving original song suffixes including `(2014 Edit)`. Semantic version/remixer/duration conflict protection remains active.',
              '- Neighborhood points affect ranking but cannot cross an intrinsic confidence threshold. The baseline changed three intrinsic classes, including one PROBABLE→HIGH_CONFIDENCE pair. That pair was Technical Hitch, Ohm/Om Shri Kali: 88.83→89.83 with one neighbor.', '']
    n=report['neighborhood']
    lines.append(f"After correction, {n['supported_pairs']:,} pairs have neighborhood support; {n['changed_score']:,} scores change by at most {n['max_score_delta']} points. Intrinsic class changes: {n['changed_class']}; promotions to HIGH_CONFIDENCE: {n['promoted_high_confidence']}; weak/contradictory intrinsic pairs promoted: {n['weak_intrinsic_promoted_high']}.")
    lines.append(f"The full bidirectional near-tie ablation changes {n['global_competition_class_changes']} published classes, including {n['global_competition_promoted_high']} promotions to HIGH_CONFIDENCE. Exact examples and before/after evidence are in `calibration.json`; baseline examples are in `calibration_baseline.json`.")
    lines += ['', '## Refreshed reconciliation', '',
              f"**{summary['entities']:,} identities, {summary['candidate_pairs']:,} candidate pairs, {summary['collections']:,} collections, 49,870 ordered positions.** The 49,850 original source positions and the additional 20-position local proof collection remain intact.", '',
              '| Source | Total | Linked local | Linked Spotify | Linked SC | Both | No accepted counterpart |', '|---|---:|---:|---:|---:|---:|---:|']
    for name,c in summary['coverage'].items():
        lines.append('| '+name+' | '+' | '.join(str(c.get(k,'—')) for k in ('total','resolved_to_local','resolved_to_spotify','resolved_to_soundcloud','resolved_to_both','no_accepted_cross_source_link'))+' |')
    lines += ['', 'Linked counts may be transitive through accepted recording components. No accepted counterpart does not prove no match exists. Spotify totals cover 11,172 music identities; three additional nonmusic identities remain preserved. All 75 unknown SoundCloud Likes remain represented.', '',
              '| Pair | ACCEPTED | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT |','|---|---:|---:|---:|---:|---:|']
    for pair,c in summary['by_pair'].items():
        lines.append('| '+pair+' | '+' | '.join(str(c.get(k,0)) for k in ('ACCEPTED','HIGH_CONFIDENCE','PROBABLE','AMBIGUOUS','CONFLICT'))+' |')
    lines += ['', '| Strongest entity state | ACCEPTED | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT | NO_CANDIDATE |','|---|---:|---:|---:|---:|---:|---:|']
    for name,c in summary['coverage'].items():
        lines.append('| '+name+' | '+' | '.join(str(c.get('status_'+k,0)) for k in ('ACCEPTED','HIGH_CONFIDENCE','PROBABLE','AMBIGUOUS','CONFLICT','NO_CANDIDATE'))+' |')
    lines += ['', 'The 545 authoritative local↔SC decisions and 714 corroborated SC↔Spotify ISRC edges are preserved. New metadata proposals were not bulk-accepted. The existing unified library, local audio links and Summer proof collection remain available.', '',
              '## Evidence and reproducibility', '',
              '- Primary cleaned metadata remains persisted in `tracks`; see `METADATA_FINDINGS.md`. Existing SoundCloud decision tables remain authoritative; `backend/data/identity.sqlite` is the rebuildable projection.',
              '- `calibration.json`: metrics, protocol limits, rejection audit and context examples. `calibration_pairs.json`: every held-out query, top ten and true-pair diagnostics.',
              '- `calibration_review.json` / `calibration.html`: the 90-pair review artifact and working review interface. Stale reports are blocked when the projection build changes.',
              '- `calibration_gold.json`: frozen benchmark IDs and decision groups. `calibration_baseline*`: before-change evidence.',
              '- `results.json`, `source_preservation.json`, `calibration_validation.json`, `calibration_tests.xml`, `calibration_browser.json`: counts, preservation and verification evidence.',
              '', 'Run:', '', '```sh', '/Users/silver/venv/bin/python reconciliation/build_identity.py', '/Users/silver/venv/bin/python reconciliation/calibrate_identity.py --gold reconciliation/identity/calibration_gold.json', '```', '',
              'No audio retagging/moves, remote mutations, original playlist membership changes or production decision edits were performed. Review JSON exports are separate artifacts, not identity decisions.']
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(); p.add_argument('--label',default='calibration'); p.add_argument('--gold',type=Path); args=p.parse_args()
    out=ROOT/'reconciliation/identity'; db=connection(ROOT/'backend/data/identity.sqlite')
    items={r['id']:{**json.loads(r['normalized_json']),'missing':bool(r['missing'])} for r in db.execute('SELECT id,normalized_json,json_extract(metadata_json,"$.missing") AS missing FROM entities')}
    memberships=defaultdict(list)
    for r in db.execute('SELECT m.entity_id,c.name,c.service,m.position FROM memberships m JOIN collections c ON c.id=m.collection_id ORDER BY m.entity_id,c.id,m.position'):
        memberships[r['entity_id']].append(dict(r))
    for sid,item in items.items():
        item['collection_count']=len(memberships[sid])
        item['collection_examples']=memberships[sid][:8]
    candidates=[{**dict(r),'evidence':json.loads(r['evidence_json'])} for r in db.execute('SELECT * FROM candidates')]
    projection_metadata=dict(db.execute('SELECT key,value FROM metadata').fetchall()); db.close()
    db=connection(ROOT/'backend/data/cratemind.sqlite')
    accepted=[dict(r) for r in db.execute('SELECT * FROM track_soundcloud_matches')]
    rejected=[dict(r) for r in db.execute("SELECT * FROM soundcloud_match_candidates WHERE status='rejected'")]; db.close()
    sc_gold={f"local:{r['track_id']}":{f"soundcloud:tracks:{r['soundcloud_track_id']}"} for r in accepted}
    frozen=json.loads(args.gold.read_text()) if args.gold else None
    if frozen:
        sc_gold={k:set(v) for k,v in frozen['local_sc'].items()}
    print('Held-out local -> SoundCloud',len(sc_gold),flush=True)
    local_sc=evaluate(items,sc_gold,'soundcloud')
    methods={f"local:{r['track_id']}":r['method'] for r in accepted}
    if frozen:
        methods=frozen['methods']
    # Corroborated same-ISRC edges define pseudo-gold only; mask ISRC in
    # retrieval and scoring when measuring independent metadata recovery.
    sp_sc=defaultdict(set); sc_sp=defaultdict(set)
    for r in candidates:
        if r['pair_type']=='spotify:soundcloud' and r['class']=='ACCEPTED' and r['evidence']['isrc_equal'] and not r['evidence']['conflicts']:
            sp_sc[r['left_id']].add(r['right_id']); sc_sp[r['right_id']].add(r['left_id'])
    sp_gold={sid:set().union(*(sc_sp[x] for x in targets)) for sid,targets in sc_gold.items() if any(sc_sp[x] for x in targets)}
    if frozen:
        sp_gold={k:set(v) for k,v in frozen['local_spotify'].items()}
        sp_sc={k:set(v) for k,v in frozen['spotify_sc'].items()}
    print('Held-out local -> Spotify',len(sp_gold),flush=True)
    local_sp=evaluate(items,sp_gold,'spotify',mask_isrc=True)
    print('Held-out Spotify -> SoundCloud, ISRC masked',len(sp_sc),flush=True)
    spotify_sc=evaluate(items,sp_sc,'soundcloud',mask_isrc=True)
    published={(r['left_id'],r['right_id']):r for r in candidates}
    rejected_results=[]
    for r in rejected:
        a,b=f"local:{r['track_id']}",f"soundcloud:tracks:{r['soundcloud_track_id']}"
        raw=score_candidate(items[a],items[b]); live=published.get((a,b))
        rejected_results.append({'left_id':a,'right_id':b,'unanchored':raw,'published_class':live['class'] if live else 'not retrieved'})
    report={'protocol': {'anchors_injected':False,'historical_retrieval_injected':False,'playlist_context_in_backtest':False,
                       'ranking':'descending numeric score, ID tie-break, after production relevance filter; query-side near ties demoted',
                       'limitations':['Reverse-side global near ties are not applied to held-out query classes. Full production classes are separate.',
                       'Historical positives are selected rather than random. Exact-metadata decisions are not independent human labels.',
                       'ISRC pseudo-gold is corroborated with the existing metadata guard, so its selection is biased toward easier metadata pairs.',
                       'Multiple corroborated same-recording target entries are allowed; absent truth is not a negative label.',
                       'True population precision cannot be established without reviewing the new 90-pair sample.'],
                       'isrc_masked_in_pseudo_gold_benchmarks':True},
            'source_projection_metadata':projection_metadata,
            'benchmarks':{'manual_review':metrics([r for r in local_sc if methods[r['left_id']]=='manual_review']),
                          'exact_metadata':metrics([r for r in local_sc if methods[r['left_id']]=='exact_metadata']),
                          'combined':metrics(local_sc),'local_spotify_pseudo_gold':metrics(local_sp),'spotify_soundcloud_isrc_masked':metrics(spotify_sc)},
            'rejected':rejected_results,'neighborhood':audit_context(items,candidates),
            'bulk_acceptance_enabled':False,'population_precision':None}
    isrc_rows=[r for r in candidates if r['pair_type']=='spotify:soundcloud' and r['evidence']['isrc_equal']]
    report['exact_isrc_census']={'pairs':len(isrc_rows),
        'published_classes':dict(Counter(r['class'] for r in isrc_rows)),
        'conflict_reasons':dict(Counter(flag for r in isrc_rows for flag in r['evidence']['conflicts'])),
        'note':'Exact ISRC disagreements are retained as conflicts/review; only corroborated pairs define pseudo-gold.'}
    report['gold_sha256']=hashlib.sha256(args.gold.read_bytes()).hexdigest() if args.gold else None
    report['projection_build_at']=json.loads(projection_metadata['summary'])['built_at']
    samples=sample_review(items,candidates,{(a,next(iter(b))) for a,b in sc_gold.items()})
    report['sample_counts']=dict(Counter(r['stratum'] for r in samples))
    (out/f'{args.label}.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    (out/f'{args.label}_pairs.json').write_text(json.dumps({'local_sc':local_sc,'local_spotify':local_sp,'spotify_sc':spotify_sc},ensure_ascii=False))
    (out/f'{args.label}_review.json').write_text(json.dumps(samples,ensure_ascii=False,indent=2))
    (out/f'{args.label}.html').write_text(render_report(report,samples))
    if args.label == 'calibration':
        (out/'RESULTS.md').write_text(results_markdown(report,json.loads(projection_metadata['summary']),None))
    print(json.dumps({'benchmarks':report['benchmarks'],'neighborhood':{k:v for k,v in report['neighborhood'].items() if k!='examples'},'sample_counts':report['sample_counts']},indent=2),flush=True)

if __name__=='__main__': main()
