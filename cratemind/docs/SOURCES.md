# Evidence register and reading notes

## Evidence priority

Uploaded raw archives and database snapshots are primary observations. Derived verification JSON records computations on those bytes. User statements establish intent and personal history. Astra's reports establish what the agent reported doing. Earlier assistant explanations are useful chronology, but unsupported numbers and inferred migration causes must not become implementation facts.

## V1: independently recomputed report audit

`verification/audit_inputs.py` was executed during this handoff preparation against the mounted originals. Outputs:

- `verification/verified_metrics.json`: metrics, tests, count definitions and source checksums.
- `verification/input_manifest.json`: exact original filenames, byte sizes and SHA-256 values.
- `verification/spotify_members.json`: all 689 CSV member identities, positions within their archives, checksums, row counts and explicit Likes classification. These are archive identities, not Spotify playlist IDs.

The script performs zero network calls and writes only new output files. The uploaded SQLite hash was unchanged. Use a self-contained snapshot; it refuses WAL/SHM sidecars. `immutable=1` is appropriate to this closed uploaded snapshot, not a method for reading a live changing database safely.

For a rerun, place the eight original input files named in the manifest into a separate input directory and use:

```bash
python3 verification/audit_inputs.py \
  --inputs '/absolute/path/to/original-inputs' \
  --output './verification-rerun'
```

This audits inventory and integrity, not the musical correctness of candidate matches. The program does not touch audio files and does not implement any production importer.

## S1: SoundCloud completed extraction report

`source-reports/SOUNDCLOUD_PROVENANCE_HANDOFF.md` and `SOUNDCLOUD_BACKUP_SUMMARY.md` were supplied by the user; they contain the same report text. Relevant original line ranges: counts 10–29; Likes reconciliation 31–41; coverage/private data 43–51; paths 53–65; deferred work and limitations 67–75.

Snapshot `20260913T225252Z` was completed on September 14 local time. Its account ID is `7149789`. The 18m50s execution time was supplied in the conversation, not measured by the audit.

## S2: SoundCloud review-only cleanup plan

`source-reports/SOUNDCLOUD_CLEANUP_PLAN.md`, especially lines 3–9: no writes queued; no exact duplicate deletion candidates; eight duplicate-title groups; preserve unknown Likes and all relationships. `source-reports/TODO.md` lines 3–17 records completed extraction checks and deferred matching.

## S3: SoundCloud archive and verification

Original `soundcloud_20260913T225252Z.tar.gz` has SHA-256:

```text
a143b77f2a75a1776e5025875d6b55f768e1bae2f97ce39479b5cb4864a059dd
```

The uploaded verification JSON reports 18,016,424 bytes and 563 verified files. The archive contains 564 regular files; the manifest is not self-hashed. The independent audit verified all 563 entries and the outer hash.

Key archive paths:

```text
data/soundcloud/raw/20260913T225252Z/
data/soundcloud/normalized/playlists.jsonl
data/soundcloud/normalized/playlist_tracks.jsonl
data/soundcloud/normalized/playlist_relationships.jsonl
data/soundcloud/normalized/tracks.jsonl
data/soundcloud/normalized/likes_tracks.jsonl
data/soundcloud/reports/backup_statistics.json
data/soundcloud/reports/snapshot_sha256_manifest.json
```

The raw archive contains private resource addressing/account data. It is not safe to publish merely because portable login/session files were excluded. Public reports should use explicit field allowlists and URL redaction.

## S4: historical user-run Spotify logs

`Pasted text.txt`, original lines 462–615, documents quota failures after Account-2 playlist 456 and the saved partial summary. Earlier pasted conversation output supplies the successful 10,720-track dry run and the Account-1 owned-playlist run. User-local JSON outputs named in those logs are not assumed to be inside this package.

## C1: direct user corrections and project decisions

The conversation supplies account access, original migration intent, the imperfect SoundCloud-to-Spotify transfer, intentional saved playlists, the downloader's album-tag convention, existing local downloads, CrateMind as canonical, and the desire to distinguish known hits from lesser-known selections using existing SoundCloud counters. These are user-supplied facts/preferences, not inferred from timestamps.

## R1: repository inspection from the session

Repository: `https://github.com/silver-gr/CrateMind`

Earlier inspected default-branch commit: `159b51c4a551445e3107e07b24924a53e6ace392`, July 29, 2026. Relevant paths:

```text
AGENTS.md
cratemind/AGENTS.md
cratemind/README.md
cratemind/backend/app/models.py
cratemind/desktop/src/db/schema.sql
cratemind/desktop/src/db/migrations.ts
cratemind/desktop/src/services/
```

This report did not re-fetch or build the latest local worktree. The supplied database contains a newer SoundCloud integration than the earlier schema discussion. Codex must inspect active local code rather than implement against the July schema alone. The last examined dependency commit also mentioned competing Bun/npm lockfiles; do not resolve that by broad upgrade during reconciliation work.

## R2: private SoundCloud wrapper inspected earlier

Repository: `https://github.com/lerboe/SoundCloud`

The session inspected README, `Sources/SoundCloud/SoundCloud.swift`, `APIRequest.swift` and `Models/UserPlaylist.swift`. The code uses private API-v2 and an access token. Commit `8ce799c5862049651057f31c707d9c265876c04e` removed the login function on January 24, 2021, despite the README example remaining. Use this as historical context; Astra's successful live authenticated reads are the actual session evidence. No historical client IDs or tokens are included in this handoff.

## W1–W4: official Spotify docs rechecked September 14, 2026

**W1: quota behavior.** Spotify's July 23 update says Development Mode quota is per developer account and introduces the `QUOTA_EXCEEDED` reason. It does not establish a reset time for this user's session.

```text
https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates
```

**W2: current library saves.** The current reference documents `PUT /me/library` with a comma-separated `uris` parameter and maximum 40 URIs. It does not document historical added-at timestamps for that endpoint.

```text
https://developer.spotify.com/documentation/web-api/reference/save-library-items
```

**W3: deprecated timestamp route.** The older `PUT /me/tracks` reference still describes `timestamped_ids` but is marked deprecated. This is documentation, not proof the user's app may successfully call it.

```text
https://developer.spotify.com/documentation/web-api/reference/save-tracks-user
```

**W4: Development Mode migration context.** Read current endpoint and access requirements before publishing. Do not transfer old assumptions into a new adapter without a small authorized test.

```text
https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist
```

No third-party coupon, TIDAL limit, SongMirror compatibility or pricing claim is a dependency of the final architecture. Those were exploratory branches, not validated implementation contracts.
