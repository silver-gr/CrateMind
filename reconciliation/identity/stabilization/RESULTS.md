# Integration stabilization and Collections

Completed without rerunning matching, calibration, or promotion. The scorer and promotion-function hashes match the start of this pass. Acceptance ledger, candidate scores/evidence, source entities/recording links, original collections, and original memberships match the pre-change snapshot.

## Provider read paths

Previously, canonical summary read the identity recording group while `soundcloud.track_detail` only read the old direct `track_soundcloud_matches` row and cached snapshot. The Library's new summary could therefore show a real association while the older card denied it.

`provider_resolution.py` now owns provider snapshot/stat serialization, canonical group resolution, local assets, Likes/collections, and accepted-link paths. Canonical detail, the Library card response, list counters, collection assets and SoundCloud summary use it. The existing card consumes a compatibility projection from that same response. The original direct mapping is retained as `legacy_soundcloud` evidence. A stable provider identity order selects the first detailed SoundCloud card/list counter source; all associated identities remain available in canonical detail. Every counter projection includes its provider identity ID.

## Consistency audit

Checked **2,461 multi-source recording groups**, **3,374 credited-artist search documents**, and **49,890 collection positions**.

| Check | Legacy read path inconsistencies | After |
|---|---:|---:|
| Missing/different SoundCloud identity in detail card | 972 | 0 |
| Missing/stale counters in legacy card | 1510 | 0 |
| Library vs canonical review title/artist | — | 0 |
| Credited artist absent from searchable document | — | 0 |
| Collection references missing a canonical recording | — | 0 |
| Counters attached to a different provider identity | — | 0 |

The first two baseline counts describe the legacy direct-map/cache path, not defects in the already-canonical summary; they overlap and must not be added. All post-change checks pass. Search behavior is additionally covered by endpoint regressions for primary/co-artist/remixer credits. The exhaustive artist check validates searchable documents rather than issuing thousands of repeated HTTP requests.

## Review and artist semantics

Default inbox: **1,443 actionable local proposals**, compared with 19,824 total groups. Filters expose Needs review, Auto-applied, Conflicts (38), Provider-only, Local-only, Canonical complete, Unknown metadata, and All. Empty/unknown provider-only rows remain accessible without occupying the default inbox. Human-accepted decisions leave the actionable inbox; relevant rejected/keep-local proposals remain accessible.

Current canonical values are shown separately from proposals. Local source, SoundCloud source, Spotify source and manual decisions are labelled. Original file metadata stays in the local-source panel; no tags are written.

Ordered co-credits no longer imply a lead artist. **4,633 stored credit roles** were corrected; 5,191 recording/proposal rows received audited semantic updates. Multi-artist credits use neutral collaborator roles unless featured/remixer evidence establishes a role. Single-artist credits retain primary. Credit order and artist identities remain separate; manual metadata decisions are protected. `credit_semantics_v2` events preserve before/after values. No identity groups or acceptances changed.

## Collections delivered

Open `/collections` to search/browse imported playlists and Likes, filter by source, and see playable-local, remote-only and missing-local counts. File existence is checked against the catalog's actual `absolute_path`. Missing files are distinguished from recordings with no local representation.

Create an empty CrateMind collection, copy a source collection with exact order/provenance, or append searched identities to a native collection. Repeated positions are retained. Imported memberships are immutable: the append endpoint rejects non-native collections. New native memberships refer to existing entities and resolve through their canonical recording IDs.

Created **Summer 2023 — CrateMind** through the UI:
- ID: `cratemind:collection:0342e5c343d44020b5973a996a95a0c2`
- 20 positions, 16 playable locally, 4 remote-only.
- Original source collection/order/provenance preserved.
- Browser audio playback advanced successfully with audio muted during verification.

Total collections: 1,013. Original 49,870 positions remain unchanged; this new native collection adds 20 positions (49,890 total).

## Verification and artifacts

- 35 focused tests pass: transitive provider association without a legacy direct row, shared counters/summary, canonical search by all credit roles, meaningful inbox selection, native creation/copy/append, repeated positions, import-write guard, missing-file availability, legacy search/API regressions.
- Frontend type-check/build passes; browser checks verify both provider panels, the default inbox, unknown filter, neutral credits, native collection creation/list refresh and local audio playback.
- SQLite integrity is `ok`; zero foreign-key errors. Existing Vite native-config and Starlette/httpx warnings remain.
- `audit.json`: machine-readable consistency counts and preservation assertions.
- `browser.json`: native collection ID and browser/playback proof.
- `credits.json`: role-update counts; DB `canonical_events` holds row-level before/after evidence.
- `tests.xml`: test results.
- `before.sqlite`: consistent pre-pass identity database backup.
- `provider-consistency.png`, `review-inbox.png`, `collections.png`, `native-collection.png`: rendered evidence.
- Runtime data remains in `backend/data/identity.sqlite`; no remote writes or audio tag changes occurred.
