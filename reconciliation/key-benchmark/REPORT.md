# Key benchmark against copied djay references

119 tracks with matched djay key estimates and available audio. Two missing references/files excluded as requested. All databases and audio read-only. No catalog values or defaults updated.

## Protocol

Both engines analyzed the same first 120 seconds (or whole file if shorter), decoded independently to mono at 22050 Hz for librosa and 44100 Hz for Essentia. Librosa reproduces the current CQT mean-chroma / Krumhansl-Schmuckler correlation estimator. Essentia uses KeyExtractor defaults: profile bgate, HPCP size 12. No reference key is passed to either algorithm.

A seeded 60-development/59-holdout split was frozen before analysis. These are untuned baseline results, reported on both splits. No method was selected or adjusted against holdout labels. The split is track-level, not artist/album-disjoint, so album-specific generalization is not tested.

## Exact agreement

| Sample | Tracks | Librosa exact | Essentia exact |
|---|---:|---:|---:|
| all | 119 | 27 (22.69%) | 45 (37.82%) |
| development | 60 | 15 (25.0%) | 22 (36.67%) |
| holdout | 59 | 12 (20.34%) | 23 (38.98%) |

## Error categories across all 119

| Category | Librosa | Essentia |
|---|---:|---:|
| exact | 27 | 45 |
| relative_major_minor | 3 | 7 |
| parallel_major_minor | 19 | 28 |
| adjacent_fifth | 6 | 7 |
| other | 64 | 32 |
| unavailable | 0 | 0 |

Relative, parallel and neighboring keys do not count as exact. Enharmonic note names are normalized to the same Camelot code. Strength scores are not calibrated correctness probabilities.

## Timing

- librosa: median 0.755 seconds analysis per excerpt; decoding timed separately in results.json. First-call setup and concurrent workload affect these single-run measurements.
- essentia: median 0.085 seconds analysis per excerpt; decoding timed separately in results.json. First-call setup and concurrent workload affect these single-run measurements.

## Limits and next steps

Djay is a comparison reference, not human-verified ground truth. Matching used the copied database and normalized filenames via the prior extraction; the supplied index-to-Camelot mapping is recorded in the handoff. Different file versions and musical key changes can cause disagreement. These first-120-second estimates should not be interpreted as full-track analyses.

The frozen baseline establishes the size and types of disagreement. Future refinement must use only development labels; reserve a fresh holdout if iterative tuning starts using the existing holdout results. Verify representative disagreements by ear / known keys before trusting an apparent improvement.

Artifacts: manifest.json (split, reference-source hash, settings), results.json (all measurements/errors), comparison.csv (track-by-track Camelot results), summary.json (counts). Reproduce with run.py prepare then run.py 0 / 1 / 2 and report.py.
