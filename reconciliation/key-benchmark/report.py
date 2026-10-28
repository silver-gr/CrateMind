
# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import csv,json,statistics
from pathlib import Path
from collections import Counter
from run import camelot,NOTES
p=Path(__file__).parent
manifest=json.loads((p/'manifest.json').read_text());rows=[]
for f in sorted(p.glob('part-*.json')):rows+=json.loads(f.read_text())
assert len(rows)==119 and len({r['track_id'] for r in rows})==119
byid={r['track_id']:r for r in rows};rows=[byid[r['track_id']] for r in manifest['tracks']]
pcmap={camelot(note,scale):pc for pc,note in enumerate(NOTES) for scale in ['major','minor']}
def category(pred,ref):
 if not pred:return 'unavailable'
 if pred==ref:return 'exact'
 if pred[:-1]==ref[:-1]:return 'relative_major_minor'
 if pcmap[pred]==pcmap[ref]:return 'parallel_major_minor'
 if pred[-1]==ref[-1] and (int(pred[:-1])-int(ref[:-1]))%12 in (1,11):return 'adjacent_fifth'
 return 'other'
summary={}
for split in ['all','development','holdout']:
 subset=rows if split=='all' else [r for r in rows if r['split']==split]
 summary[split]={'count':len(subset)}
 for engine in ['librosa','essentia']:
  counts=Counter(category(r.get(engine,{}).get('camelot'),r['djay_key']) for r in subset)
  times=[r[engine]['seconds'] for r in subset if engine in r]
  summary[split][engine]={'categories':dict(counts),'exact_percent':round(100*counts['exact']/len(subset),2),'median_analysis_seconds':round(statistics.median(times),3) if times else None}
(p/'results.json').write_text(json.dumps(rows,indent=2,ensure_ascii=False));(p/'summary.json').write_text(json.dumps(summary,indent=2))
with (p/'comparison.csv').open('w',newline='',encoding='utf-8') as f:
 w=csv.writer(f);w.writerow(['track_id','artist','title','split','djay_key','librosa_key','librosa_relation','essentia_key','essentia_relation','error'])
 for r in rows:
  l=r.get('librosa',{}).get('camelot');e=r.get('essentia',{}).get('camelot')
  w.writerow([r['track_id'],r['artist'],r['title'],r['split'],r['djay_key'],l,category(l,r['djay_key']),e,category(e,r['djay_key']),r.get('error','')])
lines=['# Key benchmark against copied djay references','', '119 tracks with matched djay key estimates and available audio. Two missing references/files excluded as requested. All databases and audio read-only. No catalog values or defaults updated.','', '## Protocol','', 'Both engines analyzed the same first 120 seconds (or whole file if shorter), decoded independently to mono at 22050 Hz for librosa and 44100 Hz for Essentia. Librosa reproduces the current CQT mean-chroma / Krumhansl-Schmuckler correlation estimator. Essentia uses KeyExtractor defaults: profile '+str(manifest['essentia_profile'])+', HPCP size '+str(manifest['essentia_hpcp_size'])+'. No reference key is passed to either algorithm.','', 'A seeded 60-development/59-holdout split was frozen before analysis. These are untuned baseline results, reported on both splits. No method was selected or adjusted against holdout labels. The split is track-level, not artist/album-disjoint, so album-specific generalization is not tested.','', '## Exact agreement','', '| Sample | Tracks | Librosa exact | Essentia exact |','|---|---:|---:|---:|']
for split,v in summary.items():lines.append(f"| {split} | {v['count']} | {v['librosa']['categories'].get('exact',0)} ({v['librosa']['exact_percent']}%) | {v['essentia']['categories'].get('exact',0)} ({v['essentia']['exact_percent']}%) |")
lines+=['','## Error categories across all 119','', '| Category | Librosa | Essentia |','|---|---:|---:|']
for cat in ['exact','relative_major_minor','parallel_major_minor','adjacent_fifth','other','unavailable']:lines.append(f"| {cat} | {summary['all']['librosa']['categories'].get(cat,0)} | {summary['all']['essentia']['categories'].get(cat,0)} |")
lines+=['','Relative, parallel and neighboring keys do not count as exact. Enharmonic note names are normalized to the same Camelot code. Strength scores are not calibrated correctness probabilities.','', '## Timing','']
for e in ['librosa','essentia']:lines.append(f"- {e}: median {summary['all'][e]['median_analysis_seconds']} seconds analysis per excerpt; decoding timed separately in results.json. First-call setup and concurrent workload affect these single-run measurements.")
lines+=['','## Limits and next steps','', 'Djay is a comparison reference, not human-verified ground truth. Matching used the copied database and normalized filenames via the prior extraction; the supplied index-to-Camelot mapping is recorded in the handoff. Different file versions and musical key changes can cause disagreement. These first-120-second estimates should not be interpreted as full-track analyses.','', 'The frozen baseline establishes the size and types of disagreement. Future refinement must use only development labels; reserve a fresh holdout if iterative tuning starts using the existing holdout results. Verify representative disagreements by ear / known keys before trusting an apparent improvement.', '', 'Artifacts: manifest.json (split, reference-source hash, settings), results.json (all measurements/errors), comparison.csv (track-by-track Camelot results), summary.json (counts). Reproduce with run.py prepare then run.py 0 / 1 / 2 and report.py.']
(p/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps(summary,indent=2))
