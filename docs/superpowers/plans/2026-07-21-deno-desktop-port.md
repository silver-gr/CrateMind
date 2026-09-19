# CrateMind Deno Desktop Port — Parallel Implementation Plan (v3, post Codex + Opus reviews)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model:** Designed for **parallel Sonnet 5 sub-agents**. Tasks within a wave run concurrently; waves are sequential barriers. Every task owns a disjoint set of files (Ownership Map). The coordinator (main session) dispatches agents, reviews between waves, and commits per wave.
>
> **v2 changelog:** incorporates Codex (gpt-5.6-sol) review pass 1 — see "Review changelog" at the end for accepted/rejected findings.
> **v3 changelog:** incorporates Opus validation pass 2 (verdict: REVISE, 3 items — all verified against source and applied): recommend-next context assembly moved to T8 with a corrected T3 binding (`recommend(db, ctx, limit)` — `RecommendQuery` alone cannot build the context, `sets.py:183-219` does); T11 accept-prefill inlines its own profile-apply (Python's `artists.py:13` cross-import of `_apply_profile` would violate Wave-2 isolation); A11 pre-dispatch stub/import gate added; plus minor notes (desktop-window smoke test A12, both pair-note reason legs, `artist_prefill` nested booleans, `roles` string keys, `exportCsv` db param justification).

**Goal:** A self-contained Deno Desktop app that serves the existing CrateMind React UI and a full TypeScript port of the FastAPI backend from one `Deno.serve()` process, storing everything in local SQLite (`node:sqlite`), streaming local audio with Range support, and making zero external API calls.

**Architecture:** `desktop/main.ts` boots config → SQLite (WAL, FTS5-verified, ordered migrations, launch snapshot via `VACUUM INTO`) → same-origin router (`/api/*` + `/api/tracks/:id/audio` + SPA fallback from `frontend/dist`). Business logic ported 1:1 from `backend/app` except the Deliberate Divergences listed below. Frontend is already same-origin (`BASE = "/api"`) — **no frontend changes**.

**Tech Stack:** Deno 2.9 (`deno desktop` CLI present), `node:sqlite` `DatabaseSync` (FTS5 verified working 2026-07-21), `jsr:@std/http/file-server`, `URLPattern` routing, `Deno.Command` for ffprobe/fpcalc sidecars, Deno test runner.

## Global Constraints

Every task's requirements implicitly include all of these:

- **Data safety (product invariant):** never delete/move/retag source audio; scans read-only; no beatgrid/cue/DJ-app DB access; duplicate handling never auto-deletes. Scanner tests must assert source files' bytes+mtime unchanged after a scan.
- **No external runtime API calls.** No cloud, auth, analytics, telemetry, CORS.
- **No separate FastAPI process; no Python spawning.** `backend/` and `frontend/` are **read-only reference** for all agents.
- Audio served **only by DB track id** (`/api/tracks/:id/audio`); never by arbitrary path. AIFF/AIF stays 415.
- **Parameterized SQL only.** Column/operator names only from hard-coded maps.
- **`node:sqlite` binding rule:** booleans bound as 0/1, `undefined`→`null` — always via foundation `bindable()`. **Row types model SQLite reality:** boolean-ish columns are typed `0 | 1` (or `| null`) in row interfaces; API serializers convert to real JSON booleans before responding (Python `model_dump()` emits booleans — frontend expects them). Use foundation `toBools(row, keys)`.
- **Timestamps:** ISO-8601 UTC with `T`/`Z` via `nowIso()`. Fresh DB only; Python-DB import out of scope.
- **Error shape:** API errors are `{"detail": string}` JSON — EXCEPT the audio streaming 416 (empty body + `Content-Range: bytes */N`, per HTTP semantics). Router returns 405 `{"detail":"Method not allowed"}` when the path matches a route with a different method.
- **Mutation-route hardening (all POST/PATCH/DELETE):** server binds 127.0.0.1 only; `dispatch` centrally rejects mutating requests whose `Host` header is not the bound host:port (403) and whose content-type is not `application/json` (415) — BEFORE route matching, so body-less mutations (`/scan/fingerprint`, `/scan/duplicates`, `/artists/rebuild`) are covered too. `readJson` keeps its own 415 as defense-in-depth. Consequence for tests: every mutating test request must send `content-type: application/json` and a correct `host` header.
- **API contract source of truth:** the **Contract Matrix below (verified against Python 2026-07-21)** + the Python routers + `frontend/src/lib/api.ts` + `frontend/src/lib/types.ts`. Matrix wins over prose; Python wins over both if they conflict — report the conflict, don't guess.
- **Request-body types:** every field with a Python default is optional in TS; each route applies Python's defaults explicitly after `readJson` (no validation framework — small per-route defaulting + field whitelists).
- Tests: own temp dir via `Deno.makeTempDir()`; never real app data; ffprobe/fpcalc tests `ignore` when binary missing. **All deno commands run from `desktop/`** (`cd desktop && deno test -A tests/<own>.test.ts`) so `deno.json` imports/lock apply.
- **Wave 2 test isolation:** route types + `dispatch` live in the frozen, dependency-free `src/api/dispatch.ts` — route modules, `seed.ts`, `tests/helpers.ts`, and all tests import `RouteDef`/`AppContext`/`dispatch` from **`dispatch.ts`, NEVER `router.ts`** (`router.ts` statically imports every sibling route module; importing it transitively type-checks concurrently-edited files). API tests use `dispatch(ownRoutes, req, ctx)` with ONLY the task's own route array. Workers run `deno check` only on their own files (`deno check src/api/<own>.ts tests/<own>.test.ts`), not `main.ts`. Coordinator checks `main.ts` + full suite at wave barriers.
- `desktop/deno.lock` is owned by T0/coordinator and committed; workers run with `--frozen` lockfile (the `-A` test task includes it via deno.json config).
- UI copy stays Greek (moot — no frontend edits).
- Deno-style TS, `deno check` clean on owned files.

## Deliberate Divergences from Python (documented, intentional)

| Area | Python | Desktop port | Why |
|------|--------|--------------|-----|
| `/api/scan/analyze` | 400 without ffmpeg, else librosa/scipy job | **501** always | DSP stack unportable |
| `/api/artists/enrich` | LLM call | **501** always | No external calls |
| Export `filename` | `out_dir / filename` — absolute/`../` escapes possible | Reject any `filename` containing path separators, `..`, or leading `/`~ (400); canonical result must stay inside `exportsDir` — **all four formats incl. json-backup** | Local security |
| Saved-search seeds | none | `runSeeds` inserts guide §14 defaults incl. "New Untagged" (insert-if-name-missing, idempotent) | Guide requirement |
| Timestamps | Python space-separated UTC | ISO-8601 `T`/`Z` | Fresh DB |
| Audit log | writes on some mutations | omitted v1 (note in code) | Scope |
| Unknown method on known path | FastAPI 405 | 405 (matched) | Parity kept |
| Malformed JSON body | FastAPI 422 | 400 `{detail}` | Simpler; frontend only reads `.detail` |
| Lone `+`/`-` numeric spec (e.g. `energy:+`) | uncaught `ValueError` → 500 | filter silently ignored | Python edge-case bug, not behavior worth porting (T1) |
| Empty export request (`{}` — dashboard Export) | 400 "no tracks to export" | exports whole non-missing library | Pre-existing app bug; dashboard sends `{}` |
| `POST /api/import/json-backup` | (does not exist) | restores v2 backup taste metadata onto scanned library (path→full_hash→quick_hash matching, idempotent, DB-only) | User-requested desktop feature; dashboard Import button wired to it (frontend `api.ts` + `Dashboard.tsx` changed post-parity) |
| Library roots without env | env only | `${dataDir}/config.json` `library_roots` fallback (env wins; template auto-created) | Finder launches carry no shell env |
| Mutation Host guard | n/a (CORS middleware) | loopback-hostname check (port not pinned) | Packaged runtime auto-binds serve to its own port |

Everything else — including odd Python behaviors — is ported as-is: `200 {"deleted":true}` / `{"removed":true}` deletes, **no** set-position compaction on removal, reorder response `{set_id, order}`, fingerprint-missing → 400, `-untagged` falling through to FTS exclusion, silently-ignored invalid numeric filters, NULL-row exclusion under negated profile criteria.

## Contract Matrix (verified against Python source 2026-07-21)

Legend: body defaults applied server-side. All responses JSON unless noted. `TrackListRow` = `Track` model_dump + `energy`, `darkness`, `set_role`, `artist_prefill` (from `_list_payload`, `tracks.py`).

| Method+Path | Query/body | Success | Response shape |
|---|---|---|---|
| GET /api/health | — | 200 | `{status, library_roots[], ffprobe:bool, fpcalc:bool, ffmpeg:bool, db}` |
| GET /api/settings | — | 200 | `{library_roots[], output_dir, db_path, backup_dir, ffprobe, fpcalc, ffmpeg}` (paths/strings, per `main.py`) |
| GET /api/tracks | `q?`, `limit=200` (max 5000), `offset=0` | 200 | `TrackListRow[]` |
| GET /api/tracks/search | `q=""`, `limit=200`, `offset=0` | 200 | `TrackListRow[]` |
| GET /api/tracks/count | `q=""` | 200 | `{count}` |
| GET /api/tracks/:id | — | 200/404 | `_track_payload` — read `tracks.py` (track + profile + tags + artist_prefill) |
| GET /api/tracks/:id/audio | `Range?` | 200/206/416/404/410/415 | bytes; 416 empty body + `Content-Range: bytes */N` |
| PATCH /api/tracks/:id/profile | ProfileUpdate (all optional) | 200/404 | profile model_dump (booleans as booleans) |
| POST /api/tracks/:id/play | PlayLog (all optional) | 200/404 | read `tracks.py` log_play return |
| POST /api/tracks/batch-profile | `{track_ids[], profile}` | 200 | `{updated}` |
| GET /api/searches | — | 200 | `[{...SavedSearch, count}]` — verify count field name in `searches.py:_payload` |
| POST /api/searches | `{name, query, description?, pinned=false}` | 200 | payload row |
| PATCH /api/searches/:id | partial | 200/404 | payload row |
| DELETE /api/searches/:id | — | 200/404 | `{"deleted": true}` |
| GET /api/searches/:id/tracks | `limit=300` | 200/404 | `Track[]` (plain model_dump — no list enrichment) |
| GET /api/sets · POST /api/sets | SetCreate | 200 | read `sets.py` |
| GET /api/sets/:id | — | 200/404 | set + ordered tracks (read `sets.py`) |
| POST /api/sets/:id/tracks | `{track_id, position?, note?}` | 200/404 | read `sets.py` |
| PATCH /api/sets/:id/tracks/reorder | `{ordered_track_ids[]}` | 200/404 | `{set_id, order}`; two-pass position rewrite (+100000) in one tx |
| DELETE /api/sets/:id/tracks/:trackId | — | 200/404 | `{"removed": true}`; NO compaction |
| GET /api/sets/:id/analysis | — | 200/404 | port `sets.py` analysis verbatim |
| POST /api/sets/:id/recommend-next | RecommendQuery (defaults: approved_only=false, need_bridge=false, limit=20) | 200/404 | **flat** `[{track_id, artist, title, bpm, key, bpm_is_analyzed, key_is_analyzed, energy, set_role, personal_status, score, reasons[]}]` |
| POST /api/sets/:id/log-play | PlayLog | 200/404 | `{tracks_logged}` |
| GET /api/pair-notes | `track_id?` | 200 | PairNote rows (read `sets.py:244`) |
| POST /api/pair-notes | PairNoteCreate | 200 | row |
| GET /api/tags · POST /api/tags | TagCreate | 200 | `tags.py` |
| POST /api/tracks/:id/tags | `{tag_id?\|name?}` | 200/404 | `tags.py` |
| DELETE /api/tracks/:id/tags/:tagId | — | 200/404 | `tags.py` return |
| GET /api/duplicates | `status="needs_review"` | 200 | `[{id, reason, status, tracks: [{track_id, role, artist, title, duration, bpm, extension, absolute_path}]}]` |
| POST /api/duplicates/:groupId/resolve | DuplicateResolve (status="resolved", roles={}) | 200/404 | `duplicates.py` |
| POST /api/scan/start | `{roots?}`; no roots configured → 400 | 200 | Job model_dump |
| POST /api/scan/fingerprint | — ; no fpcalc → **400** | 200 | Job |
| POST /api/scan/analyze | — | **501** | `{detail}` |
| POST /api/scan/duplicates | — | 200 | Job |
| GET /api/scan/status | `job_id?` | 200/404 | single `Job` or `null` (latest by id desc when no job_id) |
| POST /api/export/m3u · /csv | ExportRequest (overwrite=false); empty tracks → 400; exists+no-overwrite → 409 | 200 | `{path, count}` |
| POST /api/export/markdown | requires set_id (400), set 404 | 200 | `{path, count}` |
| POST /api/export/json-backup | filename?; **always overwrites** | 200 | `{path}` (no count) |
| GET /api/artists (+filters) · /stats · /:id | see `artists.py` | 200 | `artists.py` shapes |
| POST /api/artists/rebuild | — | 200 | `artists.py` |
| POST /api/artists/enrich | — | **501** | `{detail}` |
| POST /api/artists/tracks/:id/accept-prefill | Partial profile | 200/404 | profile |

Route ordering: literal before `:param` within each family (`/tracks/search`, `/tracks/count`, `/tracks/batch-profile` before `/tracks/:id`; `/artists/stats`, `/artists/rebuild`, `/artists/enrich`, `/artists/tracks/...` before `/artists/:id`).

## Parallel-Agent Rules (conflict avoidance)

1. **Ownership Map is law.** Create/edit ONLY your task's files. Reading anything is fine.
2. **Frozen after Wave 0 (as amended by coordinator):** `desktop/deno.json`, `desktop/deno.lock`, `desktop/main.ts`, `desktop/src/types/models.ts`, `desktop/src/db/database.ts`, `desktop/src/db/schema.sql`, `desktop/src/db/migrations.ts`, `desktop/src/services/config.ts`, `desktop/src/services/appPaths.ts`, `desktop/src/utils/http.ts`, `desktop/src/utils/time.ts`, `desktop/src/api/dispatch.ts`, `desktop/src/api/router.ts`, `desktop/src/spa.ts`, `desktop/tests/helpers.ts`. Needed change to a frozen file → stop that sub-goal, report under `BLOCKERS:`; never edit it.
3. **Stub replacement only** for `desktop/src/api/<domain>.ts` — each Wave 2 agent replaces its own stub's body. `router.ts` already imports all stubs.
4. **Tests/check isolation** per Global Constraints (dispatch-based tests, own-file checks, `cd desktop`).
5. **No git. No installs.** Coordinator commits per wave.
6. **Blocker protocol:** finish the finishable, then report `BLOCKERS:` with file, exact problem, proposed resolution.

## Ownership Map

| Task | Wave | Creates (owns) |
|------|------|----------------|
| T0 Foundation | 0 | as v1 + `desktop/src/db/migrations.ts`, `desktop/deno.lock` (already implemented; coordinator applies v2 amendments below) |
| T1 Search | 1 | `src/services/searchParser.ts`, `src/services/searchExecutor.ts`, `tests/search.test.ts` |
| T2 Streaming | 1 | `src/services/streaming.ts`, `tests/streaming.test.ts` |
| T3 Recommender | 1 | `src/services/camelot.ts`, `src/services/recommender.ts`, `tests/recommender.test.ts` |
| T4 Exporters | 1 | `src/services/exporterM3u.ts`, `exporterCsv.ts`, `exporterMarkdown.ts`, `exporterJsonBackup.ts`, `tests/exporters.test.ts` |
| T5 Scanner | 1 | `src/services/{ffprobe,metadata,artistNormalizer,hashing,fingerprint,scanner,duplicateDetector,jobs}.ts`, `tests/scanner.test.ts` |
| T6 Tracks API | 2 | `src/api/tracks.ts`, `tests/api_tracks.test.ts` |
| T7 Searches API + seeds | 2 | `src/api/searches.ts`, `src/db/seed.ts` (replace stubs), `tests/api_searches.test.ts` |
| T8 Sets API | 2 | `src/api/sets.ts`, `tests/api_sets.test.ts` |
| T9 Tags+Dupes API | 2 | `src/api/tags.ts`, `src/api/duplicates.ts`, `tests/api_tags_duplicates.test.ts` |
| T10 Export API | 2 | `src/api/export.ts`, `tests/api_export.test.ts` |
| T11 Scan+Artists+System API | 2 | `src/api/scan.ts`, `src/api/artists.ts`, `src/api/system.ts`, `tests/api_scan_artists.test.ts` |
| T12 Integration | 3 | coordinator; may touch anything |

Wave 2 deps: T6←T1,T2; T7←T1; T8←T3; T10←T4; T11←T5; T9←T0 only.

## Wave 0 Amendments (coordinator applies before Wave 1 — foundation already built at `2bd9cae`)

- [ ] **A1 types/models.ts:** boolean-ish row columns → `0 | 1` (`tracks.missing`, `track_dj_profile.can_cut_into/can_cut_out_of/dramatic_transition_candidate/human_confirmed`, `artist_profiles.needs_review`, `saved_searches.pinned`); request types: every Python-defaulted field optional (`RecommendQuery.approved_only/need_bridge/limit`, `SavedSearchCreate.pinned/description`, `ExportRequest.overwrite`, `DuplicateResolve.status/roles`, `ScanRequest.roots`, `PlayLog.*`); ensure `AnalyzeRequest`, `ArtistEnrichRequest`, artist list-filter type exist.
- [ ] **A2 utils/http.ts:** add `toBools<T>(row: T, keys: (keyof T)[]): T` (0/1→boolean, null passthrough); `readJson` enforces `content-type: application/json` → else `HttpError(415)`.
- [ ] **A3 database.ts:** FTS probe uses unique temp table name + `finally` cleanup; `backupOnLaunch` → `VACUUM INTO` on a read connection with collision-safe filename (`-2`, `-3` suffix on existing), plus a restore-verification in tests (open snapshot, read a row); add `withTx<T>(db, fn: () => T): T` (BEGIN IMMEDIATE / COMMIT / ROLLBACK on throw, rethrow).
- [ ] **A4 migrations:** `src/db/migrations.ts` — ordered `MIGRATIONS: {version, sql|fn}[]` (v1 = schema.sql); runner applies versions > current inside `withTx`; test upgrades a v1 DB to v1+dummy-v2 and records both rows.
- [ ] **A5 appPaths.ts:** missing HOME/APPDATA → throw with clear message (no `"."` fallback).
- [ ] **A6 router.ts:** method-mismatch on a matching path → 405 `{detail}`; mutation-route Host check (403 on mismatch) in `buildHandler`/`dispatch`.
- [ ] **A7 spa.ts:** `index.html` fallback only for GET/HEAD with extensionless path (asset misses stay 404).
- [ ] **A8 main.ts:** graceful shutdown — SIGINT/SIGTERM → server shutdown + `db.close()`.
- [ ] **A9 deno.json/lock:** pin packaging task with `--include ../frontend/dist` + scoped `--allow-read/--allow-write/--allow-run/--allow-env` + `--allow-net=127.0.0.1` + `--output` (validate flags against `deno desktop --help` output, adapt, note result); generate and commit `deno.lock`.
- [ ] **A10:** rerun foundation tests incl. new cases (toBools, withTx rollback, 405, Host check, migration upgrade, VACUUM-INTO snapshot restore); commit as Wave 0.1.
- [ ] **A11 (pre-dispatch gate, coordinator):** verify the built foundation matches the stub-replacement assumption — `router.ts` imports stubs for ALL of system/tracks/searches/sets/tags/duplicates/export/scan/artists; `src/db/seed.ts` exists with the `runSeeds` signature frozen `main.ts` calls; every Wave-2 owned file exists as a stub. Any mismatch → coordinator fixes frozen files BEFORE dispatching Wave 2 (never mid-wave).
- [ ] **A12 (desktop-window smoke test, coordinator, before Wave 1):** `cd frontend && npm run build` (if dist stale), then `deno task desktop` — a window must open and render the app. **Executed 2026-07-21; findings baked into the plan:**
  - `deno desktop --backend cef main.ts` BUILDS a `CrateMind.app` bundle and exits — it does not run it. Launch `CrateMind.app/Contents/MacOS/CrateMind` (the `laufey` binary next to it is only the bare CEF shell — launching it shows a placeholder page).
  - Permissions are baked at build time: a build without `--allow-env` etc. dies at startup with an ApplicationError dialog. Every desktop build must carry the A9 flag set.
  - Deno Desktop auto-binds `Deno.serve` and opens the main window at the served address (`DENO_SERVE_ADDRESS`) — `main.ts` needs no explicit `Deno.BrowserWindow` for the main window.
  - `schema.sql` is embedded via a text import (`with { type: "text" }`) in `migrations.ts` — a runtime file read fails inside the bundled app.
  - CEF emits Google GCM registration chatter (external!) — T12 network-audit must address (CEF switches / restricted-net acceptance run).
  - **RESULT: GREEN (2026-07-21).** Flagged build renders the full CrateMind UI (Greek dashboard, Memory Crates, MiniPlayer shell) in the CEF window over foundation stubs; fresh WAL SQLite + backups/ + exports/ created in `CRATEMIND_DATA_DIR`. Note: in packaged mode the runtime auto-binds `Deno.serve` for the window — `CRATEMIND_PORT` is not an externally reachable TCP listener there. T12's curl-based acceptance must therefore run against dev mode (`deno task dev`); the packaged app is verified through the UI pass.

## Wave 1 — parallel service ports (5 agents)

Common: import only from foundation modules; own files only; `cd desktop` for all commands; port Python exactly per Deliberate Divergences table; final report ends with `BLOCKERS:`.

### T1: Search parser + executor
**Read first:** `backend/app/services/search.py` (the spec), `backend/tests/test_search.py`, `backend/app/db.py` (FTS columns).
**Produces (binding):** `searchTracks(db, query, limit=500, offset=0): Track[]`, `countTracks(db, query): number`, `compileQuery(query): CompiledQuery`.
- [ ] Port tokenization (shlex-like quotes w/ whitespace fallback), numeric specs (`7+`, trailing `-`, `a-b` incl. negatives, equals; invalid → silently ignored), `_PROFILE_NUM`/`_TRACK_NUM`/`_STR_FIELDS` maps verbatim, `not_recent`/`played_recently` (ISO cutoff), bare tokens, negation semantics **exactly as Python**: `-untagged` is NOT a profile filter (falls through to FTS exclusion); negated nullable criteria use SQL `NOT(col ...)` which excludes NULL rows — preserve; unknown `field:value` → free text.
- [ ] Executor SQL: LEFT JOIN profile + artist_profiles; `ORDER BY t.artist, t.title`; limit ≤0 unbounded; FTS include (AND, quoted, zero hits → empty), exclude (OR).
- [ ] Tests: flagship query + decoys (recent-play, non-dramatic), `never_played`/`-never_played`, `untagged`, `-untagged` (FTS-exclusion semantics), invalid numeric ignored, empty `field:`, quoted phrase, `energy:7-9`, limit 0, NULL-exclusion on negated profile filter.

### T2: Audio streaming service
**Read first:** `backend/app/services/streaming.py`, `backend/tests/test_audio.py`, guide §10.
**Produces (binding):** `AUDIO_MIME`, `parseRange(header, fileSize): RangeParse`, `streamResponse(path, ext, rangeHeader, fileSize): Promise<Response>`, `UnsupportedMediaError`.
- [ ] Semantics from `streaming.py` (Python wins over guide sketch); 416 = empty body + `Content-Range: bytes */N`; 64 KiB chunked `ReadableStream`, `cancel()` closes file, never full-buffer.
- [ ] Tests: full/valid/suffix/open-ended/invalid ranges, multi-range reject, unsupported ext, >64 KiB round-trip intact.

### T3: Recommender + Camelot
**Read first:** `backend/app/services/recommender.py` (the spec — incl. `Context`, `effective_bpm`/`effective_key`), `backend/tests/test_recommender.py`, `frontend/src/lib/types.ts:Recommendation`.
**Produces (binding — mirrors Python's split: T3 is pure scoring, endpoint context assembly belongs to T8):**
```ts
export interface Context { /* verbatim mirror of recommender.py Context: previous_key, previous_bpm, next_key, next_bpm, after_track_id, before_track_id, target_bpm, target_energy, target_role, max_weirdness, approved_only, need_bridge, exclude_ids: Set<number>, recently_played_ids: Set<number> */ }
export function recommend(db: DatabaseSync, ctx: Context, limit: number): RecommendationOut[];
export function effectiveBpm(t: Track): number | null;   // ported from recommender.py — T8 needs these for context assembly
export function effectiveKey(t: Track): string | null;
export function camelotOf(keyText: string | null): string | null;
export function keyCompatibility(a: string | null, b: string | null): number;
```
`RecommendationOut` = the **flat** Contract Matrix shape (no nested track, no warnings). Skips `missing` tracks and `retired`/`avoid`; pair-note bonuses `6 + rating` on BOTH legs with exact phrasings `"+ noted A→this worked:"` AND `"+ noted this→B worked:"` (via `_note_phrase` incl. transition_type + `{rating}/5`); `score` rounded to 2 decimals; sort desc; limit.
- [ ] Port scoring weights and reason strings verbatim; bridge mode; `approved_only` (approved+weapon); `max_weirdness`; targets.
- [ ] Tests: port `test_recommender.py` cases + bridge + BOTH pair-note legs + flat-shape golden.

### T4: Exporters
**Read first:** `backend/app/services/exporter_{m3u,csv,markdown}.py`, `backend/app/services/backup.py` (`export_json`), `backend/app/api/export.py`, `backend/tests/test_export_m3u.py`.
**Produces (binding — mirror Python signatures per format):**
```ts
export function exportM3u(tracks: Track[], dest: string, overwrite: boolean): string;           // throws FileExistsError-like on conflict
export function exportCsv(db: DatabaseSync, tracks: Track[], dest: string, overwrite: boolean): string;  // db needed: Python export_csv(session,…) reads profile/tag data per row — verify in exporter_csv.py; drop param only if it truly doesn't
export function exportMarkdown(djSet: DJSetRow, tracks: Track[], dest: string, overwrite: boolean): string;
export function exportJsonBackup(db: DatabaseSync, dest: string): string;                       // always overwrites, mirrors backup.export_json tables
```
- [ ] Output byte-identical to Python where deterministic. Tests: goldens (full-metadata + nulls track), conflict throw, json-backup table coverage vs `backup.py`, and a json-backup golden containing boolean-column values — Python emits `model_dump(mode="json")` `true`/`false`; the port must convert SQLite `0|1`, never leak raw integers into the portable backup.

### T5: Scanner, metadata, hashing, fingerprint, duplicates, jobs
**Read first:** `backend/app/services/{scanner,ffprobe_reader,metadata_reader,artist_normalizer,hashing,fingerprint,duplicate_detector}.py`, `backend/app/jobs/worker.py`, `backend/tests/{test_scanner,test_duplicate_detector,test_artist_normalizer}.py`.
**Produces (binding):** jobs (`createJob/updateJob/listJobs/runJob` — `runJob` retains its promise, `finally` guarantees done/error, never stuck `running`), `scanRoots(db, config, roots, job)`, `probe(ffprobePath, filePath)` with **30 s timeout + child kill**, `extractTags(probe)`, `normalizeArtist(name)` (port `artist_normalizer.py`), `quickHash/fullHash` (exact `hashing.py` windows), `fingerprintFile` (**60 s timeout**), `detectDuplicates(db)`.
- [ ] Scanner: upsert by `absolute_path` ONLY (no moved-file reconciliation — matches Python); unchanged check (size+mtime); missing marking; filename/folder metadata fallbacks + label/BPM extraction per `scanner.py`/`metadata_reader.py` (ffprobe JSON replaces mutagen per guide §11); `artist_normalized` set via `normalizeArtist`; reindex after each upsert; yields between files.
- [ ] Tests: hashing goldens; tag-casing variants; upsert idempotence; missing marking; normalizer cases from `test_artist_normalizer.py`; duplicate grouping (flags only — no deletion); job lifecycle incl. failure → `error` status; **data-safety: source files bytes+mtime unchanged after scan**.

## Wave 2 — parallel API routers (6 agents)

Common: replace only own stub(s); literal-before-param ordering; defaults applied per Contract Matrix; `toBools` on boolean columns before responding; `withTx` for multi-statement writes (play log, reorder, set log-play, batch-profile, resolve); `reindexTrack` after searchable-column writes; **tests via `dispatch(routes(), req, ctx)` with own routes only**; verify response shapes against Matrix + Python file field-for-field (golden-shape assertions on full JSON keys).

### T6: Tracks API — routes per Matrix. `_list_payload` enrichment (energy/darkness/set_role/artist_prefill — port `_artist_prefill_payload` from `tracks.py`), `_track_payload` detail, play log in `withTx`, audio via T2 (404 unknown id → `{detail:"track not found"}`, 410 missing file, 415 unsupported). **Nested booleans:** `artist_prefill` payload fields (`needs_review`, computed `bpm_conflict`, …) must be real JSON booleans per `types.ts:ArtistPrefill` — top-level `toBools` doesn't reach them, convert explicitly.
- [ ] Tests: list default limit 200 + enrichment keys golden; count; detail 404; profile PATCH partial + FTS visibility; play → `not_recent:30` stops matching; audio status ladder; batch-profile `{updated}`.

### T7: Searches API + seeds — routes per Matrix; live count field name from `searches.py:_payload`; `runSeeds` in `src/db/seed.ts`: guide §14 defaults + "New Untagged" (`untagged`), insert-if-name-missing.
- [ ] Tests: CRUD incl. `{"deleted":true}`; live counts; `/:id/tracks` returns plain Track dumps (no enrichment); seeds idempotent.

### T8: Sets + pair-notes API — routes per Matrix. Reorder = two-pass +100000 inside `withTx`, response `{set_id, order}`; remove → `{"removed":true}` no compaction; analysis math verbatim from `sets.py` (port `test_sets_effective.py`); log-play in `withTx` → `{tracks_logged}`; pair-notes GET filter matches from OR to.
**recommend-next: T8 owns the context assembly** (exact port of `sets.py:180-219`): 404 on missing set; `in_set` exclude ids from ordered set rows; `last_track` = `after_track_id` lookup else last set row; `next_track` = `before_track_id` lookup; 30-day `recently_played_ids` from `play_events`; build T3 `Context` with `previous_/next_` bpm+key via T3 `effectiveBpm`/`effectiveKey`, `target_bpm = req.target_bpm || (last_track ? effectiveBpm(last_track) : null)` — Python-truthy fallback (a `target_bpm: 0` falls through, matching `sets.py:210`) WITH the null-guard (`effectiveBpm` takes a Track; empty set ⇒ `last_track` null), `need_bridge = req.need_bridge || next_track !== null`; call T3 `recommend(db, ctx, req.limit ?? 20)`. Test the empty-set and `target_bpm: 0` cases.
- [ ] Tests: lifecycle, reorder positions, no-compaction assertion, analysis goldens, recommend-next context behavior (in-set excluded; bridge auto-enabled when `before_track_id` present) + flat golden, log-play recency effect, pair-note CRUD/filter.

### T9: Tags + duplicates API — routes per Matrix. Tag assign create-or-get; reindex on assign/remove; duplicates list with `status` query default `needs_review` + member serialization exactly as Matrix; resolve updates roles/status only in `withTx` — never touches files. **JSON `roles` keys arrive as strings** (Python coerces to int via `dict[int,str]`); look up with string keys or `Number()` — don't introduce a strict numeric `===` that never matches.
- [ ] Tests: assign/reuse/remove + FTS effect; return shapes from `tags.py` verbatim; duplicates filter + resolve.

### T10: Export API — routes per Matrix. Filename sanitization (mandatory, all formats): reject separators/`..`/absolute → 400; empty tracks → 400 (m3u/csv); markdown requires set; conflict → 409; json-backup `{path}` only, always overwrite; canonical-containment assertion.
- [ ] Tests: golden content in exportsDir; escape attempts (`../x`, `/tmp/x`, `a/b`) → 400 and nothing written outside; 409 path; json-backup overwrite.

### T11: Scan + artists + system API — routes per Matrix. scan/start 400 without roots; fingerprint 400 without fpcalc; analyze/enrich 501; status single-Job semantics incl. `job_id` param + 404; artists list filters/stats/rebuild/accept-prefill ported from `artists.py` + `artist_catalog.py` (DB-only); health/settings key sets from `main.py`.
**Isolation note:** Python's `artists.py` imports `_apply_profile` from `tracks.py` — do NOT mirror that import (T6 edits `tracks.ts` concurrently). Inline your own small profile-apply in `artists.ts` for accept-prefill (get-or-create `track_dj_profile` row, set provided fields, `updated_at = nowIso()`, `reindexTrack`) — semantics identical to `tracks.py:_apply_profile`.
- [ ] Tests: health/settings goldens; scan job on temp dir → done, processed count, source files untouched; status semantics; artists rebuild/stats; accept-prefill writes profile + reindex; 501s.

## Wave 3 — T12 Integration (coordinator)

- [ ] Full: `cd desktop && deno task check && deno task test`; fix cross-task breakage.
- [ ] **Core-loop checkpoint (gate):** boot `deno task dev` against scratch data dir + real `CRATEMIND_LIBRARY_ROOTS`; verify: tracks list, flagship query, profile PATCH, play→recency, audio Range (curl 206 + MiniPlayer), SPA deep-link. Only after this passes, verify optional subsystems (duplicates, artists, exports, scan jobs).
- [ ] `cd frontend && npm run build`.
- [ ] **UI acceptance pass (guide §24, in-browser or window):** Dashboard counts, TaggingQueue profile edit, Library search, Crates (saved searches CRUD + counts), SetBuilder add/reorder/recommend/reasons, pair note, exports m3u+markdown, MiniPlayer play + log.
- [ ] Network audit: run packaged/dev app with `--allow-net=127.0.0.1` only — full acceptance must pass under that restriction; plus `rg "https?://" desktop/src`.
- [ ] `deno desktop` packaging per amended A9 task; window opens, UI loads, MiniPlayer plays.
- [ ] Final commit.

## Review changelog (Codex gpt-5.6-sol pass 1 → v2)

**Accepted & applied (verified against Python source):** flat recommender shape; list limit 200 + `_list_payload` enrichment; delete semantics `{"deleted"/"removed":true}`, no compaction; reorder tx/response; scan/status single-Job; fingerprint 400; duplicates `status` query; export per-format signatures, json-backup `{path}`/always-overwrite, mandatory filename sanitization; DTO optional defaults + per-route defaulting; row types `0|1` + `toBools` serializers; migrations runner; `VACUUM INTO` launch snapshot + collision-safe names; FTS-probe cleanup; `withTx` contract; 405 + streaming-416 error-shape exception; Host/content-type mutation guard; SPA fallback restriction; appPaths hard-fail; lockfile ownership; packaging task pinned; scanner moved-file claim removed; artistNormalizer + metadata parity added to T5; sidecar timeouts (30 s/60 s) + kill; job `finally` lifecycle; data-safety snapshot assertions; dispatch-based Wave 2 test isolation + own-file checks; `cd desktop` command context; contract matrix; graceful shutdown; UI acceptance pass; loopback-restricted network proof; search-semantics pinning (incl. `-untagged`, invalid-numeric, NULL-negation).

**Opus validation pass 2 (verdict REVISE → applied in v3, all claims source-verified):** T3 binding corrected to `recommend(db, ctx: Context, limit)` + `Context` mirror + exported `effectiveBpm`/`effectiveKey`; recommend-next context assembly (`sets.py:180-219`) explicitly owned by T8; T11 inlines profile-apply instead of mirroring `artists.py`'s cross-import of `tracks._apply_profile`; A11 pre-dispatch stub/import gate; A12 desktop-window smoke test before Wave 1; both pair-note reason legs pinned; `artist_prefill` nested-boolean conversion (T6); `roles` string-key note (T9); `exportCsv` db-param justification (T4). Opus confirmed: ~20 Matrix rows accurate, A1 boolean-column list complete, both v2 rejections of Codex findings sound.

**Codex pass 3 (final; both v2 rejections accepted; 3 residual blockers → applied as Wave 0.2, commit-level):** dispatch core extracted to dependency-free frozen `src/api/dispatch.ts` (stubs/tests/helpers/seed import it, never `router.ts`) — closes the transitive type-check race; content-type 415 enforced centrally in `dispatch` for ALL mutations incl. body-less ones, with a no-side-effect test; T8 `target_bpm` fallback corrected to Python-truthy + null-guard; T4 json-backup boolean golden added. Codex confirmed all other round-1/round-2 corrections present and source-consistent.

**Rejected / adapted (with reasoning):**
- *"Remove saved-search seeds"* — guide §14 explicitly requires them; kept as documented divergence, added "New Untagged". ("Duplicate Suspects" skipped — no supporting query token exists.)
- *"Vertical slice before other subsystems"* — parallel waves kept (explicit user choice); adapted into the Wave 3 core-loop checkpoint gate ordering verification.
- *"Add generic validation layer"* — Codex itself scoped this down; per-route defaulting + whitelists only, no framework.
