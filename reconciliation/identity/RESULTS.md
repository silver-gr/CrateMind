# Calibrated unified-library results

Open `/unified`, then **Έλεγχος αντιστοιχίσεων · δείγμα 90 προτάσεων**. The review page displays metadata, provider links, collection examples and scoring evidence, and exports review labels as JSON. Exporting labels does not accept identities.

## Held-out quality

Accepted decisions and historical retrieval shortcuts are absent from backtest candidate generation. Both pseudo-gold benchmarks mask ISRC in retrieval and scoring. The baseline gold set is frozen in `calibration_gold.json`; alternative corroborated catalogue/recording identities are evaluated as sets.

| Benchmark | N | Retrieval recall | Recall@1 | @5 | @10 | MRR | Median true-pair score |
|---|---:|---:|---:|---:|---:|---:|---:|
| manual_review | 247 | 100.00% | 99.19% | 100.00% | 100.00% | 0.9960 | 97.79 |
| exact_metadata | 298 | 100.00% | 99.33% | 100.00% | 100.00% | 0.9966 | 95.065 |
| combined | 545 | 100.00% | 99.27% | 100.00% | 100.00% | 0.9963 | 96.9 |
| local_spotify_pseudo_gold | 65 | 100.00% | 100.00% | 100.00% | 100.00% | 1.0000 | 95.0 |
| spotify_soundcloud_isrc_masked | 712 | 100.00% | 98.60% | 100.00% | 100.00% | 0.9930 | 94.96 |

| True-pair query class | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT | Not retrieved |
|---|---:|---:|---:|---:|---:|
| manual_review | 205 | 41 | 1 | 0 | 0 |
| exact_metadata | 154 | 141 | 3 | 0 | 0 |
| combined | 359 | 182 | 4 | 0 | 0 |
| local_spotify_pseudo_gold | 56 | 9 | 0 | 0 | 0 |
| spotify_soundcloud_isrc_masked | 605 | 94 | 13 | 0 | 0 |

Exact-ISRC census: 1071 Spotify↔SC pairs; 714 accepted after corroboration, 123 conflicting. The remaining pairs stay proposals/review. Conflict reasons overlap: {'duration_conflict': 83, 'supplemental_artist_contradicts_primary': 18, 'version_mismatch': 28, 'media_type_conflict': 3, 'artist_conflict': 4}. ISRC does not bypass semantic-version protection.

Ranking uses descending numeric score and deterministic ID tie-break after the production relevance filter. Classes include query-side near-tie demotion; they do not include reverse-side competition from unrelated queries. Full production classes are reported below. Missing truth remains in denominators. Median scores cover retained truth (all truth was retrieved here).

The 247 manual decisions are the strongest benchmark. Exact-metadata decisions are a separate, weaker label source. ISRC pseudo-gold is selected through metadata corroboration, so it favors easier examples and is not unbiased independent ground truth. Equivalent targets include corroborated identities, not every possible unobserved catalogue entry.

## Precision and decision

**Scores are not probabilities; new-match population precision remains unmeasured.** Positive-only benchmarks cannot label every other candidate false. Historical decisions are also a selected subset. No bulk acceptance was enabled, and PROBABLE/AMBIGUOUS remain review states.

- manual_review: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in 204/206 queries. This is conditional gold agreement, not a population precision estimate.
- exact_metadata: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in 154/154 queries. This is conditional gold agreement, not a population precision estimate.
- combined: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in 358/360 queries. This is conditional gold agreement, not a population precision estimate.
- local_spotify_pseudo_gold: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in 56/56 queries. This is conditional gold agreement, not a population precision estimate.
- spotify_soundcloud_isrc_masked: HIGH_CONFIDENCE top-1 agrees with the recorded gold answer in 604/606 queries. This is conditional gold agreement, not a population precision estimate.

The 90-pair sample contains 30 HIGH_CONFIDENCE local↔Spotify, 20 PROBABLE local↔Spotify, 20 new HIGH_CONFIDENCE local↔SoundCloud and 20 non-ISRC HIGH_CONFIDENCE Spotify↔SoundCloud. It uses seeded random sampling within score terciles, records population sizes/inclusion probabilities, and leaves human verdicts blank. Repeated recordings may make labels correlated. A rapid metadata inspection is not audio verification; no synthetic human labels were supplied.

Retrieval recall did not justify widening retrieval or weakening thresholds. Existing HIGH_CONFIDENCE naming is retained as a proposal class, not authorization for bulk acceptance. Human review is the missing evidence for estimating new-match precision.

All four historical rejections remain CONFLICT in the published projection. One rejected pair (`local:3978` ↔ `soundcloud:tracks:647917803`) scores HIGH_CONFIDENCE without its rejection: exact artist/remix-title and 0.121-second duration difference. The rejection wins; metadata cannot explain every human decision. It was not relabeled or tuned away.

## Focused corrections and neighborhood ablation

- Version extraction excludes artist-wrapper words such as Live Magnet / Kayros Live, while preserving original song suffixes including `(2014 Edit)`. Semantic version/remixer/duration conflict protection remains active.
- Neighborhood points affect ranking but cannot cross an intrinsic confidence threshold. The baseline changed three intrinsic classes, including one PROBABLE→HIGH_CONFIDENCE pair. That pair was Technical Hitch, Ohm/Om Shri Kali: 88.83→89.83 with one neighbor.

After correction, 1,249 pairs have neighborhood support; 1,062 scores change by at most 2.0 points. Intrinsic class changes: 0; promotions to HIGH_CONFIDENCE: 0; weak/contradictory intrinsic pairs promoted: 0.
The full bidirectional near-tie ablation changes 2 published classes, including 0 promotions to HIGH_CONFIDENCE. Exact examples and before/after evidence are in `calibration.json`; baseline examples are in `calibration_baseline.json`.

## Refreshed reconciliation

**22,781 identities, 62,632 candidate pairs, 1,012 collections, 49,870 ordered positions.** The 49,850 original source positions and the additional 20-position local proof collection remain intact.

| Source | Total | Linked local | Linked Spotify | Linked SC | Both | No accepted counterpart |
|---|---:|---:|---:|---:|---:|---:|
| local | 4748 | — | 65 | 545 | 65 | 4203 |
| spotify | 11172 | 60 | — | 712 | 60 | 10460 |
| soundcloud | 6858 | 531 | 702 | — | 60 | 5685 |

Linked counts may be transitive through accepted recording components. No accepted counterpart does not prove no match exists. Spotify totals cover 11,172 music identities; three additional nonmusic identities remain preserved. All 75 unknown SoundCloud Likes remain represented.

| Pair | ACCEPTED | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT |
|---|---:|---:|---:|---:|---:|
| local:soundcloud | 545 | 980 | 237 | 7159 | 9556 |
| local:spotify | 0 | 702 | 287 | 7362 | 7118 |
| spotify:soundcloud | 714 | 773 | 507 | 12177 | 14515 |

| Strongest entity state | ACCEPTED | HIGH_CONFIDENCE | PROBABLE | AMBIGUOUS | CONFLICT | NO_CANDIDATE |
|---|---:|---:|---:|---:|---:|---:|
| local | 545 | 1174 | 244 | 2098 | 366 | 321 |
| spotify | 712 | 1005 | 484 | 4771 | 1909 | 2291 |
| soundcloud | 1173 | 1298 | 431 | 1945 | 844 | 1167 |

The 545 authoritative local↔SC decisions and 714 corroborated SC↔Spotify ISRC edges are preserved. New metadata proposals were not bulk-accepted. The existing unified library, local audio links and Summer proof collection remain available.

## Evidence and reproducibility

- Primary cleaned metadata remains persisted in `tracks`; see `METADATA_FINDINGS.md`. Existing SoundCloud decision tables remain authoritative; `backend/data/identity.sqlite` is the rebuildable projection.
- `calibration.json`: metrics, protocol limits, rejection audit and context examples. `calibration_pairs.json`: every held-out query, top ten and true-pair diagnostics.
- `calibration_review.json` / `calibration.html`: the 90-pair review artifact and working review interface. Stale reports are blocked when the projection build changes.
- `calibration_gold.json`: frozen benchmark IDs and decision groups. `calibration_baseline*`: before-change evidence.
- `results.json`, `source_preservation.json`, `calibration_validation.json`, `calibration_tests.xml`, `calibration_browser.json`: counts, preservation and verification evidence.

Run:

```sh
/Users/silver/venv/bin/python reconciliation/build_identity.py
/Users/silver/venv/bin/python reconciliation/calibrate_identity.py --gold reconciliation/identity/calibration_gold.json
```

No audio retagging/moves, remote mutations, original playlist membership changes or production decision edits were performed. Review JSON exports are separate artifacts, not identity decisions.

Validation: 50 backend tests passed; frontend TypeScript/Vite build passed. Browser review/export/audio evidence is in `calibration_browser.json`. Existing non-blocking warnings concern Starlette/httpx and Vite native-loader `__dirname` compatibility.

Public browser verification passed through the built frontend: 90 review rows, review-label JSON export, local audio metadata, zero JavaScript errors and zero write requests. Runtime URL/process details are in `public_access.json`. The development frontend remains on port 5173.
