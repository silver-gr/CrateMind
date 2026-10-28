"""Report the frozen title-derived sample, including outliers and failed cases."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import json,statistics
from pathlib import Path
p=Path(__file__).parent/'holdout100'
rows=json.loads((p/'results.json').read_text());selection=json.loads((p/'selection.json').read_text())
assert len(rows)==100 and {r['id'] for r in rows}=={r['id'] for r in selection['selection']}
engines=['librosa_refined','essentia_degara','essentia_multifeature']
summary={}
for e in engines:
 errors=[abs(r[e]['median_bpm']-r['reference_bpm']) for r in rows]
 sections=[(s[e],r['reference_bpm']) for r in rows for s in r['segments']]
 summary[e]={'mae':round(statistics.mean(errors),3),'median_absolute_error':round(statistics.median(errors),3),'within_1':sum(v<=1 for v in errors),'within_0_5':sum(v<=.5 for v in errors),'sections_within_1':sum(abs(v['bpm']-ref)<=1 for v,ref in sections),'median_analysis_seconds':round(statistics.median(v['seconds'] for v,ref in sections),3)}
lines=['# Independent 100-track BPM benchmark','',f"Frozen sample: 100 of {selection['eligible_count']} eligible tracks, seed {selection['seed']}. Title-based references were never passed to either engine. No catalog values, audio files, settings or default analyzers were changed.",'', '## Selection','', '- Accepted standalone three-digit numbers followed by BPM (case-insensitive, with or without space), or enclosed in parentheses/brackets. Attached letters/digits/underscore, decimals, and conflicting title values were rejected or held.', '- Held unavailable audio, files shorter than 270 seconds, and references outside 135–250 BPM. Duplicate artist/title copies were excluded.', '- Sample spans 140–250 BPM. The unchanged Essentia maximum is 240: the 250 BPM case is retained and reported, not silently dropped.', '- Full accepted sample and held cases with reasons: selection.json. Existing track metadata was not used as a reference when it disagreed with the title.', '', '## Protocol','', 'Three 60-second sections per track at offsets 30, 120 and 210 seconds. New librosa-onset estimator: 22050 Hz, hop_length=128; clipped positive onset flux, overlap-normalized autocorrelation, grid search 135–250 BPM in 0.02 BPM steps, weighted periodicity over 24 beat multiples. No beat-pick regression or title hint. Essentia: 44100 Hz, degara and multifeature, minTempo=60 and maxTempo=240. Every raw BPM below 109 is doubled; no flooring or forced integer snapping.', '', 'Results are evaluated against title claims, not manually annotated beat grids. This is one candidate librosa refinement, not all possible librosa algorithms. The stored librosa v1 values are retained in results.json but were measured using a different window; they are not a controlled same-window baseline.', '', '## Results','', '| Engine | Mean absolute error | Median absolute error | Tracks ±0.5 BPM | Tracks ±1 BPM | Sections ±1 BPM |','|---|---:|---:|---:|---:|---:|']
for e,v in summary.items():lines.append(f"| {e} | {v['mae']} | {v['median_absolute_error']} | {v['within_0_5']}/100 | {v['within_1']}/100 | {v['sections_within_1']}/300 |")
lines+=['', '## Half-time diagnostic (no correction applied)', '', 'Counted only when the reported tempo is wrong by >1 BPM but doubling it would be within 1 BPM of the title reference. This uses the reference for diagnosis only and does not change output values.', '']
for e in engines:
 cases=[r for r in rows if abs(r[e]['median_bpm']-r['reference_bpm'])>1 and abs(2*r[e]['median_bpm']-r['reference_bpm'])<=1]
 lines.append(f"- {e}: {len(cases)} half-time cases: "+', '.join(str(r['id']) for r in cases))
lines+=['','## Individual results','', '| ID | Track | Title BPM | Refined librosa | Degara | Multifeature |','|---|---|---:|---:|---:|---:|']
for r in rows:lines.append('| '+' | '.join(map(str,[r['id'],r['title'].replace('|','/'),r['reference_bpm'],*[r[e]['median_bpm'] for e in engines]]))+' |')
lines+=['','## Multifeature outliers (>1 BPM from title)','']
for r in rows:
 if abs(r['essentia_multifeature']['median_bpm']-r['reference_bpm'])>1:
  vals=[s['essentia_multifeature']['bpm'] for s in r['segments']]
  lines.append(f"- {r['id']} {r['title']}: reference {r['reference_bpm']}; segment BPM {vals}. Requires review; title or estimator may be wrong.")
lines+=['','## Timing and interpretation','', 'Analysis-only median seconds per 60-second segment (decoding excluded, first-call initialization included): '+', '.join(f"{e}: {v['median_analysis_seconds']}s" for e,v in summary.items())+'. These are single-run timings, not a controlled throughput benchmark.', '', 'Method agreement is not independent evidence when algorithms share components. Benchmark review flags (>1 BPM between engine medians or against the reference) exist only in the result artifact. No key extraction was performed in this run.', '', 'Reproduce: run ../select_100.py once to freeze a sample, then ../benchmark_100.py and ../report_100.py. This run resumed after 17 tracks using three bounded processes with shard arguments 0, 1, 2; ../merge_100.py combines the saved parts. Runtime measurements after resuming include concurrent workload. Benchmark resumes from completed IDs in results.json. Environment versions are in ../environment.json.']
(p/'REPORT.md').write_text('\n'.join(lines)+'\n');(p/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
