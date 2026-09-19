# Focused Recovery correctness pass

Completed September 16, 2026. No new subsystem, schema, matching, promotion, path repair, acquisition or source mutation.

## Accepted association versus candidate evidence

Remote-only now explicitly means **no accepted local association**, not verified missing audio. Recovery displays existing local candidate evidence and links directly to the requested pair in Unified Library's existing evidence/review surface. The requested candidate is included even when outside the usual first 100 results. Candidates are never inserted into accepted representations or playable assets.

Across 15,112 remote-only canonical groups:

- 340 have existing HIGH_CONFIDENCE/PROBABLE local candidates without recorded hard contradictions.
- 4,978 have only unguarded AMBIGUOUS local candidates.
- 2,918 have only guarded/conflicting or otherwise non-plausible stored pairs.
- 6,876 have no stored local candidate pairs. This does not establish absence of local audio.

Counts of candidate files deduplicate local entity IDs; pair evidence preserves provider endpoints. Existing rejection/conflict, revoked-acceptance and component-block evidence is retained. No scorer or thresholds were changed. Near ties and insufficient independent evidence remain review information, not acceptance.

Example: SoundCloud `1006730182` has an unaccepted PROBABLE link to local file `547`, score 82.23. Browser verification opened that exact pair from Recovery; its recording remains remote-only and has no accepted local assets.

## 25 flags versus 365 groups — same catalog, different measurement

Both primary and identity-snapshot catalogs contain **4,748 file rows**, with identical stored paths and exactly **25 stored missing flags**. Those file rows represent **4,711 canonical groups with accepted local assets**.

| Measurement | File rows | Canonical groups |
| --- | ---: | ---: |
| Stored missing flags | 25 | 25 with at least one flag |
| Current unavailable recorded paths, irrespective of flag | 378 | 378 containing an unavailable row |
| Unflagged rows newly exposed by live path checks | 353 | 353 containing such a row |
| Groups with another accepted playable local asset | — | 13 |
| Groups with no playable accepted local asset | — | 365 |

Thus **25 + 353 = 378 unavailable file rows; 378 − 13 = 365 unavailable groups**. Among the latter, 22 contain the flagged rows and 343 contain unflagged unavailable rows. These are current path-availability measurements, not a count of verified lost recordings.

Filesystem evidence:

- **373 recorded file paths are absent inside accessible parent directories.**
- **5 parent paths are themselves absent.**
- All affected paths refer to `/Volumes/6937130292`, which is present, mounted and readable during the check.
- Observed unavailable/unmounted roots: **0**. Permission failures: **0**. Unclassified filesystem failures: **0** in this dataset.
- **135 rows**, including **all 25 stored missing flags**, have an alternative path with the same saved file size and existing sampled SHA256 signature. These are strong stale-path/renamed-or-copied-file leads, not full-file hash proof and not accepted path repairs.
- For the other **243 rows**, the reason the path became stale/absent remains unknown. No whole-library absence claim is made.

The check used existing catalog rows and each absent path's immediate parent only; no recursive search or rescan. Hashing read the existing quick-hash sample (size plus file head/tail). Alternative paths are in `file-diagnostics.json`; none was written back to either catalog.

Existing provider resolution now retains per-asset diagnostics instead of collapsing all stat failures into absence: recorded-path absence, absent parent, unavailable/unmounted root, permission denial, non-regular file, missing path metadata or unknown error. Stored missing flags are separate. A present file with a stale stored flag is not falsely called verified absent. Root/permission cases are regression-tested fixtures, not observed problems on this mounted volume.

The compatibility `LOCAL_MISSING_FILE` state / `missing_file` field still identifies accepted-local groups without a playable asset. UI wording now says unavailable local paths/groups. `file_evidence.verified_path_absent` and `availability.verified_recorded_paths_absent` explicitly concern **recorded paths only**, not absence of the audio everywhere.

## Popularity: existing behavior verified, label corrected

The existing sort already takes the **minimum observed plays or likes across linked SoundCloud uploads**, excludes unknown observations, preserves numerical zero and places entirely unknown values last. It does not infer recording-level obscurity. The label and explanation now say this precisely. No sorting formula changed; regression tests cover multiple linked uploads, zero and unknown.

## Targeted verification and stop boundary

- 32 focused regression tests passed: file causes/permissions, stale flags, unaccepted candidate isolation and rejection guards, deep review beyond the 100-row cap, and minimum-upload popularity with zero/unknown, plus existing Recovery/lineage integration tests.
- Frontend TypeScript/Vite build passed; browser candidate-to-review navigation passed with zero page errors.
- Pre/post hashes match primary `tracks`, identity entities, accepted links, candidates, canonical records/credits, imported collections/memberships and lineage relationships.
- Accepted identities, file paths, memberships, audio content and remote services were not modified. No production recovery decisions were made.

Artifacts: `findings.json`, `file-diagnostics.json`, `before.json`, `tests.xml`, `build.log`, `browser.json`, `candidate-evidence.png`, `direct-review.png`. Read-only runner: `reconciliation/check_recovery_correctness.py`.
