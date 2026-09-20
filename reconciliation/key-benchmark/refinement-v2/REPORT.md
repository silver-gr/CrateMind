# Key refinement v2: raw energy, bass focus and Essentia resolution

## Protocol

119 available tracks from the frozen baseline manifest; 60 development / 59 holdout. Both engines use the same first 120 seconds; librosa decodes mono at 22050 Hz, Essentia at 44100 Hz. No reference labels enter estimation. Catalog and audio are read-only.

Candidates: 12 librosa combinations retaining raw energy (unnormalized CQT, bass-only first three CQT octaves, or unnormalized STFT chroma with FFT 8192) × mean/median × KS/Temperley. This tests the opposite direction to percussion suppression and bass removal. Essentia: 16 combinations of edmm/braw, FFT 4096/8192, minimum frequency 25/100 Hz and PCP threshold 0/0.2, all HPCP 36 and hop 4096. These tune spectral resolution and which pitch evidence survives thresholding.

Select maximum exact development agreement separately per engine; ties follow the predefined candidate order. Selection was saved before running holdout. The 59 evaluation tracks were already used in v1, including refined results. This is exploratory evaluation on a reused test set, NOT a fresh independent holdout. Settings are still selected only using the original 60 development labels; no candidate sweep on evaluation labels. A fresh independently labeled sample is needed before claiming generalization. Track split is not artist/album-disjoint.

## Mode imbalance

The reference set contains 118 minor keys and only one major key: development 60 minor / 0 major; holdout 58 minor / 1 major. The edmm candidates deliberately map major modes to minor according to Essentia documentation. Its improvement on this dataset does not establish reliable major/minor discrimination or justify a general-purpose default. Major/minor counts and exact matches are included separately in summary.json.

## Selected settings

```json
[
  {
    "engine": "librosa",
    "feature": "stft",
    "aggregation": "median",
    "profile": "ks"
  },
  {
    "engine": "essentia",
    "profileType": "edmm",
    "hpcpSize": 36,
    "frameSize": 4096,
    "hopSize": 4096,
    "minFrequency": 25,
    "pcpThreshold": 0.0
  }
]
```

## Accuracy

| Method | Development exact / 60 | Reused evaluation exact / 59 | Evaluation % |
|---|---:|---:|---:|
| librosa:baseline | 15 | 12 | 20.3% |
| librosa:stft:median:ks | 20 | 14 | 23.7% |
| essentia:baseline | 22 | 23 | 39.0% |
| essentia:edmm:36:4096:4096:25:0.0 | 39 | 33 | 55.9% |

Exact means identical Camelot key and mode. Related keys are not counted as exact. Djay is a comparison reference, not verified musical ground truth. Strength values are not calibrated correctness probabilities.

### Evaluation changes versus baseline

- librosa: 9 corrected; 7 regressed.
- essentia: 12 corrected; 2 regressed.

### Evaluation error categories

| Method | Exact | Relative major/minor | Parallel major/minor | Adjacent fifth | Other |
|---|---:|---:|---:|---:|---:|
| librosa:baseline | 12 | 2 | 8 | 4 | 33 |
| librosa:stft:median:ks | 14 | 2 | 8 | 6 | 29 |
| essentia:baseline | 23 | 5 | 13 | 2 | 16 |
| essentia:edmm:36:4096:4096:25:0.0 | 33 | 0 | 1 | 3 | 22 |

## Speed on the 59 evaluation excerpts

All methods ran in one sequential process with warmed feature paths and single-thread OpenBLAS/OMP limits. Baselines were rerun in the same process; candidate order randomized per track. Timings include feature extraction and classification, exclude import/warm-up and decoding. No reused feature cache on holdout. Decode is recorded independently at each sample rate. Timings are one run per track, with medians/p95 across tracks; other system activity and filesystem caches remain uncontrolled.

| Method | Analysis median | Analysis p95 | Decode median | Decode + analysis median |
|---|---:|---:|---:|---:|
| librosa:baseline | 0.398s | 0.521s | 0.151s | 0.544s |
| librosa:stft:median:ks | 0.334s | 0.448s | 0.151s | 0.481s |
| essentia:baseline | 0.048s | 0.068s | 0.146s | 0.194s |
| essentia:edmm:36:4096:4096:25:0.0 | 0.049s | 0.075s | 0.146s | 0.195s |

Development sweeps cache each librosa feature matrix to avoid redundant work, but charge feature extraction time to every candidate. Only holdout timings above are used for the final speed comparison. Speed applies to 120-second excerpts, not full-track latency.

## Reproduce

Run from repository root with `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 backend/.venv/bin/python reconciliation/key-benchmark/refinement-v2/experiment.py development`, then `experiment.py select`, then `experiment.py holdout`, then `report.py` with the same interpreter and thread limits. Existing per-split checkpoints resume rather than rerun. Archive/remove result files before a fresh run.

Selection, development measurements and environment are persisted. Production defaults remain unchanged. The experiment estimates one global key per excerpt; modulation and different file versions can cause legitimate disagreement.

## Documentation

- [Essentia Key profiles and edmm behavior](https://essentia.upf.edu/reference/std_Key.html)
- [Essentia KeyExtractor](https://essentia.upf.edu/reference/std_KeyExtractor.html)
- [Librosa chroma CQT](https://librosa.org/doc/0.11.0/generated/librosa.feature.chroma_cqt.html)
- [Librosa STFT chroma](https://librosa.org/doc/0.11.0/generated/librosa.feature.chroma_stft.html)

## Earlier pass comparison

On these same 59 evaluation tracks: original librosa 12/59, v1 selected librosa 8/59, original Essentia 23/59, v1 selected Essentia 33/59. Compare new counts above against these existing results; this reuse is why the new report is exploratory.

## Djay reference reliability

Djay labels are estimates, not ground truth. The 2025 independent benchmark author revised 250 previously disputed human annotations and disclosed training/test dataset overlap for some tools. Its scoring also accepts relative keys, unlike our exact Camelot agreement, so percentages are not directly comparable. Older djay comparisons additionally depended on OS/version. For actual accuracy, validate disputed excerpts against musical notes/chords and independent knowledgeable listeners, allowing ambiguous or changing keys rather than forcing a single label.

- https://www.reddit.com/r/DJs/comments/1ms1yds/key_detection_comparison_2025/
- https://community.algoriddim.com/t/key-detection-comparison-2021/15433
