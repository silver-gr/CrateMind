# Fast change scan behavior

The fast scan is `POST /api/scan/start` with `mode: "delta"`. It walks the selected configured roots and compares each indexed path's **file size and modification time**, plus its catalog missing flag. It does not hash unchanged files to establish byte equality.

The reported run (`added 101, updated 0, unchanged 5337, missing 5, skipped duplicates 11, analyzed 101, analysis failed 0`) means:

- 101 previously unindexed, non-duplicate tracks entered the catalog and received local audio analysis.
- 5,337 indexed files matched size/mtime and were not marked missing. Their tags, hashes, stream metadata, and audio analysis were not read again.
- No existing indexed row needed a file refresh. Five previously present catalog rows were absent under completely readable scanned roots and were marked missing.
- Eleven unindexed files matched a readable, unchanged catalog survivor under the stricter scanner duplicate rules and were not imported. Source files were retained.
- All 101 new-track analyses completed successfully. These figures do not establish which paths were missing or which duplicate candidates were skipped; the summary contains counts.

## What is read and what is preserved

| File/catalog state | Fast scan | Automatic local audio analysis |
| --- | --- | --- |
| Indexed, same size/mtime, not missing | Filesystem traversal and stamp check only | No |
| Indexed, size/mtime changed | Tags, quick hash, stream metadata; refresh file-derived fields | No; current automatic post-step targets newly added IDs |
| Indexed row previously marked missing, now readable | Refresh as an existing file | No |
| New path | Read tags, quick hash, stream metadata; check conservative duplicates | Newly accepted IDs only |
| Known path absent from a completely readable root | Mark catalog row missing | No |
| Disconnected/unmounted or incompletely readable root | Warn; do not infer missing files beneath that root | No |

Scan refreshes do not reset DJ profiles, ratings stored in those profiles, tags, notes, cues, sets, manual identity decisions, or source audio. The local analysis subprocess uses explicit added IDs with `local_only=True` and `only_unprocessed=True`; provider analysis jobs are not launched by this post-step. The desktop profile omits this web processing step.

A full scan additionally re-reads embedded tags on indexed files whose size/mtime match, permitting metadata-parser improvements to be applied. It is not an unconditional hash/stream/audio-analysis pass. Equal size/mtime can miss content changed while deliberately preserving both attributes; unchanged means the signature matched, not that bytes were compared.

## Measured improvements from this change

Generated fixtures verify the following; no real music-library scan was run for verification.

| Work | Before | After |
| --- | --- | --- |
| Following filesystem `stat` calls per ordinary unchanged audio file | 3: accessibility/file check, accessibility stamp, scan stamp | 1 stamp, reused for traversal, delta comparison and any metadata refresh |
| Identity observation lookups for 100 ordinary existing catalog rows | 100 individual queries | 1 batched query |
| Identity normalization on 100 unchanged snapshots | 100 derivations | 0 in delta mode; full synchronization still performs 100 |
| Identity normalization after changing one of those snapshots | All 100 | 1, with 99 unchanged snapshots skipped |
| Tag/quick-hash/ffprobe work on an unchanged delta file | 0 | 0; guarded by forbidden-call tests |
| Artist rebuild / analysis process for an unchanged-only delta | 0 | 0; guarded by worker tests |

Symlink validation still performs its required link metadata checks. A duplicate survivor is checked independently before it can suppress an incoming file. Rare historical source-pointer overlaps and repeated input IDs use fresh observation reads to preserve their sequential repair behavior.

## Remaining work and recovery behavior

The scan still commits its catalog changes, replays pending mirror intents, and reconciles the **whole paired catalog** with the identity catalog. This is deliberate: restricting synchronization to this run's changed IDs would lose recovery of a previously committed scan whose identity transaction failed. An unchanged follow-up delta still repairs those pending observations. Snapshot comparison is cheaper now; it does not replace the recovery contract.

Identity synchronization still reads the catalog snapshot and checks confirmed legacy links. Actual identity changes may rebuild the shared candidate index and refresh global status/near-tie annotations. A run that adds/updates/misses tracks also rebuilds derived artist profiles. Those costs are separate from re-reading unchanged audio.

Skipped unindexed duplicates have no new catalog row or persistent skip cache, so a later scan can inspect those paths again. This retains the ability to import one if its earlier survivor becomes unavailable.

Focused generated-fixture checks cover signature-only skipping, one-stamp reuse, lazy duplicate indexing, changed/restored files, inaccessible/partially readable/unmounted roots, conservative duplicate matching, manual-work preservation, interrupted identity recovery, batched pointer handling, and newly added IDs being the only analysis targets.
