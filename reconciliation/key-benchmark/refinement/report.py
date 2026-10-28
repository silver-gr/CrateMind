"""Summarize frozen development selection and subsequent holdout evaluation."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import csv,json,platform,statistics,hashlib
from collections import Counter
from pathlib import Path
import numpy as np
import librosa,essentia
import experiment as exp
p=Path(__file__).parent
selection=json.loads((p/'selection.json').read_text())
dev=json.loads((p/'development.json').read_text());test=json.loads((p/'holdout.json').read_text())
assert len(dev)==60 and len(test)==59
assert not {r['track_id'] for r in dev}&{r['track_id'] for r in test}
assert hashlib.sha256((p/'development.json').read_bytes()).hexdigest()==selection['development_sha256']
pcmap={exp.base.camelot(note,scale):pc for pc,note in enumerate(exp.base.NOTES) for scale in ('major','minor')}
def category(pred,ref):
 if pred==ref:return 'exact'
 if pred[:-1]==ref[:-1]:return 'relative_major_minor'
 if pcmap[pred]==pcmap[ref]:return 'parallel_major_minor'
 if pred[-1]==ref[-1] and (int(pred[:-1])-int(ref[:-1]))%12 in (1,11):return 'adjacent_fifth'
 return 'other'
methods=['librosa:baseline',exp.name(selection['configs'][0]),'essentia:baseline',exp.name(selection['configs'][1])]
summary={}
for split,rows in [('development',dev),('holdout',test)]:
 summary[split]={}
 for method in methods:
  counts=Counter(category(r['methods'][method]['camelot'],r['djay_key']) for r in rows)
  times=[r['methods'][method]['seconds'] for r in rows]
  sr='22050' if method.startswith('librosa') else '44100'
  summary[split][method]={'count':len(rows),'categories':dict(counts),'exact_percent':100*counts['exact']/len(rows),'analysis_median_seconds':statistics.median(times),'analysis_p95_seconds':float(np.percentile(times,95)),'analysis_total_seconds':sum(times),'decode_median_seconds':statistics.median(r['decode_seconds'][sr] for r in rows),'reference_mode_counts':dict(Counter(r['djay_key'][-1] for r in rows)),'exact_by_reference_mode':{mode:sum(r['djay_key'][-1]==mode and r['methods'][method]['camelot']==r['djay_key'] for r in rows) for mode in ('A','B')},'decode_plus_analysis_median_seconds':statistics.median(r['decode_seconds'][sr]+r['methods'][method]['seconds'] for r in rows)}
paired={}
for c in selection['configs']:
 m=exp.name(c);b=c['engine']+':baseline'
 paired[c['engine']]={'corrected':sum(r['methods'][b]['camelot']!=r['djay_key'] and r['methods'][m]['camelot']==r['djay_key'] for r in test),'regressed':sum(r['methods'][b]['camelot']==r['djay_key'] and r['methods'][m]['camelot']!=r['djay_key'] for r in test)}
summary['paired_holdout']=paired
(p/'summary.json').write_text(json.dumps(summary,indent=2))
with (p/'comparison.csv').open('w',newline='') as f:
 w=csv.writer(f);w.writerow(['track_id','artist','title','split','djay_key']+[s for m in methods for s in (m,m+' relation',m+' seconds')])
 for r in dev+test:w.writerow([r[k] for k in ('track_id','artist','title','split','djay_key')]+[v for m in methods for v in (r['methods'][m]['camelot'],category(r['methods'][m]['camelot'],r['djay_key']),r['methods'][m]['seconds'])])
environment={'python':platform.python_version(),'platform':platform.platform(),'machine':platform.machine(),'librosa':librosa.__version__,'essentia':essentia.__version__,'numpy':np.__version__,'thread_limits':{'OPENBLAS_NUM_THREADS':1,'OMP_NUM_THREADS':1}}
(p/'environment.json').write_text(json.dumps(environment,indent=2))
lines=['# Key refinement and speed benchmark','','## Protocol','','119 available tracks from the frozen baseline manifest; 60 development / 59 holdout. Both engines use the same first 120 seconds; librosa decodes mono at 22050 Hz, Essentia at 44100 Hz. No reference labels enter estimation. Catalog and audio are read-only.','', 'Candidate settings: 14 Essentia combinations (7 profiles × HPCP 12/36) and 12 librosa combinations (CQT / percussion-suppressed CQT / CQT excluding the two lowest octaves × mean/median × KS/Temperley profiles). Higher-resolution Essentia HPCP enables its existing average detuning correction. Librosa harmonic suppression uses CQT-domain median-filter HPSS with margin 2; it is an experimental adaptation. Both CQT variants estimate tuning automatically.','', 'Select maximum exact development agreement separately per engine; ties follow the predefined candidate order. Selection was saved before running holdout. Holdout baseline results were already known from the earlier experiment, so this is a development-selected follow-up, not a wholly unseen external validation. No holdout candidate sweep or retuning. Track split is not artist/album-disjoint.','', '## Mode imbalance', '', 'The reference set contains 118 minor keys and only one major key: development 60 minor / 0 major; holdout 58 minor / 1 major. The selected edmm profile deliberately maps major modes to minor according to Essentia documentation. Its improvement on this dataset does not establish reliable major/minor discrimination or justify a general-purpose default. Major/minor counts and exact matches are included separately in summary.json.', '', '## Selected settings','','```json',json.dumps(selection['configs'],indent=2),'```','','## Accuracy','','| Method | Development exact / 60 | Holdout exact / 59 | Holdout % |','|---|---:|---:|---:|']
for m in methods:
 d=summary['development'][m];h=summary['holdout'][m]
 lines.append(f"| {m} | {d['categories'].get('exact',0)} | {h['categories'].get('exact',0)} | {h['exact_percent']:.1f}% |")
lines+=['','Exact means identical Camelot key and mode. Related keys are not counted as exact. Djay is a comparison reference, not verified musical ground truth. Strength values are not calibrated correctness probabilities.','', '### Held-out changes versus baseline','']
for e,v in paired.items():lines.append(f"- {e}: {v['corrected']} corrected; {v['regressed']} regressed.")
lines+=['','### Held-out error categories','','| Method | Exact | Relative major/minor | Parallel major/minor | Adjacent fifth | Other |','|---|---:|---:|---:|---:|---:|']
for m in methods:lines.append('| '+m+' | '+' | '.join(str(summary['holdout'][m]['categories'].get(c,0)) for c in ('exact','relative_major_minor','parallel_major_minor','adjacent_fifth','other'))+' |')
lines+=['','## Speed on the 59 holdout excerpts','','All methods ran in one sequential process with warmed feature paths and single-thread OpenBLAS/OMP limits. Baselines were rerun in the same process; candidate order randomized per track. Timings include feature extraction and classification, exclude import/warm-up and decoding. No reused feature cache on holdout. Decode is recorded independently at each sample rate. Timings are one run per track, with medians/p95 across tracks; other system activity and filesystem caches remain uncontrolled.','', '| Method | Analysis median | Analysis p95 | Decode median | Decode + analysis median |','|---|---:|---:|---:|---:|']
for m in methods:
 v=summary['holdout'][m];lines.append(f"| {m} | {v['analysis_median_seconds']:.3f}s | {v['analysis_p95_seconds']:.3f}s | {v['decode_median_seconds']:.3f}s | {v['decode_plus_analysis_median_seconds']:.3f}s |")
lines+=['','Development sweeps cache each librosa feature matrix to avoid redundant work, but charge feature extraction time to every candidate. Only holdout timings above are used for the final speed comparison. Speed applies to 120-second excerpts, not full-track latency.','', '## Reproduce','','Run from repository root with `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 backend/.venv/bin/python reconciliation/key-benchmark/refinement/experiment.py development`, then `experiment.py select`, then `experiment.py holdout`, then `report.py` with the same interpreter and thread limits. Existing per-split checkpoints resume rather than rerun. Archive/remove result files before a fresh run.','', 'Selection, development measurements and environment are persisted. Production defaults remain unchanged. The experiment estimates one global key per excerpt; modulation and different file versions can cause legitimate disagreement.','', '## Documentation','','- [Essentia Key profiles and edmm behavior](https://essentia.upf.edu/reference/std_Key.html)','- [Essentia KeyExtractor](https://essentia.upf.edu/reference/std_KeyExtractor.html)','- [Librosa chroma CQT](https://librosa.org/doc/0.11.0/generated/librosa.feature.chroma_cqt.html)','- [Librosa HPSS](https://librosa.org/doc/0.11.0/generated/librosa.decompose.hpss.html)']
(p/'REPORT.md').write_text('\n'.join(lines)+'\n')
print(json.dumps(summary,indent=2))
