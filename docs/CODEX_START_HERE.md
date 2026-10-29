# Codex handoff: CrateMind unified music library

For the October 2026 Tauri work, read [desktop operations](TAURI_DESKTOP_OPERATIONS.md)
and the validated `superpowers/plans/2026-10-27-tauri-desktop-migration.md` first.
The historical reconciliation handoff below describes an earlier scope. Desktop
now reuses the shared Python domain, with BPM/key and provider processing left
in web. Keep all verification on generated/copied fixtures and preserve original
databases and source audio. The legacy Deno application and `desktop/` source
were retired on 2026-10-29; its bounded data importer and schema fixtures remain
for compatibility with existing libraries.

Use this as the opening task prompt in the **existing local CrateMind workspace**. Read the session report for history; use the uploaded inputs and local code as evidence. Suggested effort: Medium for inventory and the first preview; escalate narrowly for a consequential schema decision, not for bulk CSV parsing.

## Mission

Build the next step toward a single user-controlled music catalog in CrateMind, incorporating **local audio + SoundCloud + all three Spotify accounts**. Spotify-only entries must work without a local file or SoundCloud match. SoundCloud and Spotify become optional selective publishing targets, not prerequisites for using the local catalog.

This run is **read-only reconciliation and planning**. You may write code, tests and new staging/report files. Do not modify the production catalog, source audio, source backups or any cloud account. Do not restart scraping, resume the old Spotify write scripts, or execute cleanup proposals.

## Read in this order

1. Applicable repository agent instructions and the active local working tree.
2. `2026-09-14-cratemind-music-library-recovery.md`.
3. `verification/verified_metrics.json` and `verification/input_manifest.json`.
4. `source-reports/SOUNDCLOUD_PROVENANCE_HANDOFF.md`.
5. `ROADMAP_AND_IDEAS.md` only after the minimal next milestone is clear.

## Workspace and inputs

Find the real local project and database. Earlier paths mention both `Music-ReORG` and `CrateMind`, with root analysis scripts plus the app in `cratemind/`. Those are historical paths; the current desktop uses Tauri in `native/` and the shared Python backend. Determine which runs the user's current UI. **Do not assume July's GitHub snapshot is the latest local code.** Respect existing uncommitted changes and read the active services/migrations before creating new abstractions.

The handoff package contains reports and audit outputs, not the database, audio or full raw archives. Locate these original files without scanning unrelated personal folders:

```text
Account 1.zip                         Spotify A1
spotify_playlists (1).zip              Spotify A2
spotify_playlists.zip                  Spotify A3
soundcloud_20260913T225252Z.tar.gz      SoundCloud raw + normalized + reports
cratemind.sqlite                      Uploaded catalog snapshot; compare to live DB
My Spotify Library.CSV                Original backup
My Spotify Library (3).csv             Original backup
```

Aliases/renames are fine when hashes establish identity. If inputs cannot be found in the project/user-provided locations, ask one focused question for their folder. Do not guess that chat `/mnt/data` exists on the user's machine. Do not download or publish the private raw archive elsewhere.

## Facts and user decisions you must preserve

- The SoundCloud backup has 320 playlist objects, 8,777 positions and 4,724 retained Likes IDs. Seventy-five Likes lack metadata; another two exist only as a counter discrepancy. Do not invent IDs or label unknown 404s as deleted.
- The 37 public owned playlists were only a subset: there are 272 owned, including 235 private. Saved/reposted relationships overlap with ownership and are not separate object identities.
- No exact SoundCloud playlist duplicates or repeated playlist track IDs were found. Do not execute a dedupe deletion job.
- The three Spotify exports contain **5,648 distinct liked track URIs** and **11,172 distinct music-track URIs across all Likes/playlists**. These are service IDs, not cross-platform recording counts.
- Preserve intentional saved/followed playlists, even those authored by others. Preserve system lists as dated snapshots. Same name does not mean same collection; identical contents do not erase different provenance or purpose.
- The current supplied database already contains `soundcloud_tracks`, `track_soundcloud_matches` and `soundcloud_match_candidates`. Reuse them. There are 545 accepted link rows to 531 distinct SoundCloud IDs; 298 use `exact_metadata`, 247 use `manual_review`. Preserve both and their evidence, but do not call auto-matches human-approved. There are 209 pending candidate rows for 208 local tracks.
- The local `tracks` table has 4,748 rows; 25 are marked missing. This is not a fresh physical-file check.
- Album label `Likes of DJ PanoramixXX` marks one downloader's source collection for 1,347 rows. It is **not** a real release album, proof of exact track identity, or the limit of SoundCloud-origin downloads. Many tracks already existed locally.
- The user values SoundCloud playback/like counts as familiarity/discovery signals. Preserve this existing feature and source timestamps. Do not use popularity to decide which recording identity is correct.
- Account 2 contains migrated A1 Likes and imperfect SoundCloud playlist transfers. April 10/September 9 clusters are evidence, not settled explanations of every playlist.

## First milestone: one read-only, end-to-end integration preview

### A. Discover and protect

Report the active runtime, source branch/working tree, catalog path, current schema and existing match/import/export services. Identify the existing SoundCloud review flow. Inspect local downloader sidecars, source URLs and old `sc_*.json` only within relevant project/library locations; those may provide stronger IDs than filename heuristics.

Do not run old root import scripts that delete/rebuild catalog tables. Do not trigger audio analysis jobs, network enrichment, dependency upgrades or full library rescans. Use a consistent backup/snapshot for analysis, with correct WAL handling; never blindly copy an active SQLite main file and call it a backup.

### B. Stage all sources offline

Reuse the completed SoundCloud export; do not redo the browser/API acquisition. Parse all three Spotify ZIPs with their actual headers and encoding. Key export entries by archive hash/member identity/position, not filename-derived remote IDs. Configure real Likes explicitly: A1/A2 `liked.csv`; A3 `Liked_Songs.csv`. Keep the ordinary A1/A2 `liked_songs.csv` playlists separate.

Retain raw metadata, title/version tokens, ISRC where present, added dates, artist/uploader roles, duration and availability independently. Read SoundCloud popularity counters from the raw cache or existing table: the normalized track JSONL does not carry every raw counter. Never leak private tokens or credential-bearing URLs into output.

Do not force unmatched or remote-only items into file-backed `tracks` with fake paths. Use staging records until the minimal additive persistence design is approved.

### C. Reconcile conservatively

Start with existing accepted links and explicit source IDs/URLs. Then generate evidence-based candidates using title, version, performer/uploader, duration and collection context. An exact ISRC is useful evidence but not a universal merge command. A byte hash, audio fingerprint, provider ID and musical-recording hypothesis answer different questions.

Keep ambiguous, rejected and unresolved states. Preserve many local-file representations of one remote recording. Do not replace reviewed links, personal ratings, DJ notes, analysis choices or source membership. Store scores as heuristic scores, not calibrated probabilities.

For Spotify, retain full source items and memberships even when no counterpart exists. Identify already-known same-service aliases separately from unproven cross-platform matches. Episodes, full DJ mixes and local URIs must not silently become normal song matches.

### D. Demonstrate the smallest useful collection

Produce a preview of one representative source collection with known local matches and at least one remote-only/unresolved entry. Preserve its exact source positions. Show playable local assets, missing or ambiguous entries, source provenance and a proposed editable local collection. Preserve both original snapshot and proposed canonical view.

This preview must demonstrate that remote-only entries survive and existing CrateMind data is untouched. Stop short of production import or schema migration.

## Required outputs

Write into a new project-local staging/report folder, not over source inputs:

```text
CURRENT_STATE.md
INPUT_INVENTORY.json
RECONCILIATION_SUMMARY.md
match_candidates.jsonl
collection_preview.json
MINIMAL_INTEGRATION_PLAN.md
```

Include acceptance-test results for multilingual headers, duplicate names, empty collections, repeated positions, missing identifiers, remote-only items, same remote track linked to multiple local assets, and import/reconciliation reruns without duplicated staging records. Tests must use fixtures or snapshots, not mutate production.

`MINIMAL_INTEGRATION_PLAN.md` should identify concrete existing files/functions to extend, the smallest proposed schema changes, data precedence, rollback/backup approach, and what remains unknown. Avoid a generic sync framework, graph database, full redesign or maintaining both runtimes unless both are actually required.

## End-of-run report and stopping rule

Report verified counts, exact versus candidate coverage, unresolved cases, one collection preview, tests run/skipped, files created and the next approval needed. Distinguish source observations from your inferences. No need for the user to make routine parser or folder decisions.

**Stop before production DB changes, audio changes, remote publishing or cleanup.** Completion is a reliable preview and minimal implementation plan, not a perfect global identity solution.
