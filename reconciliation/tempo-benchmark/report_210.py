"""Summarize measured results without treating estimated keys as truth."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import json,statistics
from collections import Counter
from pathlib import Path
p=Path(__file__).parent/'210bpm'
rows=json.loads((p/'results.json').read_text())
assert len(rows)==10
engines=['librosa_refined','essentia_degara','essentia_multifeature']
lines=['# 210 BPM benchmark','', 'First ten distinct tracks in the supplied screenshot, in display order. Duplicate copies were excluded; the available first Soul Burn copy was used, not the missing file. The Calabi Yau track is titled “bpm” in the catalog. All ten use 210 BPM as the user-supplied reference.','', 'Three 60-second sections per file, starting at 30, 120 and 210 seconds. The analyzers received no expected tempo or title hints. The existing doubling rule (<109 BPM) remains unchanged. No catalog values, flags, settings or audio files were updated.','', '| Track | Refined librosa | Essentia degara | Essentia multifeature |','|---|---:|---:|---:|']
for r in rows: lines.append('| '+' | '.join([r['title']]+[str(r[e]['median_bpm']) for e in engines])+' |')
lines+=['','Values above are medians across sections.','', '## Accuracy against the 210 reference','', '| Engine | Mean absolute error (track medians) | Track medians within 1 BPM | Sections within 1 BPM | Median seconds/section |','|---|---:|---:|---:|---:|']
summary={}
for e in engines:
 errors=[abs(r[e]['median_bpm']-210) for r in rows]
 sections=[s[e] for r in rows for s in r['segments']]
 summary[e]={'mean_absolute_error':round(statistics.mean(errors),3),'tracks_within_1_bpm':sum(v<=1 for v in errors),'sections_within_1_bpm':sum(abs(v['bpm']-210)<=1 for v in sections),'median_seconds':round(statistics.median(v['seconds'] for v in sections),3)}
 v=summary[e]
 lines.append(f"| {e} | {v['mean_absolute_error']} | {v['tracks_within_1_bpm']}/10 | {v['sections_within_1_bpm']}/30 | {v['median_seconds']} |")
lines+=['','Timings exclude ffmpeg decoding and include first-call initialization in the relevant first sample. Single run; not a controlled speed benchmark.','', '## Key extraction (exploratory, no verified reference keys)','', 'Essentia KeyExtractor uses its installed defaults at 44100 Hz. Strength is an algorithm score, not a calibrated probability of correctness. Different sections can produce different keys. Existing catalog keys are shown only as comparison values, not ground truth.','', '| Track | Existing catalog key | Essentia keys across sections |','|---|---|---|']
for r in rows:
 keys=Counter(s['essentia_key']['key']+' '+s['essentia_key']['scale'] for s in r['segments'])
 lines.append('| '+' | '.join([r['title'],str(r['stored_key']),'; '.join(f'{k} ({v}/3)' for k,v in keys.items())])+' |')
lines+=['','## Limits and provenance','', '- Experimental refined librosa uses hop_length=128 and 16-beat span timing. This is one candidate implementation, not a benchmark of every librosa technique.', '- Essentia methods share implementation components; agreement is not two independent engine votes.', '- The 210 BPM references come from the user/catalog/title context, not an independently annotated beat grid.', '- Engine disagreement/review flags in results.json are benchmark-only: >1 BPM between engine medians, or >1 BPM error against the supplied reference.', '- BPM findings do not establish key accuracy. Verify keys against trusted manual or djay references before adopting them.', '- Scripts: ../benchmark_210.py and ../report_210.py. Versions: ../environment.json. All segment values and runtime measurements: results.json.']
(p/'REPORT.md').write_text('\n'.join(lines)+'\n')
(p/'summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
