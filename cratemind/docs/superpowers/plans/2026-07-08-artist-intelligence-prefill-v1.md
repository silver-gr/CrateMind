# Artist Intelligence Prefill V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local artist-level LLM enrichment to CrateMind so existing library artists can be normalized, enriched in batches, surfaced as track-level prefills, reviewed in an artist dashboard, and accepted into existing `TrackDJProfile` fields.

**Architecture:** V1 adds one new persistent source of truth, `ArtistProfile`, plus one stable join key on tracks, `artist_normalized`. Background enrichment stores structured artist intelligence and raw LLM output locally. Existing track-level metadata remains authoritative; artist intelligence is exposed as advisory `artist_prefill` data on track responses and only affects `TrackDJProfile` through explicit user acceptance.

**Tech Stack:** FastAPI, SQLModel/SQLite, threaded background jobs, env-driven LLM client, React 18 + TypeScript + Vite.

---

## Global Constraints

- Artist intelligence is **suggestion-only** until explicit accept.
- No `TrackMetadataSuggestion` table in v1.
- No Last.fm, MusicBrainz, Spotify, Discogs, or scraping in v1.
- No write-back to audio files or embedded tags.
- `scene_cluster` is controlled-ish; `primary_subgenre` stays freeform/specific.
- BPM ranges only produce warnings; they do not mutate track BPM.
- Reuse existing `TrackDJProfile` fields (`psy_substyle`, `energy`, `set_role`, `notes`, `human_confirmed`) instead of inventing rival track metadata storage.
- Search/dashboard integration must use existing query-count model (`search.count`) and `?q=` deep-link pattern.
- Artist intelligence stays out of generic FTS/free-text search in v1 unless user explicitly accepts data into existing track-level fields. Query it through explicit `artist_*` tokens instead.
- Artist profiles are local user-owned intelligence and must be included in JSON backup/export for v1.
- Frontend has no dedicated test runner configured; backend gets primary automated coverage.
- Dirty worktree exists outside `cratemind/`; stage only exact CrateMind feature files.

## Verified Repo Seams

- Track-level truth store: `backend/app/models.py` (`TrackDJProfile`)
- Track list/detail + profile write path: `backend/app/api/tracks.py`
- Existing track profile writes already flow through `_apply_profile(...)` in `backend/app/api/tracks.py`, which also handles `reindex_track(...)` and `audit.log(...)`
- Existing `ProfileUpdate` / `Partial<Profile>` request shape already matches selected-field track profile writes closely, so artist accept should reuse it unless a real mismatch appears
- Scanner refresh path only updates `_FILE_COLUMNS` in `backend/app/services/scanner.py`, so derived `artist_normalized` must be explicitly maintained there or rebuilt after scan
- Scan job flow does not currently rebuild artist aggregates after import, so `ArtistProfile` rows and `track_count` will drift unless v1 adds an explicit refresh rule
- JSON backup currently exports owned metadata from `backend/app/services/backup.py`; new artist intelligence must be added there to preserve local-first safety guarantees
- JSON backup payload currently declares fixed `version: 1`; adding artist-profile data should make backup schema versioning an explicit v1 decision
- Search token engine: `backend/app/services/search.py`
- Current search query only joins `TrackDJProfile`, so `artist_*` filters require an explicit `ArtistProfile` join path
- Current `_STR_FIELDS` dispatch in `search.py` assumes only two model sources (`track` vs `profile`), so artist-intelligence filters require widening that routing logic too
- Track FTS index currently includes only track core fields, profile notes, and tags via `backend/app/db.py`
- Query-chip display parser: `frontend/src/lib/queryChips.ts`
- Query field/value labels: `frontend/src/lib/labels.ts`
- Generic job polling/status surface: `frontend/src/pages/Settings.tsx`
- Duplicate scan page also uses page-local job polling in `frontend/src/pages/Duplicates.tsx`
- `/scan/status` already acts as generic jobs-table lookup by `job_id`, so artist enrichment should reuse it instead of adding a parallel status endpoint
- `/scan/status` without `job_id` returns the latest job overall, so page-level artist polling must follow the specific returned `job.id`, not rely on “latest job” semantics
- Frontend job-kind labels already need exact string alignment with backend `Job.kind` values (for example backend `duplicate_scan` vs frontend label key `duplicates`), so `artist_enrich` should be wired by exact kind name
- Backend `Job` model has `total` and `processed`, but frontend `Job` type/UI currently only rely on `processed`, so v1 artist job UX should stay status/processed-first unless type wiring is intentionally expanded
- Dashboard currently assumes many cards are track-query counts via `api.trackCount(query)`, so artist-domain cards need a dedicated `/artists/stats` fetch path instead of fake track queries
- Dashboard `Queue` card model is track-centric (`query` + `to` -> Library), so artist-domain cards should be a separate section/model instead of being forced through the existing queue shape
- Dashboard queue-card pattern: `frontend/src/pages/Dashboard.tsx`
- Tagging flow: `frontend/src/pages/TaggingQueue.tsx`
- Current `psy_substyle` editor is UI-constrained by fixed `SUBSTYLES` options in `frontend/src/components/ProfileEditor.tsx`, and its shared `ProfileSelect` only renders listed option values cleanly
- Library deep-link `?q=` consumption: `frontend/src/pages/Library.tsx`
- Search grammar already uses `artist:` for raw `Track.artist` contains-match and supports quoted multi-word values via `shlex.split`
- Frontend `parseQueryChips(...)` currently splits on whitespace, so quoted multi-word query values are not displayed correctly yet
- Existing app pages already use URL params for deep-linkable state (`/library?q=...`, SetBuilder `?id=...`), so `/artists` should expose filter params for artist-domain dashboard/navigation links too
- Saved-search count pattern: `backend/app/api/searches.py`
- `/artists` integration points still required:
  - `frontend/src/app/App.tsx`
  - `frontend/src/components/layout/Sidebar.tsx`
  - `frontend/src/components/CommandPalette.tsx`

## Final V1 Data Contract

### `Track` additions

- `artist_normalized: str | None`

### `ArtistProfile`

- `id`
- `normalized_name`
- `canonical_name`
- `aliases_json`
- `track_count`
- `scene_cluster`
- `primary_subgenre`
- `secondary_subgenres_json`
- `typical_bpm_min`
- `typical_bpm_max`
- `energy_min`
- `energy_max`
- `set_role_hints_json`
- `confidence_label`
- `needs_review`
- `notes`
- `raw_llm_json`
- `last_enriched_at`

### `artist_prefill` payload

Expose same shape on both:

- track list rows returned by `/tracks`
- `track` object inside `/tracks/{id}` detail payload

Do not create separate list-vs-detail artist-prefill shapes.
Keep this payload compact on list endpoints; never include `raw_llm_json` or heavy evidence blobs in hot shared list responses.

- `artist_profile_id`
- `canonical_name`
- `scene_cluster`
- `primary_subgenre`
- `secondary_subgenres`
- `energy_range`
- `set_role_hints`
- `confidence_label`
- `needs_review`
- `bpm_conflict`
- `reason`

### Search token additions

- `artist_scene:<value>`
- `artist_subgenre:<value>`
- `artist_confidence:<value>`
- `artist_review:<value>`

### Acceptance mapping into `TrackDJProfile`

- `primary_subgenre` -> `psy_substyle`
- accepted energy hint -> `energy`
- accepted role hint -> `set_role`
- accepted notes -> `notes`
- any accepted write may set `human_confirmed=True`

## Shared-File Ownership

Leader only edits these files:

- `backend/app/models.py`
- `backend/app/db.py`
- `backend/app/config.py`
- `backend/app/schemas.py`
- `backend/app/main.py`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/api.ts`
- `frontend/src/app/App.tsx`
- `frontend/src/components/layout/Sidebar.tsx`
- `frontend/src/components/CommandPalette.tsx`

No worker edits these files. All workers escalate if they need a change here.

## Parallelization Map

| Lane | Files | Depends on | Notes |
| --- | --- | --- | --- |
| Leader | shared files above | — | contract, merges, routing, staging discipline |
| A. Normalize + rebuild | `backend/app/services/artist_normalizer.py`, `backend/app/services/artist_catalog.py`, `backend/app/services/scanner.py`, `backend/app/services/backup.py`, tests | Leader contract | backend normalization lane also owns ongoing maintenance of `artist_normalized` on scan/update and inclusion of artist data in JSON backup |
| B. LLM enrichment | `backend/app/artist_vocab.py`, `backend/app/services/llm_client.py`, `backend/app/services/artist_intelligence.py`, tests | Leader contract | isolated backend service lane |
| C. Artist APIs + job wiring | `backend/app/api/artists.py`, `backend/app/jobs/worker.py`, tests | Leader foundation merge | backend interface lane also owns artist background-job launch |
| D. Artist dashboard | `frontend/src/pages/Artists.tsx`, `frontend/src/components/ArtistTable.tsx`, `frontend/src/components/ArtistPrefillCard.tsx` | Leader TS/API contract | isolated frontend page lane |
| E. Track prefill UI | `frontend/src/pages/TaggingQueue.tsx`, `frontend/src/components/ProfileEditor.tsx` | Leader TS/API contract | isolated existing-UI lane |
| F. Search + dashboard | `backend/app/services/search.py`, `backend/tests/test_artist_search.py`, `frontend/src/pages/Dashboard.tsx`, `frontend/src/lib/queryChips.ts`, `frontend/src/lib/labels.ts` | Leader foundation merge | mixed lane; also owns generic artist job label/message surfacing |

## Execution Waves

### Wave 0: Leader contract + foundation stubs

- [ ] Lock final field names, token names, endpoint names, and accept mapping.
- [ ] Add leader-owned schema/database/config stubs:
  - `ArtistProfile` model
  - `artist_normalized` on `Track`
  - additive SQLite setup in `db.py`
  - LLM env settings in `config.py`
  - placeholder schemas in `schemas.py`
- [ ] Publish contract to all workers before dispatch.

**Pass/Fail:** Workers have one stable contract; no frontend/backend naming drift remains.

### Wave 1: Parallel backend service lanes

Run in parallel:

- [ ] Lane A: normalization + rebuild
- [ ] Lane B: LLM enrichment + vocab

Leader merges both lanes after completion.

**Pass/Fail:** Backend can normalize artists, rebuild artist universe from tracks, and enrich/persist artist intelligence.

### Wave 2: Backend interface lane

- [ ] Lane C starts after Wave 1 merge.
- [ ] Leader wires `artists.py` into `main.py` after lane C lands.

**Pass/Fail:** Artist list/detail/stats/rebuild/enrich/apply endpoints exist and match contract, and enrichment is exposed as normal background job work instead of ad hoc blocking request work.

### Wave 3: Parallel UI/search lanes

Run in parallel after backend contracts are stable:

- [ ] Lane D: `/artists` dashboard
- [ ] Lane E: track prefill UI in Tagging Queue and Profile Editor
- [ ] Lane F: search tokens + dashboard cards

Leader then wires route/nav/palette/API/types.

**Pass/Fail:** Artist intelligence visible across `/artists`, track views, search, and dashboard with no conflicting workflow state.

### Wave 4: Leader integration + verification

- [ ] Add TS interfaces and API client methods.
- [ ] Add `/artists` route in `App.tsx`.
- [ ] Add `/artists` nav item to sidebar.
- [ ] Add `/artists` entry to command palette.
- [ ] Stage only CrateMind feature files.
- [ ] Run agreed verification commands once implementation starts.

**Pass/Fail:** Feature reachable from UI, data flows end-to-end, no unrelated files staged.

## Task A: Artist normalization + rebuild

**Files:**
- Create: `backend/app/services/artist_normalizer.py`
- Create: `backend/app/services/artist_catalog.py`
- Modify: `backend/app/services/scanner.py`
- Modify: `backend/app/services/backup.py`
- Test: `backend/tests/test_artist_normalizer.py`
- Test: `backend/tests/test_artist_catalog.py`
- Modify/Test: `backend/tests/test_scanner.py`
- Create/Test: `backend/tests/test_backup.py`

**Worker owns:** only files above.

- [ ] Implement normalization rules:
  - Unicode normalize
  - trim whitespace
  - collapse repeated spaces
  - lowercase for key generation
  - preserve display/canonical form separately
- [ ] Implement simple collaboration parsing:
  - first artist becomes v1 join key
  - collab/feat cases can set review flags
- [ ] Implement rebuild service:
  - scan existing `tracks.artist`
  - populate `artist_normalized` on tracks
  - upsert `ArtistProfile` rows
  - compute `track_count`
- [ ] Update scanner flow so new/updated track imports maintain `artist_normalized` during scan/update work, instead of depending only on later rebuild passes.
- [ ] Define and implement post-scan artist-universe refresh behavior so new imports refresh `ArtistProfile` rows and `track_count` without requiring users to guess when to rerun rebuild.
- [ ] Extend JSON backup export so `ArtistProfile` rows are included in portable metadata backups.
- [ ] Update JSON backup schema versioning intentionally when artist-profile export fields are added (bump version or document additive compatibility explicitly in code/tests).
- [ ] Add backend tests using `db` fixture:
  - casing alias collapse
  - collab parsing does not crash
  - rebuild creates expected artist rows and counts
  - scan/update path maintains `artist_normalized` for newly imported and refreshed tracks
  - JSON backup includes artist profiles
  - backup version behavior is asserted

**Acceptance:**
- `ATYYA`, `AtYyA`, `Atyya` collapse to one normalized artist.
- Rebuild is repeatable and safe to re-run.
- Collab strings remain reviewable instead of silently misclassified.
- `artist_normalized` does not drift on future scans.
- `ArtistProfile` universe and `track_count` stay fresh after library scans.
- Artist intelligence survives JSON backup/export, not only SQLite snapshots.
- Backup schema evolution for artist intelligence is explicit, not accidental.

## Task B: LLM enrichment + vocabulary

**Files:**
- Create: `backend/app/artist_vocab.py`
- Create: `backend/app/services/llm_client.py`
- Create: `backend/app/services/artist_intelligence.py`
- Test: `backend/tests/test_artist_intelligence.py`

**Worker owns:** only files above.

- [ ] Add small controlled vocabulary list for `scene_cluster`.
- [ ] Implement env-driven LLM client abstraction:
  - model name
  - API key/env lookup
  - optional base URL if using OpenAI-compatible provider
- [ ] Implement batch enrichment service:
  - take N artists
  - ask for structured JSON
  - clamp `scene_cluster` into allowed list
  - keep `primary_subgenre` freeform/specific
  - persist raw response payload as `raw_llm_json`-ready dict/string
- [ ] Implement review/confidence derivation:
  - parse failure -> review
  - missing/broad genre -> lower confidence
  - mixed clusters -> review
- [ ] Add backend tests with mocked provider:
  - happy-path parse
  - malformed JSON fallback
  - unknown cluster normalization to allowed fallback

**Acceptance:**
- Batch enrichment works without external metadata providers.
- Bad provider output does not crash job flow.
- `raw_llm_json` remains available for later reprocessing.

## Task C: Artist APIs

**Files:**
- Create: `backend/app/api/artists.py`
- Modify: `backend/app/jobs/worker.py`
- Test: `backend/tests/test_artists_api.py`

**Worker owns:** only files above.

- [ ] Implement `GET /artists`:
  - filters by confidence/review if present
  - sort by `track_count desc` by default
- [ ] Implement `GET /artists/{id}`
- [ ] Implement `POST /artists/rebuild`
- [ ] Implement `POST /artists/enrich`
- [ ] Implement `GET /artists/stats`
- [ ] Implement explicit apply endpoint:
  - `POST /tracks/{id}/accept-artist-prefill`
  - accepts selected fields only
- [ ] Reuse existing partial-profile request shape (`ProfileUpdate` / `Partial<Profile>`) for artist accept payloads unless artist-specific data proves a separate request model is necessary.
- [ ] Implement artist-accept writes by reusing existing track-profile write path semantics (`_apply_profile(...)` or exact equivalent), so acceptance preserves audit logging and FTS reindex behavior.
- [ ] Run enrichment through existing `Job`/worker pattern with new job kind (for example `artist_enrich`) so current polling surfaces can understand it.
- [ ] Reuse existing `/scan/status?job_id=...` polling path for artist enrichment jobs; do not add a separate artist-job status endpoint in v1.
- [ ] Poll the exact returned enrichment `job.id` from `/artists` UI flows; do not poll bare “latest job” status because other scans/analyzes may be running.
- [ ] Add background worker launcher for artist enrichment in `backend/app/jobs/worker.py`, following existing `start_*` / `_run_*` pattern.
- [ ] Extend track response assembly so `artist_prefill` is attached consistently to:
  - list rows from `/tracks`
  - detail payload `track` object from `/tracks/{id}`
- [ ] Keep list-surface `artist_prefill` compact enough for existing high-fanout `api.listTracks(...)` consumers (Library, Tagging Queue, SetBuilder candidates, Flow picker, Dashboard) and reserve heavy raw artist payloads for artist/detail APIs only.
- [ ] Add backend API tests via `client` fixture:
  - list returns sorted artists
  - stats payload stable
  - apply endpoint only writes requested fields
  - enrich endpoint returns a `Job` row and can be polled
  - list and detail surfaces expose same `artist_prefill` shape

**Acceptance:**
- API contract supports `/artists`, dashboard counts, and explicit track acceptance.
- Apply endpoint never silently overwrites unrelated `TrackDJProfile` fields.
- Enrichment is pollable as standard `Job` row via existing job-status endpoint.
- `backend/app/jobs/worker.py` owns actual threaded launch path for artist enrichment, not ad hoc inline request logic.
- Artist-accept writes preserve existing audit-log and track-reindex behavior.
- `artist_prefill` stays lightweight on shared list endpoints.

## Task D: Artist dashboard UI

**Files:**
- Create: `frontend/src/pages/Artists.tsx`
- Create: `frontend/src/components/ArtistTable.tsx`
- Create: `frontend/src/components/ArtistPrefillCard.tsx`

**Worker owns:** only files above.

- [ ] Build thin `/artists` page using existing page patterns from `Crates`/`Library`.
- [ ] Make `/artists` filter state URL-addressable and reactive (Library-style `useSearchParams` pattern, not one-time parsing) so dashboard artist cards can deep-link into exact filtered artist views and later param changes re-drive the page state.
- [ ] Show sortable artist list with:
  - artist name
  - track count
  - scene cluster
  - primary subgenre
  - confidence
  - review state
- [ ] Add actions:
  - enrich selected/all pending
  - inspect row/detail
  - open library via exact quoted raw-artist filter such as `?q=artist:\"Carbon Based Lifeforms\"` for row-level artist browsing, or via `artist_*` intelligence tokens for facet browsing
- [ ] Reuse existing job polling/toast pattern when launching enrichment so background status UX feels native.
- [ ] Reuse existing page-local polling pattern for jobs; do not introduce a shared polling abstraction in v1 unless needed by the implementation already underway.
- [ ] Keep artist enrichment progress UI aligned with current frontend `Job` shape: status + processed count first, unless leader explicitly expands shared `Job` typing to expose `total`.
- [ ] Keep copy clear that profiles are suggestions.

**Acceptance:**
- `/artists` is useful without becoming separate workflow engine.
- Navigation into Library reuses existing deep-link pattern.
- Multi-word artist names deep-link correctly without token parsing ambiguity.
- Artist-domain dashboard cards can deep-link into exact filtered `/artists` states.
- `/artists` responds to URL param changes the same way Library does, rather than only reading filters on first render.

## Task E: Track prefill UI

**Files:**
- Modify: `frontend/src/pages/TaggingQueue.tsx`
- Modify: `frontend/src/components/ProfileEditor.tsx`

**Worker owns:** only files above.

- [ ] Render `artist_prefill` summary near existing track facts/profile controls.
- [ ] Show BPM mismatch warning when artist range conflicts with track BPM/analyzed BPM.
- [ ] Add explicit accept actions for selected fields:
  - subgenre
  - energy
  - set role
  - notes
- [ ] Adjust `ProfileEditor` handling for `psy_substyle` so accepted artist subgenres can be displayed and edited even when they are more specific than the current fixed `SUBSTYLES` list; do not leave the select in a broken/blank state for unknown saved values.
- [ ] Compare current saved profile values against `artist_prefill` after refresh/optimistic update so already-applied suggestions do not keep rendering as if still pending.
- [ ] Keep existing optimistic-update pattern after accept.
- [ ] Make “suggestion only” status visible.

**Acceptance:**
- Prefill is visible in both rapid queue flow and detailed editor flow.
- No artist data writes occur without explicit user action.
- Accepted artist subgenres are not lost or blocked by a too-small frontend preset list.
- Arbitrary accepted `psy_substyle` values round-trip through the editor cleanly.
- Already-accepted artist suggestions render as applied/neutral state instead of stale actionable CTA.

## Task F: Search + dashboard integration

**Files:**
- Modify: `backend/app/services/search.py`
- Test: `backend/tests/test_artist_search.py`
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/lib/queryChips.ts`
- Modify: `frontend/src/lib/labels.ts`

**Worker owns:** only files above.

- [ ] Extend search engine with artist intelligence tokens:
  - `artist_scene`
  - `artist_subgenre`
  - `artist_confidence`
  - `artist_review`
- [ ] Extend `_build_query(...)` join strategy so `artist_*` filters read from `ArtistProfile` via persisted `Track.artist_normalized -> ArtistProfile.normalized_name`, instead of guessing from track/profile fields alone.
- [ ] Widen `_STR_FIELDS`/field-routing logic beyond current `track` vs `profile` assumption so artist-intelligence string filters resolve against the correct joined model.
- [ ] Ensure token semantics target artist intelligence, not confirmed track truth.
- [ ] Make frontend query-chip parsing quote-aware enough to mirror backend handling for quoted multi-word values such as `artist:\"Carbon Based Lifeforms\"` and `artist_scene:\"psybient / psychill\"`.
- [ ] Keep artist intelligence out of generic FTS/free-text matching in v1; do not inject suggestion-only artist fields into `track_search` before explicit acceptance.
- [ ] Extend frontend query-chip parsing and labels so artist tokens render as readable chips in Library/Crates and any UI that calls `parseQueryChips(...)`.
- [ ] Extend generic job label/message translation for artist enrichment job kind using exact backend `Job.kind` strings, so Settings and any toast/poll surface do not show raw or mismatched internal strings.
- [ ] Add dashboard cards/counts for:
  - unenriched artists
  - artists needing review
  - tracks with artist prefill
  - artist BPM conflicts
- [ ] Split dashboard data loading between track-query counts and artist-domain stats; do not force artist counts through `api.trackCount(query)` when they are fundamentally about artist rows.
- [ ] Route track-domain cards into Library query strings and artist-domain cards into `/artists` with explicit filter params where appropriate.
- [ ] Model artist-dashboard cards separately from existing track-centric `Queue` cards when that keeps code clearer, instead of twisting artist destinations/counts into `query`-driven Library cards.
- [ ] Add backend search tests proving tokens count/filter correctly.

**Acceptance:**
- Search counts support dashboard and saved-query style metrics.
- Artist filters do not collide semantically with existing `substyle:` track truth.
- Artist tokens display as human-readable chips instead of raw token strings.
- Artist enrichment job kind/message render cleanly in existing generic status surfaces.
- Free-text search semantics stay unchanged until user accepts artist-derived values into existing track/profile fields.
- Quoted multi-word artist/intelligence queries display correctly in frontend chips instead of being split into broken fragments.

## Leader Integration Checklist

- [ ] Add final schemas/types once worker lanes land.
- [ ] Add `artist_prefill` to `Track` interface and keep `TrackDetail` aligned with backend detail payload shape.
- [ ] Wire `artists.py` router into `backend/app/main.py`.
- [ ] Add API client methods for artist list/get/stats/rebuild/enrich/apply.
- [ ] Add `/artists` route in `frontend/src/app/App.tsx`.
- [ ] Add `/artists` item to `Sidebar`.
- [ ] Add `/artists` item to `CommandPalette`.
- [ ] Resolve any payload drift in one merge pass.
- [ ] Stage only:
  - `backend/app/**`
  - `backend/tests/**`
  - `frontend/src/**`
  - `docs/superpowers/plans/2026-07-08-artist-intelligence-prefill-v1.md`

## Blockers and Mitigations

### Blocker: unclear LLM provider

- Mitigation: thin OpenAI-compatible adapter behind `llm_client.py`.
- Do not block schema/UI work on provider choice.

### Blocker: expensive runtime fuzzy joins

- Mitigation: persist `artist_normalized` on tracks in foundation phase.

### Blocker: ambiguous artist strings

- Mitigation: v1 first-artist join key + `needs_review=True` for ambiguous values.

### Blocker: dirty parent worktree

- Mitigation: leader stages exact file paths only; never `git add .` from repo root.

### Blocker: frontend/backend contract drift

- Mitigation: leader freezes payload names before Wave 1 and owns all shared wiring files.

## Not in V1

- Last.fm / MusicBrainz / Spotify / Discogs
- dedicated suggestion table
- bulk accept matrix
- learning loop
- provenance-heavy UI
- complex artist review lifecycle

## Recommended PR Sequence

### PR 1: `artist-foundation`

- leader foundation stubs
- Task A

### PR 2: `artist-enrichment`

- Task B
- leader integration for config/schema persistence

### PR 3: `artist-api-and-prefill`

- Task C
- leader track payload and explicit-accept wiring

### PR 4: `artist-ui-search-dashboard`

- Tasks D, E, F
- leader route/nav/palette/API/type wiring

## Suggested Worker Brief Format

Each worker brief should include:

- exact goal
- exact owned files
- forbidden shared files
- final contract summary
- acceptance criteria
- escalation rule: stop and report instead of freelancing into leader-owned files

## Verification Plan Once Execution Starts

Because user did not request implementation yet, these are deferred until execution:

- Backend targeted pytest per lane
- Combined backend pytest for new artist tests
- Frontend build only if/when implementation phase begins
- Manual smoke:
  - rebuild artists
  - enrich artists
  - open `/artists`
  - open Library/Tagging Queue track with `artist_prefill`
  - accept selected fields into `TrackDJProfile`

## Stop Conditions

- Contract locked
- Waves and ownership frozen
- Plan saved as durable artifact
- No unresolved planning ambiguity remains that would block worker dispatch
