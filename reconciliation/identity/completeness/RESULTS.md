# Library Completeness + Collection Intelligence

Implemented in CrateMind, September 15, 2026. No scoring, calibration or promotion pass was run.

## Use it

- `/recovery`: canonical completeness totals and a missing-local work queue. Filter by Likes, Spotify account, provider, canonical availability, artist/title, collection, minimum distinct collections, saved-playlist evidence, local-missing vs never-local, and recovery decision. Sort is distinct collection count descending.
- Each row exposes provider links, raw SoundCloud plays/likes/reposts, Likes accounts and collection frequency. `wanted`, `acquired`, `skipped`, `unavailable` are persistent personal decisions with timestamps and an event history. `acquired` never invents a playable file.
- `/collections`: availability counts and filters retain original position numbers and repetitions. “Only in this collection” uses distinct canonical membership across the catalog. No playlist families or genealogy are inferred.
- Open “Σύγκριση & πράξεις συλλογών” to choose another source, preview union/intersection/difference, optionally subtract the playable library, and save a new native collection. One operand performs canonical deduplication. Saved entries retain all contributing source positions. For larger expressions, save an intermediate native result and use it as the next operand; the API accepts up to 20 sources.
- Overlap is explicitly Jaccard: shared canonical recordings / their union. Left-only/right-only counts and difference previews expose content changes without claiming version history.
- Dashboard links to completeness with live derived totals. Library's canonical card shows availability, distinct collection count and existing raw counters.
- Existing local DJ search supports `local_playable`, `remote_only`, `missing_file`, `soundcloud_like`, `spotify_like`, `collections:5+`, including negation, combined with e.g. `status:approved not_recent:90`. Local Library search returns local track rows; remote-only discovery is in Recovery. Recovery supports those availability/Like/frequency concepts and artist/title search, not local DJ profile fields.

## Current canonical totals

| Metric | Recordings |
| --- | ---: |
| Known groups | 19,824 |
| Playable locally | 4,346 |
| Local assets, none currently playable | 365 |
| Remote-only | 15,112 |
| Unresolved availability | 1 |
| SoundCloud Likes without playable local asset | 3,271 |
| Spotify Likes without playable local asset, deduplicated across accounts | 5,104 |
| Wanted and not playable | 0 |

Counts are canonical groups, not local file rows or playlist positions. Like totals overlap. Catalog totals include two Spotify episodes. One Spotify `local:` reference remains unresolved; it does not establish a remote playable identity. Provider presence is not a guarantee of current remote streamability: this milestone uses snapshots and makes no remote calls. Source availability observations remain in API provider projections.

## Collection validation

| Collection | Positions | Playable | Remote-only | Missing local | Unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Summer 2023 — CrateMind | 20 | 16 | 4 | 0 | 0 |
| SoundCloud Likes | 4,724 | 1,449 | 3,257 | 18 | 0 |
| Spotify Account 2 Likes | 5,571 | 532 | 5,039 | 0 | 0 |

Summer's missing positions are 4, 5, 16, 20 (UI numbering): Marambá — Alma Limpa; Marambá — Senu's Desert; •∆High-tech Bass, Progessive Pace∆• 180 BPM mix; Marambá — Eyes Closed.

The full catalog remains 1,013 collections / 49,890 positions. Save and recovery writes were validated against isolated test catalogs; no synthetic user decisions or extra collections were inserted into the real library.

## Evidence and boundaries

- 43 focused automated tests, frontend TypeScript/Vite build and browser checks pass; see `tests.xml`, `build.log`, `browser.json`.
- Browser: recovery search, Summer's four remote-only entries, and subtract-playable algebra preview; no page errors.
- `manual-algebra.json` records an independently inspected small fixture: A=[R1,R2,R2], B=[R2,R3,R1 via another provider]. Union=[R1,R2,R3], intersection=[R1,R2], A−B=[], B−A=[R3], union minus playable R1=[R2,R3].
- `validation.json` checks the three real collections, representative all-three/provider-only/missing-file groups, exact original positions and SQLite integrity.
- Pre/post content hashes match for entities, acceptance ledger, candidates, canonical metadata/credits, collections and memberships; scorer hash also matches. Backup: `before.sqlite`; baseline hashes: `before.json`.
- Identity catalog: `backend/data/identity.sqlite`; primary local catalog: `backend/data/cratemind.sqlite`. Recovery schema is created lazily by the first explicit recovery decision.
- No audio acquisition, file mutation, remote mutation, automatic identity acceptance or metadata rewrite.
- Raw popularity is shown without an invented obscurity score. Distinct collection count counts imported snapshots and native collections separately, not inferred real-world playlist families.
