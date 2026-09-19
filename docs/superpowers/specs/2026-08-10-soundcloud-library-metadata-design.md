# SoundCloud Library Metadata Design

## Goal

Enrich CrateMind library tracks with metadata from the user's authenticated SoundCloud likes without modifying local audio files or overwriting local tags. Confirm only strong matches. Send uncertain matches to a review queue. Display confirmed SoundCloud metadata inside the existing track-detail UI.

## Success criteria

- Ego-browser reads every page of the authenticated SoundCloud likes collection through SoundCloud's paginated API rather than DOM infinite-scroll scraping.
- CrateMind stores provider snapshots, match provenance, confidence, and review decisions in its canonical SQLite database.
- Re-running an import updates changing counters and remains idempotent.
- Only direct-identity or strong artist/title/duration evidence creates an automatic match.
- Ambiguous candidates remain unlinked until manually accepted.
- Confirmed metadata appears in the track-detail panel in both Python-backend and Deno-desktop runtimes.
- Review UI supports accept and reject actions with clear evidence.
- No SoundCloud credentials, session cookies, or access tokens enter the repository or database.
- No source audio file is moved, deleted, retagged, or otherwise changed.

## Observed SoundCloud source

Authenticated likes load from a cursor-paginated `track_likes` API response. Each collection item contains a like timestamp plus a complete track object. The observed object includes:

- stable track ID and URN;
- title, permalink, permalink URL, duration, and full duration;
- uploader ID, username, and profile URL;
- genre, tag list, description, label, release date, and publisher metadata;
- upload/display date and liked-at timestamp;
- likes, reposts, plays, comments, and downloads;
- artwork and waveform URLs;
- availability, streamability, and download flags.

The response includes `next_href`, so extraction must follow that cursor until it becomes null. UI scrolling and waveform parsing are unnecessary.

## Chosen architecture

Use provider-specific relational tables with typed columns for stable fields and raw JSON for forward compatibility. Do not place a single opaque JSON blob on `tracks`, and do not add dozens of SoundCloud columns to the core track table.

### `soundcloud_tracks`

One current provider snapshot per SoundCloud track:

- `soundcloud_track_id INTEGER PRIMARY KEY`
- `urn TEXT`
- `permalink_url TEXT`
- `title TEXT`
- `uploader_id INTEGER`
- `uploader_username TEXT`
- `uploader_permalink_url TEXT`
- `duration_ms INTEGER`
- `full_duration_ms INTEGER`
- `genre TEXT`
- `tag_list TEXT`
- `description TEXT`
- `label_name TEXT`
- `release_date TEXT`
- `created_at TEXT`
- `display_date TEXT`
- `liked_at TEXT`
- `likes_count INTEGER`
- `reposts_count INTEGER`
- `playback_count INTEGER`
- `comment_count INTEGER`
- `download_count INTEGER`
- `downloadable BOOLEAN`
- `artwork_url TEXT`
- `waveform_url TEXT`
- `publisher_metadata_json TEXT`
- `raw_json TEXT NOT NULL`
- `available BOOLEAN NOT NULL DEFAULT 1`
- `last_seen_run_id TEXT`
- `fetched_at TEXT NOT NULL`

Indexes cover normalized matching fields where useful, uploader ID, and availability. Provider values remain provider values; none replace `tracks.artist`, `tracks.title`, `tracks.genre`, or other local metadata.

### `track_soundcloud_matches`

One confirmed SoundCloud identity per local track:

- `track_id INTEGER PRIMARY KEY REFERENCES tracks(id)`
- `soundcloud_track_id INTEGER NOT NULL REFERENCES soundcloud_tracks(soundcloud_track_id)`
- `confidence REAL NOT NULL`
- `method TEXT NOT NULL`
- `reasons_json TEXT NOT NULL`
- `matched_at TEXT NOT NULL`
- `confirmed_at TEXT`

`soundcloud_track_id` is not unique. Duplicate local files may legitimately point to the same SoundCloud track. A local track may have only one confirmed SoundCloud identity.

### `soundcloud_match_candidates`

Persistent candidate and review-decision state:

- `track_id INTEGER NOT NULL REFERENCES tracks(id)`
- `soundcloud_track_id INTEGER NOT NULL REFERENCES soundcloud_tracks(soundcloud_track_id)`
- `score REAL NOT NULL`
- `reasons_json TEXT NOT NULL`
- `status TEXT NOT NULL` with `pending`, `accepted`, or `rejected`
- `evaluated_at TEXT NOT NULL`
- `decided_at TEXT`
- composite primary key `(track_id, soundcloud_track_id)`

Rejected pairs are retained so later refreshes do not suggest the same bad match again.

## Import data flow

1. Ego-browser reuses the authenticated task space and requests the already-discovered likes endpoint from page context.
2. Extraction follows `next_href` until exhausted and sends bounded batches to local CrateMind.
3. Each import run receives a random `run_id`. Every observed track records that ID.
4. Each batch upserts `soundcloud_tracks` in one transaction and regenerates affected match candidates.
5. Only the final successful call marks the run complete. At that point, previously imported likes not seen in the completed run may be marked unavailable. An interrupted run never marks old data unavailable.
6. Confirmed links retain their identity while counters, URLs, dates, artwork, and raw snapshots refresh.
7. Import returns cumulative counts for received items, inserted snapshots, refreshed snapshots, automatic matches, pending reviews, unmatched likes, malformed items, and errors.

SoundCloud authentication remains inside ego-browser. CrateMind receives only track metadata and import-run identifiers.

## Matching policy

Wrong identity is worse than missing metadata. Automatic matching uses explicit gates, not score alone.

### Normalization

- Unicode-normalize and case-fold.
- Collapse punctuation and whitespace.
- Remove common filename/title noise such as leading track numbers, bitrate/download markers, file extensions, and bracketed BPM annotations.
- Normalize common featuring separators while preserving artist tokens.
- Prefer `publisher_metadata.artist` as SoundCloud artist when present; otherwise use uploader username.
- Preserve original values beside normalized comparison values.

### Automatic confirmation

Create an automatic link only when one of these rules passes:

1. Local metadata contains the exact SoundCloud track ID or canonical permalink URL.
2. Normalized artist and title strongly agree, duration differs by no more than three seconds, and no conflicting artist/title evidence exists.

Generic fuzzy score never auto-confirms a match by itself.

### Review candidates

Generate pending candidates when title/artist similarity and duration make the pair plausible but an automatic rule does not pass. Reasons must be human-readable, for example:

- exact normalized title;
- artist token overlap;
- uploader differs from publisher artist;
- duration difference of 4.2 seconds;
- remix/version token mismatch;
- missing local or provider duration.

Low-confidence pairs remain unmatched and do not clutter the queue. Accepted candidates create or replace the confirmed match and mark competing candidates non-pending. Rejected candidates remain rejected.

## Local API contract

Python FastAPI and Deno desktop implement equivalent routes:

- `POST /api/soundcloud/import-batch`
  - accepts `run_id`, items, and `complete`;
  - validates item shape and uses a transaction per batch;
  - returns import and matching counters.
- `GET /api/soundcloud/summary`
  - returns snapshot, confirmed, pending, rejected, unmatched, and unavailable counts.
- `GET /api/soundcloud/review?limit=&offset=`
  - returns local track, SoundCloud candidate, score, and reasons.
- `POST /api/soundcloud/review/{track_id}/{soundcloud_track_id}/accept`
  - confirms selected candidate with manual provenance.
- `POST /api/soundcloud/review/{track_id}/{soundcloud_track_id}/reject`
  - persists rejection and advances queue.

`GET /api/tracks/{track_id}` gains additive fields:

- `soundcloud`: confirmed provider snapshot plus match provenance, or null;
- `soundcloud_candidates`: pending candidates for this local track, normally empty.

List endpoints do not embed full SoundCloud payloads in this scope.

## Frontend design

### Track-detail card

Add a `SoundCloud` card near the existing identity header in `ProfileEditor`.

Confirmed state shows:

- artwork;
- provider title and artist/uploader;
- genre;
- upload and liked dates;
- duration;
- likes, reposts, plays, and comments;
- confidence/method badge;
- external SoundCloud link.

Provider copy remains read-only. Missing counts render as unavailable rather than zero. Broken artwork falls back to existing CrateMind artwork.

Pending state shows best candidate, score evidence, and a link to review. Unmatched state stays compact and does not imply failure.

### Review queue

Add a SoundCloud review entry point in Library with pending-count badge. A sheet or dedicated panel shows local and provider identities side by side:

- artist and title;
- filenames/permalink;
- local and provider durations plus delta;
- upload/liked dates;
- score reasons;
- Accept and Reject actions.

All new user-facing copy is Greek except established names and terms such as SoundCloud, BPM, URL, and ID.

## Failure handling and safety

- Malformed items are rejected individually with bounded error details; valid batch items still import.
- Batch transaction failure preserves prior snapshots and matches.
- Interrupted pagination preserves completed batches but cannot mark unseen tracks unavailable.
- Refresh failures preserve last good snapshots and confirmed matches.
- A track removed from SoundCloud remains visible as unavailable rather than silently losing provenance.
- Candidate generation never writes local tags or files.
- Accept/reject endpoints validate both local and provider rows before changing review state.
- Import payload limits prevent accidental oversized requests.
- Raw JSON excludes browser credentials and request headers.
- No new dependency is required.

## Runtime parity and migration

Python SQLModel definitions and `ensure_track_columns`-style startup migration must create the new tables idempotently for existing databases. Deno desktop adds an ordered migration after version 1 and mirrors row types plus API behavior. Both runtimes target the same table and field names so the shared SQLite database remains canonical.

Existing unrelated BPM-analysis work in the dirty worktree must be preserved. Changes should avoid rewriting overlapping files beyond focused additions.

## Validation scope

Repository guidance forbids proactive tests, builds, lint, typecheck, screenshots, or visual checks unless requested. Default validation therefore consists of:

- pre-edit GitNexus impact analysis for every changed symbol;
- schema and migration inspection;
- targeted API-shape review across Python, Deno, and frontend types;
- representative matcher examples from real local metadata and imported SoundCloud payloads;
- targeted diffs and GitNexus `detect_changes()`;
- real authenticated likes import after implementation;
- reported counts for imported, confirmed, pending-review, unmatched, malformed, and unavailable items;
- source inspection confirming several imported matches appear through track-detail API data.

No tests or builds run unless the user explicitly expands validation scope. UI runtime appearance remains unverified unless visual validation is separately requested.

## Completion condition

Implementation is complete when full likes pagination finishes, provider snapshots persist idempotently, high-confidence links follow the strict gates, pending candidates can be accepted/rejected, confirmed metadata appears in track detail for both runtime paths, source audio remains untouched, and final import/matching counts are reported with validation gaps.
