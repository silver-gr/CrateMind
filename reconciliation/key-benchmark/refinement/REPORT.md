# Key refinement and speed benchmark

## Protocol

119 available tracks from the frozen baseline manifest; 60 development / 59 holdout. Both engines use the same first 120 seconds; librosa decodes mono at 22050 Hz, Essentia at 44100 Hz. No reference labels enter estimation. Catalog and audio are read-only.

Candidate settings: 14 Essentia combinations (7 profiles × HPCP 12/36) and 12 librosa combinations (CQT / percussion-suppressed CQT / CQT excluding the two lowest octaves × mean/median × KS/Temperley profiles). Higher-resolution Essentia HPCP enables its existing average detuning correction. Librosa harmonic suppression uses CQT-domain median-filter HPSS with margin 2; it is an experimental adaptation. Both CQT variants estimate tuning automatically.

Select maximum exact development agreement separately per engine; ties follow the predefined candidate order. Selection was saved before running holdout. Holdout baseline results were already known from the earlier experiment, so this is a development-selected follow-up, not a wholly unseen external validation. No holdout candidate sweep or retuning. Track split is not artist/album-disjoint.

## Mode imbalance

The reference set contains 118 minor keys and only one major key: development 60 minor / 0 major; holdout 58 minor / 1 major. The selected edmm profile deliberately maps major modes to minor according to Essentia documentation. Its improvement on this dataset does not establish reliable major/minor discrimination or justify a general-purpose default. Major/minor counts and exact matches are included separately in summary.json.

## Selected settings

```json
[
  {
    "engine": "librosa",
    "feature": "cqt",
    "aggregation": "mean",
    "profile": "temperley"
  },
  {
    "engine": "essentia",
    "profileType": "edmm",
    "hpcpSize": 36
  }
]
```

## Accuracy

| Method | Development exact / 60 | Holdout exact / 59 | Holdout % |
|---|---:|---:|---:|
| librosa:baseline | 15 | 12 | 20.3% |
| librosa:cqt:mean:temperley | 16 | 8 | 13.6% |
| essentia:baseline | 22 | 23 | 39.0% |
| essentia:edmm:36 | 39 | 33 | 55.9% |

Exact means identical Camelot key and mode. Related keys are not counted as exact. Djay is a comparison reference, not verified musical ground truth. Strength values are not calibrated correctness probabilities.

### Held-out changes versus baseline

- librosa: 2 corrected; 6 regressed.
- essentia: 12 corrected; 2 regressed.

### Held-out error categories

| Method | Exact | Relative major/minor | Parallel major/minor | Adjacent fifth | Other |
|---|---:|---:|---:|---:|---:|
| librosa:baseline | 12 | 2 | 8 | 4 | 33 |
| librosa:cqt:mean:temperley | 8 | 5 | 8 | 4 | 34 |
| essentia:baseline | 23 | 5 | 13 | 2 | 16 |
| essentia:edmm:36 | 33 | 0 | 1 | 3 | 22 |

## Speed on the 59 holdout excerpts

All methods ran in one sequential process with warmed feature paths and single-thread OpenBLAS/OMP limits. Baselines were rerun in the same process; candidate order randomized per track. Timings include feature extraction and classification, exclude import/warm-up and decoding. No reused feature cache on holdout. Decode is recorded independently at each sample rate. Timings are one run per track, with medians/p95 across tracks; other system activity and filesystem caches remain uncontrolled.

| Method | Analysis median | Analysis p95 | Decode median | Decode + analysis median |
|---|---:|---:|---:|---:|
| librosa:baseline | 0.791s | 1.147s | 0.378s | 1.182s |
| librosa:cqt:mean:temperley | 0.793s | 1.121s | 0.378s | 1.205s |
| essentia:baseline | 0.086s | 0.161s | 0.304s | 0.404s |
| essentia:edmm:36 | 0.089s | 0.131s | 0.304s | 0.401s |

Development sweeps cache each librosa feature matrix to avoid redundant work, but charge feature extraction time to every candidate. Only holdout timings above are used for the final speed comparison. Speed applies to 120-second excerpts, not full-track latency.

## Reproduce

Run from repository root with `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 backend/.venv/bin/python reconciliation/key-benchmark/refinement/experiment.py development`, then `experiment.py select`, then `experiment.py holdout`, then `report.py` with the same interpreter and thread limits. Existing per-split checkpoints resume rather than rerun. Archive/remove result files before a fresh run.

Selection, development measurements and environment are persisted. Production defaults remain unchanged. The experiment estimates one global key per excerpt; modulation and different file versions can cause legitimate disagreement.

## Documentation

- [Essentia Key profiles and edmm behavior](https://essentia.upf.edu/reference/std_Key.html)
- [Essentia KeyExtractor](https://essentia.upf.edu/reference/std_KeyExtractor.html)
- [Librosa chroma CQT](https://librosa.org/doc/0.11.0/generated/librosa.feature.chroma_cqt.html)
- [Librosa HPSS](https://librosa.org/doc/0.11.0/generated/librosa.decompose.hpss.html)
