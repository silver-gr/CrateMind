# Artist Genre Research Implementation Plan

> Execution: native implementation with bounded parallel provider/UI work and an independent final review. The user has explicitly authorized implementation; proceed without an approval handoff.

**Goal:** Clicking Enrich performs the sourced genre research demonstrated in this chat, through the user's local proxy with gpt-6-luna at max effort.

**Architecture:** Reuse the existing Python job/API and ArtistReview storage. One search-enabled Responses request researches one artist using local track examples. Store a versioned, source-backed candidate; only an explicit user review applies genre fields and seals the artist.

**Tech Stack:** Python stdlib HTTP/JSON, existing SQLModel/FastAPI, React/TypeScript. No new dependencies or database migrations.

**Spec:** User requests in this chat dated 2026-11-01; success criteria below.

## Global Constraints

- Proxy: http://127.0.0.1:8317/v1; existing backend/.env key remains server-only.
- Model: gpt-6-luna; reasoning effort: max; no model/effort fallback.
- Search capability was verified live via Responses web_search and open_page events.
- Allowed labels: Goa Trance, Prog-psy, Full-On, Morning Full-On, Night Full-On, Twilight, Darkpsy, Forest, Hi-Tech, Psycore, Zenonesque, Psydub.
- Research concerns genre metadata for large libraries, not biography or numeric DJ estimates.
- Existing confirmations, source audio, artist names, numeric profiles and unrelated worktree changes must survive.
- Do not bulk-run live provider requests or rewrite the user's catalog while implementing.

## Review Focus

- Namesakes and sparse sources: unresolved findings must not become applied genres.
- Sources: claimed evidence URLs must occur in the proxy's real search/citation output.
- Confirmation races: user confirmation during a provider request wins over the arriving result.
- Legacy data: old non-null enrichment timestamps cannot prevent the new workflow running.
- Genre-only acceptance: preserve names, BPM/energy/role fields and raw historical baselines.

## Task 1: Search transport, prompt and genre validation

**Files:** backend/app/services/llm_client.py; backend/app/services/artist_genre_research.py; backend/app/artist_vocab.py; matching provider/validator tests.

**Interface:** `research_json(system, user, schema)` returns `{result, sources, model, reasoning_effort, search_calls}`. `research_artist(artist)` returns a staged candidate containing genre fields, versioned raw_llm_json and `research` metadata. `research_info(raw)` extracts that metadata for API/UI use. `GENRE_PROFILE_FIELDS` identifies genre-only acceptance fields.

- Test transport parsing, actual tool-use requirement, source extraction, refusal/error handling and credential isolation.
- Implement Responses request with required web_search, included sources, configured model/effort and strict JSON schema.
- Implement concise genre-only prompt using local track evidence and primary-source priority; allow classified/outside_list/unresolved.
- Validate canonical labels/aliases, identity match, supported source URLs and confidence. Derive scene_cluster; do not request biographies or numerics.
- Verify provider and normalization tests.

## Task 2: Job, review and configuration integration

**Files:** backend/app/services/artist_intelligence.py; backend/app/api/artists.py; backend/app/jobs/worker.py; relevant backend tests; backend/.env (private configuration only).

- Stage per-artist research while leaving active genre/numeric values intact.
- Include new and legacy unconfirmed artists; skip current-version ready research unless rerun explicitly, and always skip confirmed/placeholder artists.
- Preserve partial progress and retryable errors; display useful job progress.
- Expose research evidence and eligibility in artist responses.
- Apply only genre fields for new research candidates; unresolved/outside-list results require a manual choice.
- Preserve manual confirmation exclusion under normal, forced and comparison modes, including in-flight races.
- Configure the explicitly requested local model/effort without exposing the key.
- Verify API, orchestration and confirmation tests.

## Task 3: Evidence and review UI

**Files:** frontend/src/pages/Artists.tsx; frontend/src/lib/types.ts; focused source-evidence presentation component/tests if needed.

- Preserve the existing Unknown Artist read-only card and prior confidence-label edits.
- Show safe source links, research status and source-backed genre rationale.
- Do not show new BPM/energy estimates; only offer candidate acceptance when a genre is classified.
- Make the unenriched filter reflect new research eligibility and restore either running artist job on reload.
- Keep review/confirmation explicit; do not automatically call AI suggestions human-confirmed.
- Verify frontend build and representative browser rendering/navigation with fixtures.

## Completion

- Run focused backend checks, then the full backend suite when focused checks pass.
- Run frontend build and relevant frontend tests.
- Run one bounded real proxy smoke test against disposable data; assert actual search events and evidence; never launch a library-wide enrichment job.
- Review diff, secret exposure and unchanged confirmed catalog rows.
- Report changes, verification and live-validation limits concisely.
