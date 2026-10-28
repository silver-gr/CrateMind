# CrateMind Tauri Desktop Migration Implementation Plan

Implementation follow-up: [local preview validation and remaining release gates](../../TAURI_MIGRATION_VALIDATION.md).
The checklist below preserves the original acceptance contract; the linked report
distinguishes completed implementation checks from unverified release/platform gates.

> **For agentic workers:** Use Codex native subagents with explicit gpt-6.1-sol / high settings. Execute one dependency-ready task per owner and review its result before integration. This plan adapts the writing-plans workflow to the available Codex App surface; it does not require an unavailable superpowers execution runtime. Steps use checkboxes for tracking.

**Goal:** Ship a self-contained Tauri application with the existing React interface, a shared Python core, retained library-management parity and complete two-way library-state handoff, while leaving BPM/key computation and SoundCloud/Spotify workflows in the web app.

**Architecture:** Tauri supervises a frozen Python onedir backend serving the SPA and retained APIs from an authenticated loopback origin. Reuse Python models/services/jobs and existing paired backups; isolate web-only imports and provider actions without recreating the domain in Rust. Native media tools and lifecycle adapters provide an extension point for later processing.

**Tech Stack:** Tauri 2, Rust, React/Vite/TypeScript, shared FastAPI/SQLModel/Python, PyInstaller onedir, SQLite, Mutagen/NumPy, bundled ffmpeg/ffprobe/fpcalc.

**Spec:** [Design](../specs/2026-10-27-tauri-desktop-migration-design.md) and [route baseline](../specs/2026-10-27-tauri-parity-baseline.json).

## Global constraints

- Planning baseline: f71dc17ac596732ab14c3e81d9fe984210733c62. Reconcile later source changes before execution; do not overwrite unrelated edits.
- One shared Python domain implementation; no Rust or desktop fork of collection, identity, matching or canonical metadata logic.
- Retain 92 baseline routes; explicitly defer the 12 recorded routes. Also gate provider-specific mutations inside retained generic endpoints.
- BPM/key computation and all SoundCloud/Spotify acquisition/matching/provider-review workflows remain web-owned. Stored results remain usable on desktop.
- Preserve existing optional artist enrichment/comparison; its availability must be honest when credentials/network are absent.
- No source audio deletion, movement, retagging or embedded cue writes. Exports remain in output directories.
- No installed runtimes/tools or user-started backend. Core install/launch/use works offline.
- Keep NumPy for waveform parity; do not package analysis-only SciPy/librosa/Essentia as an accidental import dependency.
- Existing web profile behavior is the default and must keep passing its tests.
- Use copied/generated fixtures for all migration/media tests. No real catalog or music scan during implementation verification.
- All new user-facing copy is Greek; retain established DJ/audio terminology.
- No full concurrent-merge engine, provider/domain redesign, live audio engine, new DSP algorithms, push, deployment or publication in this migration.
- Keep the Deno app and original datasets as fallback until installed-artifact acceptance and rollout criteria pass.

## Review focus

1. A copied SQLite file is not a consistent catalog/identity snapshot when WAL writers are active. Tasks 9, 12–14 must test paired snapshots, failure injection and unchanged originals.
2. An ephemeral origin can lose preferences or break cookie-authenticated native audio requests. Tasks 5, 8 and 17 must test actual target WebViews and restarts.
3. Hiding routes can leave eager DSP imports or automatic analysis reachable. Tasks 2–3 must prove profile isolation and preserve web behavior.
4. Different device mount paths can change identity IDs or create false exchange conflicts. Task 10 must prove logical-path preservation across two replicas.
5. A frozen executable can work on the build host while missing native libraries or leaving orphan processes on clean machines. Tasks 3, 6 and 18 must test installed artifacts without development tools.

## Scope and parity ownership

| Feature | Desktop outcome | Verification owner |
|---|---|---|
| Dashboard, library search/filters/sorting, profiles/tags, Memory Crates | Existing shared behavior | Tasks 1, 11, 17 |
| Playback, seek, cue CRUD, waveform/RMS, local artwork | Retained with native-WebView checks | Tasks 5, 11, 16–17 |
| Sets/playlists, transitions, recommendations, pair notes, play logging, safe exports | Existing Python behavior; use stored effective BPM/key | Tasks 1, 11, 17 |
| Scans/delta scans, duplicates, fingerprinting, artist rebuild | Retained; no post-scan BPM/key jobs in desktop-core | Tasks 2, 6, 10–11 |
| Unified library, local identities, canonical decisions, collections, provenance, completeness/recovery | Reuse current Python implementation and paired identity DB | Tasks 9–11, 17 |
| Artist LLM enrichment/comparison | Existing optional configured workflow | Tasks 2, 11 |
| BPM/key computation and BPM review/provider-validation controls | Web-owned; desktop shows existing values/provenance | Tasks 2, 7, 11 |
| SoundCloud/Spotify acquisition/import/matching/review | Web-owned; desktop reads stored results | Tasks 2, 7, 11 |
| Complete backup and two-way exchange | Paired snapshots, serial handoff, divergence detection | Tasks 12–15 |
| Native window, menus, folder selection, reveal/open actions | Tauri implementation, Greek copy | Tasks 4, 7, 17 |
| Local preferences and geometry | Survive origin/port changes; per-device | Tasks 7–8 |
| Legacy Deno metadata JSON import | Explicit shared adapter with unmatched/conflict report | Task 9 |
| Existing Coming Soon screens | Preserve current placeholder status | Tasks 1, 17 |

## File boundaries and ownership

| Area | Planned paths | Responsibility |
|---|---|---|
| Runtime profile | backend/app/runtime_profile.py; backend/app/app_factory.py; backend/app/main.py; backend/app/jobs/worker.py | Side-effect-free factory, profile selection, conditional registration and lazy analysis imports |
| Dataset ownership | backend/app/services/active_dataset.py; backend/app/services/dataset_access.py | Pre-import active generation resolution, OS-backed lease and shared maintenance admission |
| Packaged backend | backend/app/desktop_runtime/{bootstrap,config,protocol,server,auth,preferences,native_actions}.py | Launch/config/HTTP boundary; no duplicate domain logic |
| Native host | native/src-tauri/src/{lib,supervisor,protocol,security,native_actions,storage}.rs | Process/window/native ownership; storage.rs locates app data but never owns dataset pointers |
| Build layout | native/package.json; native/src-tauri/{Cargo.toml,tauri.conf.json}; native/startup/ | Tauri shell and bundled startup page |
| Python freezing | backend/packaging/desktop.spec; backend/packaging/hooks/; scripts/desktop/ | Reproducible complete onedir/resource builds |
| Portable paths | backend/app/services/library_paths.py and existing filesystem consumers | Device-local path overlay; preserve shared identity |
| Shared exchange | backend/app/library_exchange/{manifest,state,operations,cli}.py | Sole Python owner of pointers/recovery/enrollment/handoff; wrap existing backups without identity remodeling |
| Schema compatibility | backend/app/services/schema_contract.py; backend/app/schema_contract.json; scripts/desktop/generate_schema_contract.py | Generated supported structures and additive-compatible value digest |
| Existing backup | backend/app/services/backup.py | Reused snapshots, Windows-safe publication fixes |
| Shared frontend | frontend/src/lib/{api,capabilities,desktopRuntime,preferenceStorage}.ts[x]; current components/pages | Capabilities, preference persistence and native/exchange controls |
| Validation | backend/tests/test_desktop_*.py; backend/tests/test_library_exchange*.py; native/src-tauri/tests/; scripts/desktop/ | Unit/contract/packaged/installed validation |

Only one task owner may edit a shared bootstrap, main.py, worker.py, manifest or build configuration at a time. Integrate foundational interfaces before parallel dependent tasks.

## Milestones and dependency order

| Milestone | Tasks | Exit evidence |
|---|---|---|
| M0: executable scope | 1 | Route and UI acceptance inventory is complete |
| M1: reusable packaged core | 2–3 | Frozen core runs without deferred dependencies using production tool/resource seams |
| M2: supervised shell and shared paths | 4–6, 10 | Native media/lifecycle spike and portable path adapter pass |
| M3: native preferences and exchange foundation | 7–8, 12–13, 15 | Native configuration works; web enrolls and complete bundles are safe |
| M4: onboarding and retained parity | 9, 11, 14 | Desktop imports S0; A→B→A and retained features pass |
| M5: release candidate | 16–20 | Measured native artifacts, cross-platform QA, rollback proof |

After M1, native integration and exchange-format work can proceed in parallel once their shared interfaces are frozen. Do not parallelize edits to the same bootstrap or database helpers. Use small intent/Lore commits with explicit pathspecs after each green task; this planning request itself does not authorize executing the migration.

Explicit edges: 1→2→3; 2→10; 3→4→5→6; 6+10→7→8; 2+10→12→13→15; 13+15→9; 9+10→11; 8+9+11+13+15→14; 14→16→17→18→19→20. Numbers identify tasks, not a claim they must run numerically. Task 2 supplies ownership/schema contracts; Task 3 supplies production tools/resources. Task 10 first verifies path/identity invariants; Task 12 adds digest assertions once that interface exists. M2 uses fixture datasets. Tasks 16/18 harden the earlier seams.

## Task 1: Lock retained contracts and fixture coverage

**Files:** Create backend/tests/test_desktop_contract_inventory.py; backend/tests/fixtures/desktop_parity/; scripts/desktop/check_parity_inventory.py. Reference the saved route JSON, existing backend tests and frontend App.tsx.

**Interfaces:** Map every retained route/screen to verification, deferred actions to capabilities, every mutation to desktop_guard and new routes to planned_routes. Runtime discovery uses temporary storage; historical source lines are evidence, not a requirement that handlers never move.

- [ ] Check all 104 captured method/path keys have disposition, guard and verification owner; exactly 12 are deferred. New preferences/config/native/exchange/legacy-import routes are separately classified rather than unclassified baseline drift.
- [ ] Add fixture assertions for cues, tags, profiles, sets, pair notes, plays, provider snapshots, analysis provenance and accepted/rejected identity decisions. Use existing tests as oracles; add no production data.
- [ ] Implement the inventory helper; compare normalized route parameters without treating route counts as behavioral parity.
- [ ] Run: cd backend && uv run pytest tests/test_desktop_contract_inventory.py. Pass: complete inventory, no unclassified route/screen, no accidental roadmap additions.
- [ ] Review/commit only this task's files with tested/not-tested Lore context.

## Task 2: Extract a shared core runtime profile

**Files:** Create backend/app/runtime_profile.py, app_factory.py, services/active_dataset.py, services/dataset_access.py and services/schema_contract.py; generate backend/app/schema_contract.json with scripts/desktop/generate_schema_contract.py; add focused profile/access/schema tests. Make main.py a thin web entry; modify config.py, jobs/worker.py, api/identity.py and mutation entry points for shared seams; adjust pyproject.toml/uv.lock. Python module paths are under backend/app.

**Interfaces:** RuntimeProfile enum with WEB and DESKTOP_CORE; app_factory.create_app(profile: RuntimeProfile | None = None) -> FastAPI; get_runtime_profile() -> RuntimeProfile. Factory import never instantiates the web app; main.py remains the ordinary web entry.

Also produce resolve_active_dataset(dataset_root, explicit_overrides) -> ActiveDataset; DatasetLease.acquire(dataset_root, owner) -> HeldLease; MaintenanceCoordinator.operation(label) and tracked background-job scopes; enter_maintenance(timeout_s) -> MaintenanceGuard. The lease covers the service lifetime; the operation scope covers an entire durable operation through its final identity synchronization.

- [ ] Write tests asserting the default web app retains its current behavior; desktop disables the 12 deferred routes with structured 501 errors and blocks provider-specific identity mutations while permitting local identity operations.
- [ ] Implement baseline guards: confirm/reject/undo/revoke identity resolve both services and allow local↔local only; metadata/pattern/collection/consolidation/lineage/recovery decisions remain allowed; retirement stays local-only. Existing-link replay and derived candidate refresh remain shared. Test real service rows, not client-declared labels.
- [ ] Return a Greek string detail and separate code on errors; test actual UI rendering instead of object-valued detail.
- [ ] Assert importing/starting desktop-core cannot load scipy, librosa, essentia or analysis-only provider clients, and a completed desktop scan never starts BPM/key processing.
- [ ] Move eager imports behind the profile boundary, including worker's analysis import; keep shared local SoundCloud normalization/projection helpers. Keep local artist rebuild and identity synchronization.
- [ ] Add opt-in CRATEMIND_DATASET_ROOT resolution before app.db imports; validate exact catalog/identity pairing and reject conflicting explicit paths. Preserve unenrolled web defaults.
- [ ] Generate schema descriptors from temporary production-initialized catalog/identity fixtures. Commit the generated contract and fail tests when models/lazy schema helpers change without regeneration; source/frozen builds use the same contract.
- [ ] Before enrolled startup schema changes, take a paired backup under the lease and initialize known lazy tables before readiness. Additive empty/NULL additions remain digest-equivalent; data rewrites are revisions until export and cannot erase dirty edits.
- [ ] Instrument all durable mutators and job lifetimes, not just HTTP methods or submission locks. Test cue/profile/canonical races, a scan paused between catalog commit and identity sync, an idle service lease blocking CLI import and OS release after process death.
- [ ] Export maintenance stops new durable admission and drains/refuses active operations. Reuse create_backup's SQLite reservation exactly once; test no nested reservation deadlock.
- [ ] Split dependency groups without changing the documented default web environment; define a core packaging group and resolve it without analysis extras. Keep NumPy for waveform parity.
- [ ] Run: cd backend && uv run pytest tests/test_desktop_profile.py tests/test_worker.py tests/test_runtime_capabilities.py tests/test_identity_sync.py.
- [ ] Pass: retained handlers are shared, web behavior remains unchanged, and no second domain implementation appears. Review/commit.

## Task 3: Prove a self-contained Python core before building the full shell

**Files:** Create backend/app/desktop_runtime/{__init__,bootstrap,config,protocol,server}.py; backend/app/services/media_tools.py; backend/packaging/desktop.spec; scripts/desktop/build_backend.py and stage_resources.py; backend/tests/test_desktop_bootstrap.py and test_media_tools.py. Modify retained tool call sites, frontend/package.json, frontend/src/main.tsx and frontend/src/lib/pwa.ts for the explicit desktop build.

**Interfaces:** DesktopInitV1 and BOUND records from the spec; load_desktop_init(stream) -> DesktopInit; resolve_desktop_paths(init) -> DesktopPaths; run_server(init, bound_socket) -> int. Add a --self-test mode that never opens real app data.

Produce the production ToolRunner.run(tool, args, timeout_s, cancel_event) -> ToolResult and resource staging interface here. They resolve real bundled tools absolutely and track owned subprocesses; Tasks 6/16 extend the same ownership/concurrency seam.

- [ ] Test Python-owned dataset resolution before imports, disabled .env discovery, malformed initialization, missing resources/tools and generation caches. DesktopInit passes only app-data/resources/tool locations; Rust cannot parse/write active.json.
- [ ] Implement the guarded executable entry point, frozen multiprocessing support, existing-resource lookup and a retained pre-bound 127.0.0.1:0 socket. Stdout contains bounded protocol JSON only; logs go to stderr.
- [ ] Freeze the full onedir directory, including NumPy/Mutagen and only required code/resources. Exclude analysis-only imports and all generated calibration reports/developer data. A synthetic sentinel report present in the checkout must not appear in the artifact.
- [ ] Add build:desktop using Vite's desktop mode; prevent service-worker registration before it can occur, and keep web PWA behavior intact. Stage actual frontend/media resources with the production helper, not PATH tools or temporary wrappers.
- [ ] Run: python scripts/desktop/build_backend.py --target <native-target> --self-test. Pass: copied build works outside the repo, with empty PATH and no installed Python/Node/Deno, starts/stops and reports real packaged tool versions.
- [ ] Probe bundled SQLite FTS5, JSON functions, foreign keys and required query semantics; record its version against the shared minimum schema/SQL feature contract. Importing Python alone is insufficient.
- [ ] Record actual dependency inventory, size and minimum-OS constraints; do not claim unsupported targets. Review/commit.

## Task 4: Add the Tauri host and startup protocol

**Files:** Create native/package.json, native/startup/index.html, native/src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,src/lib.rs,src/protocol.rs,src/supervisor.rs}; native/src-tauri/tests/supervisor.rs.

**Interfaces:** BackendSupervisor::start(config) -> RunningBackend; RunningBackend includes launch_id, process ownership and exact origin only after authenticated health. Native configuration declares a resource mapping preserving backend executable and _internal siblings.

- [ ] Test BOUND without readiness, early process death, malformed/mismatched launch IDs, large stderr output, startup timeout and occupied unrelated ports.
- [ ] Implement early single-instance registration, hidden startup WebView, piped initialization secret and authenticated health. Never pass secrets in arguments or URLs.
- [ ] Pin compatible Tauri 2 crates/JS CLI and Rust toolchain. Build production identifier gr.x3lixi.cratemind; use a separate preview identifier/data directory during acceptance.
- [ ] Run: cargo test --manifest-path native/src-tauri/Cargo.toml --test supervisor. Then launch a temporary-data development shell.
- [ ] Pass: one backend per app, no manual server, startup diagnostics in Greek and no unverified port/readiness assumptions. Review/commit.

## Task 5: Authenticate same-origin HTTP without breaking media

**Files:** Create backend/app/desktop_runtime/auth.py; backend/tests/test_desktop_http_boundary.py; native/src-tauri/src/security.rs. Modify desktop server and supervisor using Task 4 interfaces.

**Interfaces:** DesktopAuthMiddleware(app, origin, cookie_name, secret); install_session_cookie(window, origin, cookie_name, secret); service health accepts a dedicated Rust-only secret header.

- [ ] Test exact Host/mutating Origin, another loopback port, foreign supplied origins/referrers, missing/wrong cookie, forged forwarded headers, top-level navigation and absent metadata. Safe GET/HEAD with valid cookie also works without Origin/Referer; explicitly foreign headers fail.
- [ ] Implement the spec's streaming ASGI boundary, unique launch cookie and native cookie installation/readback before navigation. Send CSP and referrer headers from Python.
- [ ] Keep /api failures JSON; register SPA fallback last. Give the HTTP WebView no Tauri IPC/shell/filesystem permissions and restrict navigation/new windows.
- [ ] Verify real 200/206/416 responses, HEAD, range seeking, request cancellation and bounded streaming on every target WebView; middleware must not consume full media/request bodies.
- [ ] Run required MP3/FLAC/WAV/M4A/Ogg/Opus fixtures in this early spike. Do not enter M3 on an advertised target with an unresolved required codec. Define/test a bounded read-only ffmpeg compatibility path, seeking and load/security behavior first if needed.
- [ ] Run: cd backend && uv run pytest tests/test_desktop_http_boundary.py tests/test_audio.py tests/test_artwork.py.
- [ ] Pass: retained media works and cross-origin loopback requests fail. Review/commit.

## Task 6: Own jobs and the whole process tree

**Files:** Create backend/app/desktop_runtime/lifecycle.py and backend/tests/test_desktop_lifecycle.py; native/src-tauri/src/process_tree.rs; native/src-tauri/tests/process_tree.rs. Modify worker.py and supervisor.rs sequentially.

**Interfaces:** request_shutdown(timeout_s: float = 8) -> ShutdownReport; parent control record SHUTDOWN; child events describe shutdown completion. Track owned subprocesses, not arbitrary system processes.

- [ ] Test app close during scan/fingerprint, child crash, parent kill, stdin EOF, backend startup failure after spawning a helper, and next-launch orphan-job recovery.
- [ ] Reuse existing job ownership; stop admission, request cancellation and close DB handles. At eight seconds terminate/reap the owned tree.
- [ ] Stop audio before import and set server graceful shutdown below eight seconds; test active range streams so normal imports do not routinely force-kill.
- [ ] Use Windows Job Objects and Unix process groups/EOF handling. Keep Windows stdio enabled and hide console windows from Rust.
- [ ] Run lifecycle and Rust process-tree tests. Pass: no orphan helpers, no duplicate writer, existing completed transactions/cues survive.
- [ ] Review/commit.

## Task 7: Gate deferred workflows and add native actions

**Files:** Modify frontend/src/lib/api.ts and capabilities.tsx; pages/Library.tsx, Settings.tsx, UnifiedLibrary.tsx and CanonicalMetadata.tsx; components/ProfileEditor.tsx, BpmAnalysisCard.tsx, SoundCloudCard.tsx, SoundCloudReviewDrawer.tsx and IdentityLinker.tsx. Create backend/app/desktop_runtime/native_actions.py, native/src-tauri/src/native_actions.rs and focused frontend/backend/native tests.

**Interfaces:** Extend capabilities with provider_workflows, library_exchange, native_dialogs. NativeRequestV1/NativeResultV1 use the whitelist in the spec; authenticate all HTTP requests that can create native actions.

GET/PATCH /api/desktop/config use the versioned root/mapping format. PATCH validates/atomically saves a revision; after responding, restart_for_config requests supervised restart. Python is the sole config reader/writer; never hot-reset cached settings.

- [ ] Test older capability payload compatibility, stored-result display without automatic provider requests, absence of deferred actions and retained local canonical/collection controls.
- [ ] Hide the deferred calibration-review link as well as provider/BPM controls. Web keeps its fresh/stale-report behavior; retained identity browsing still works.
- [ ] Add native folder selection, export-folder selection, reveal and approved external-link actions through the narrow stdio bridge. Reveal resolves the device-local path; invalid export/source-root overlap is rejected. Canceling a dialog changes nothing.
- [ ] Add Settings root controls with mapped/unmapped/disconnected states from logical root descriptors/Track.volume_root. Native selection adds/remaps a root; restart makes it effective. Test imported unknown mounts, mapping, playback/M3U and absence of missing sweeps.
- [ ] Port Deno's useful window/menu/geometry behavior to Tauri; include every current retained route in navigation. Confirm Task 3's service-worker and prompt gates remain web-only, including deliberate port reuse and upgrades.
- [ ] Run: cd frontend && bun test tests/capabilities.test.ts tests/desktopRuntime.test.ts. Run native-action backend/Rust tests and frontend build.
- [ ] Pass: no deferred network calls or unguarded provider mutations; native paths/URL schemes are validated. Review/commit.

## Task 8: Persist preferences independently of the browser origin

**Files:** Create backend/app/desktop_runtime/preferences.py, frontend/src/lib/preferenceStorage.ts, backend/tests/test_desktop_preferences.py and frontend/tests/preferenceStorage.test.ts. Modify frontend/src/main.tsx, lib/prefs.ts, lib/theme.ts, lib/useResizable.ts, frontend/index.html, Library.tsx, TrackTable.tsx and Sidebar.tsx.

**Interfaces:** GET/PATCH /api/desktop/preferences; loadPreferences() before React render; a synchronous hydrated cache preserves existing get/set usage and queues atomic writes.

- [ ] Test sort, column widths, sidebar groups, light/dark theme, resized panels, display/player preferences and geometry across two launches with different ports.
- [ ] Replace desktop localStorage usage with the shared adapter and keep web behavior. Do not build browser-preference import/export; old display preferences can be set again while new desktop preferences persist.
- [ ] Keep device-specific values out of library handoffs. Validate corrupted/partial preference files and interrupted writes.
- [ ] Omit the web-only inline localStorage theme script from desktop HTML. Serve an allowlisted initial theme attribute from preferences before showing the window; hydrate before React render without a default-theme flash or script CSP violations. Preserve the web bootstrap.
- [ ] Run preference tests and frontend build. Pass: no first-render reset, no loss after restart, no secrets in preference files. Review/commit.

## Task 9: Onboard from web enrollment; retain bounded Deno-only adoption

**Files:** Create native/src-tauri/src/storage.rs; backend/app/desktop_runtime/adoption.py; backend/app/services/legacy_metadata_import.py; backend/app/api/legacy_import.py; backend/tests/test_desktop_adoption.py and test_legacy_metadata_import.py. Modify shared route registration/capabilities, frontend/src/lib/api.ts and the existing import control in Dashboard.tsx or Settings.tsx.

**Interfaces:** Import enrolled web S0 via shared exchange onboarding; inspect_deno_sources() -> SourcePreview[] and adopt_deno_source(source, new_dataset) -> VerifiedDataset cover Deno-only/empty starts. import_legacy_metadata(bundle, session) -> ImportReport preserves POST /api/import/json-backup on desktop-core only. Python owns restore/pointer recovery; storage.rs only locates app data. No developer-checkout/.env discovery.

- [ ] Test web S0 onboarding, Deno-only adoption, conflicting desktop history, WAL state, decisions, low disk/corruption and interrupted migration.
- [ ] Stop legacy writers and copy main DB/WAL files into staging before read-write backup/checkpoint helpers. Verify source bytes/mtimes unchanged; snapshot/migrate only private copies. Never rebuild identity or point Tauri at a live source database.
- [ ] Preserve Deno's metadata import as an explicit shared adapter with path/hash matching, ambiguous/unmatched reports, transactional rollback, FTS updates and manual BPM-consensus preservation. Wire its route/capability/UI separately from complete exchange and test the original desktop fixtures against the adapter.
- [ ] Switch active.json only after validation and retain originals/backups. Rollback selects the retained generation; it does not downgrade a newer database in place.
- [ ] Keep artwork/waveform/negative caches under the selected dataset generation. Test two generations sharing track IDs but different artwork/negative-cache results, including rollback.
- [ ] Run adoption/legacy tests plus existing test_backup_bundle.py and test_identity_sync.py. Pass: IDs, cues, sets, acceptances and audio bytes/mtimes survive. Review/commit.

## Task 10: Add device-local path resolution without rewriting identity

**Files:** Create backend/app/services/library_paths.py and backend/tests/test_library_paths.py. Modify configuration and filesystem boundaries in streaming, artwork, waveform, ffprobe_reader, fingerprint, hashing, scanner, provider_resolution and exporter_m3u.py. Task 7's native reveal consumes this adapter. Apply it in web-owned audio_analysis.py and provider file-submission call sites.

**Interfaces:** resolve_source_path(logical_path: str, mappings) -> Path; logical_source_path(local_path: Path, mappings) -> str; root membership uses parsed source-platform components.

- [ ] Test POSIX-to-Windows and different-mount replicas, case-sensitive roots, Greek/Unicode names, symlinks, nested/ambiguous mappings and disconnected roots.
- [ ] Test identical audio on two devices with different mtimes. Probe/scan writes follow the conservative revision policy; do not silently exclude last_scanned_at or mirrored identity JSON from conflict detection.
- [ ] Keep persisted catalog/identity logical paths unchanged. Resolve actual local paths only at filesystem boundaries; scanner writes logical paths into shared state and identity observations.
- [ ] Load device mappings in both web and desktop-core profiles, outside exchange content. Resolve local paths before web analysis/provider file submission without importing those modules on desktop. New roots require an explicit mapping; never mark an entire unmounted root missing as an import side effect.
- [ ] Run path tests and existing scanner/audio/waveform/artwork/identity tests. Verify IDs, decisions, playable paths and read-only row stability now; Task 12 adds integrated digest assertions. Scan/projection writes are revisions requiring export; a verified no-write delta remains clean.
- [ ] Test a desktop-created mapped track imported by web: stubbed analysis/provider consumers receive the web-local path, not the stored origin path; all human/provider decisions remain included in conflict detection.
- [ ] Test M3U exports on both mapped devices: emitted paths resolve to the local fixture files and stored logical paths/digest remain unchanged. Fail atomically with a named missing/unmapped list if a selected reference is unavailable. Keep CSV absolute_path as the documented logical/audit value.
- [ ] Review/commit; no domain model or identity ID redesign.

## Task 11: Close retained API and shared-UI parity

**Files:** Extend backend/tests/test_desktop_contract_inventory.py and focused existing tests; scripts/desktop/parity_scenarios.json. Modify existing handlers only for proven profile/package differences.

**Interfaces:** The saved 104-route inventory, Task 1 fixtures and Task 7 capabilities are the acceptance contract.

- [ ] Run retained scenarios against web and desktop-core apps on identical fixture copies; compare statuses, payload fields/booleans, ordering and durable side effects.
- [ ] Cover local library/search/tags, cues, duplicates, Memory Crates, sets/recommendations/pair notes, effective BPM/key, artists, all local identity/canonical/collection/recovery/provenance operations and safe exports.
- [ ] Ensure stored provider observations remain visible and preserved while deferred/provider-specific mutations are rejected. Optional artist LLM tests use stubbed responses, never live credentials.
- [ ] Wire desktop artwork mode in the actual artwork service: embedded/cached artwork or generated fallback only, never the remote SoundCloud redirect. Test with a stored provider URL while outbound access is unavailable.
- [ ] Verify schema completeness including cues, artist reviews and existing analysis/provider columns; no metadata-only substitute for complete backups.
- [ ] Exercise the shared export boundary with absolute/traversing filenames, symlink escapes and destination/source-root overlap. Repair confinement only where needed; audio bytes/mtimes must remain identical even with overwrite requested.
- [ ] Run affected backend tests and frontend build. Pass: every retained inventory entry has evidence, with only agreed exceptions. Review/commit.

## Task 12: Define shared complete-state exchange and lineage

**Files:** Create backend/app/library_exchange/{__init__,manifest,state,operations}.py; backend/tests/test_library_exchange.py. Reuse services/backup.py; do not duplicate its snapshot engine.

**Interfaces:** ExchangeManifestV1; export_exchange(paths, destination) -> VerifiedBundle; inspect_exchange(bundle, local_state) -> ExchangePreview; durable_state_digest(frozen_pair) -> str. Use the spec's standard-library .cmexchange ZIP with exchange.json plus the existing backup manifest/catalog/optional identity members.

- [ ] Test all durable edit families, initial lineage onboarding, same-lineage clones, unrelated libraries, replay/stale/unknown-parent snapshots and incompatible schemas.
- [ ] Compare imported schema descriptors with the generated supported contract; reject unknown/newer structures with a Greek update-required message. Digest absent tables as empty and absent columns as NULL, preserving every non-NULL durable value.
- [ ] Export S1, add an empty table/nullable column in web code and restart: S2 from the older supported replica still imports without a false conflict. Data-rewriting migrations remain revisions and do not reset pre-existing dirty edits.
- [ ] Compute semantic digest from the exact immutable paired backup, not the live engines. Version ordered table/row serialization and the explicit derived/operational exclusion list.
- [ ] Keep IDs, relationships and decisions; do not rematch/rebuild provider or canonical models during transfer. Bundle manifests preserve current checksums/integrity guarantees.
- [ ] Export a completed snapshot as the new baseline only after publication; write an export intent beforehand and recover publication/baseline crash windows before admitting writers.
- [ ] Reuse the exact published snapshot/parent/archive for unchanged re-export, retaining its immutable copy in app-owned exchange storage. Test A exports S1, repeats unchanged export, B edits/exports S2, A accepts S2; real new A edits still cause refusal.
- [ ] Take MaintenanceCoordinator's application-level exclusion before snapshotting, drain complete logical operations and keep admission closed through baseline publication. Do not acquire an outer SQLite reservation around create_backup.
- [ ] Run: cd backend && uv run pytest tests/test_library_exchange.py tests/test_backup_bundle.py.
- [ ] Pass: repeated export/replay is safe, corrupted bundles fail, and byte/path-based source_token is never treated as library lineage. Review/commit.

## Task 13: Make publication and staged import crash-safe on all targets

**Files:** Extend library_exchange/operations.py; modify services/backup.py; create backend/tests/test_library_exchange_failures.py.

**Interfaces:** prepare_import(bundle, local_state) -> ImportPreview; apply_import(preview, stopped_paths) -> VerifiedDataset; recover_exchange_intent(paths) -> RecoveryReport.

- [ ] Test low disk, checksum failure, truncated archive, unsafe member paths/symlinks, failure after paired snapshot, failure before/after bundle publication and failure around active pointer replacement.
- [ ] Add platform-aware atomic publication/durability, including Windows directory-handle behavior. Reuse original backup helper only after native tests pass.
- [ ] Refuse import if local durable state changed since baseline/preview. Preserve both histories and generate an actionable report; never last-writer-wins.
- [ ] Add an explicit replace-incoming resolution after fresh preview confirmation: publish a complete local conflict .cmexchange without advancing its baseline, preserve a rollback generation, then adopt the incoming branch. Failed conflict backup cancels replacement. Test divergent A/B, refusal, explicit replacement and a valid subsequent handoff.
- [ ] Extract only the named .cmexchange members into private staging, enforcing declared size/disk budgets and rejecting unexpected, duplicate, traversal or symlink entries before calling the existing backup verifier.
- [ ] Acquire the shared dataset ownership lease after services are stopped, then restore/migrate/verify in a new generation with engines closed. Refuse import while an idle enrolled service holds the lease. Preserve incoming digest and record the post-migration baseline separately.
- [ ] Run failure-injection tests on actual Windows/macOS/Linux filesystems. Pass: old active state or fully verified new state is selected after every crash; no partially mixed pair. Review/commit.

## Task 14: Integrate complete handoff into Tauri

**Files:** Create backend/app/desktop_runtime/exchange_control.py; frontend/src/components/LibraryExchange.tsx; backend/tests/test_desktop_exchange_control.py. Extend Settings, storage.rs and supervisor.rs.

**Interfaces:** Authenticated export/inspect endpoints; EXCHANGE_PREPARED registers immutable staging/digest and the selected decision with Rust. Commit returns 202; its after-response callback sends apply_exchange with verified preview_id/decision only. Rust stops the backend and invokes the fixed Python helper; only Python verifies/switches pointers and recovers state. Restart uses normal authentication; no remote Tauri IPC.

- [ ] Test export, import preview, same-lineage return handoff, replays, divergent desktop edits, busy jobs, user cancellation, service restart and failure rollback. Reject unknown/expired/stale preview IDs and caller-supplied commands/paths; verify the 202 response completes before shutdown and Rust retains ownership through restart.
- [ ] Show source lineage, snapshot, durable change summary and conflicts in Greek; distinguish complete exchange from legacy metadata import.
- [ ] Preserve per-device mappings/preferences. Refuse stale previews if local edits occurred. A failed/canceled import must not change active data.
- [ ] Expose “Αντικατάσταση με την εισερχόμενη έκδοση” only after a fresh conflict preview explains which local branch is being archived. Confirmation is bound to that local digest; cancellation changes nothing. Never bypass corruption/schema/lineage checks through the conflict action.
- [ ] Run control tests and frontend build; exercise installed desktop UI with two generated datasets.
- [ ] Pass: desktop edits survive desktop→web→desktop and web analysis/provider changes appear after return. Review/commit.

## Task 15: Enroll web and adapt its existing writers to shared handoff

**Files:** Create backend/app/library_exchange/cli.py, writer-entry-point inventory and tests. Integrate shared config/identity-path lookup into normal web startup and relevant reconciliation/provider script entry points; extend export integration and docs/README.md. Preserve algorithms/domain functions.

**Interfaces:** python -m app.library_exchange.cli enroll --catalog ... --identity ... --data-dir ...; export --data-dir ... --output ...; inspect --bundle ...; import --bundle ... --data-dir ... --require-stopped. An explicit conflict option requires confirmation of the preview/local digest. Raw DB paths are accepted for enrollment, not a way to bypass active-dataset ownership during normal exchange.

- [ ] Test native source Python and frozen helper interoperability, stopped-writer enforcement, absent optional identity DB and full return of desktop edits.
- [ ] Enroll stopped legacy web data first: copy DB/WAL files into staging, verify backup, restore a new generation, initialize lineage/S0 and active.json, leave originals intact and write an enrollment marker. Print CRATEMIND_DATASET_ROOT; updated unenrolled startup refuses the retired originals. Desktop then imports S0; it does not discover web's checkout.
- [ ] Include logical-root descriptors from source configuration/Track.volume_root in S0 and later manifests; preserve them separately from each receiver's local mapping. Empty optional identity is explicit, never paired with an old configured identity file.
- [ ] Add shared export integration; require offline/stopped-backend CLI import for the existing source web runner. Do not hot-swap its imported global DB engines.
- [ ] Enroll web explicitly with CRATEMIND_DATASET_ROOT; the ordinary documented uvicorn app.main:app command must resolve the new active pointer and exact identity partner before engine import. Reject stale/conflicting explicit path overrides; leave unenrolled installations unchanged.
- [ ] Inventory build_identity.py, calibrate_identity.py, preview.py, audit_consistency.py, validate_consolidation.py, promote_canonical.py and remaining provider/reconciliation entry points. Proven readers may use read-only snapshots; writers resolve the active pair and acquire maintenance ownership with the service stopped. Keep the builder's refusal to overwrite human decisions.
- [ ] Test every retained mutating script against the active generation and a running-service lease. No kept script may continue writing hardcoded backend/data paths after enrollment.
- [ ] Test the real source command in fresh processes: export, stop, import desktop edits, restart the same command, and observe new catalog/identity state through APIs. Include a stale explicit identity override, pointer rollback and import blocked by an idle service lease.
- [ ] Document the serial handoff procedure and divergence refusal. Automatic external sync is supported only if it honors the same stopped/consistent-pair and lineage rules.
- [ ] Run CLI tests and an A→B edit→A fixture roundtrip containing tags, cues, sets, collection decisions, provider state and BPM/key provenance.
- [ ] Pass: both directions use one format/implementation; no provider/domain fork or new continuous sync service. Review/commit.

## Task 16: Centralize native media tools and resource budgets

**Files:** Harden the media_tools.py, tool call sites, owned-process tests and resource configuration introduced in Task 3. Do not create a second invocation wrapper.

**Interfaces:** ToolRunner.run(tool, args, timeout_s, cancel_event) -> ToolResult; logical-to-local path resolution precedes execution; tool names resolve to bundled absolute executables.

- [ ] Test empty PATH, missing executable/library, unusual filenames, timeout, cancellation, simultaneous waveform/fingerprint jobs and application exit.
- [ ] Preserve existing algorithms, result/provenance semantics and explicit caller timeouts. Initially allow two media child processes, configurable 1–4, with bounded output.
- [ ] Keep the future worker interface in documentation only. Do not add BPM/key algorithms, a new scheduler or PCM-through-WebView IPC.
- [ ] Run media/scanner/fingerprint/waveform tests. Pass: bounded process count/memory behavior and responsive API/playback under fixture load. Review/commit.

## Task 17: Verify actual native-WebView UX and media parity

**Files:** Create scripts/desktop/native_qa.md and installed-app smoke runner; extend current frontend regression fixtures only where needed.

**Interfaces:** Scripted scenarios consume Task 11 inventory and app logs/health diagnostics. Native WebViews, not a Chromium browser alone, are required evidence.

- [ ] Verify every retained screen, keyboard tagging, dialogs/focus, Greek copy, reduced motion, WebGL, preferences, native menus, folder pickers and reconnect/error states.
- [ ] Include standard macOS Edit items for copy/paste/select-all, preserve typing/keyboard guards and avoid overriding app shortcuts. Restore focus after native dialogs and verify Tab navigation in the native WebView. Disable production browser reload/devtools/navigation accelerators while retaining useful accessible edit actions.
- [ ] Test representative supported MP3/FLAC/WAV/M4A/Ogg/Opus fixtures as baseline permits, pause/seek/range, cue persistence and a simultaneous scan. Keep existing AIFF refusal explicit.
- [ ] Repeat Task 5's already-established codec/compatibility behavior from installed artifacts; do not defer the initial codec decision to this late gate.
- [ ] Record startup, whole-process-tree idle/loaded memory, loaded-library scrolling and scan throughput under a fixed fixture corpus. Report medians/variation and actual installed/download sizes; set budgets from this baseline rather than invented framework numbers.
- [ ] Pass: native behavior and limitations are recorded per target with no unexplained regression. Review/commit.

## Task 18: Build and test final installers on clean systems

**Files:** Harden scripts/desktop/build_backend.py and stage_resources.py from Task 3; add verify_bundle.py and smoke_installed.py; native build overlays; .github/workflows/desktop.yml; packaging notice/inventory files.

**Interfaces:** Target build manifest pins Python, Tauri, Rust, retained dependencies and media-binary versions/hashes; stage_resources preserves complete onedir structure.

- [ ] Build native macOS arm64/x64, Windows x64 and Linux x64 artifacts. Freeze exact supported OS/library floors after clean-machine evidence.
- [ ] Name actual hardware/VM/authorized-CI evidence for each run. This workspace currently proves only a local macOS arm64 execution route; without other runners those targets remain untested release gates. Preparing CI files does not authorize a push or claim a CI result.
- [ ] Include only required shared code/subpackages, frontend, NumPy runtime libraries and tool resources with permissions/symlinks. Assert generated calibration reports, source databases, developer exports and .env files are absent. Windows includes offline WebView2 installation.
- [ ] Verify licenses/notices of exact ffmpeg/fpcalc builds and all bundled libraries; do not fetch binaries at first launch.
- [ ] Install offline without development tools; test source-root mappings, core flows, handoffs, child cleanup and update/rollback behavior from the installed artifact.
- [ ] Validate nested macOS signatures/notarization and Windows signatures before any distributable release claim. Signing/publishing credentials are not required to finish local planning or unsigned development artifacts.
- [ ] Pass: each advertised platform passes its installed-artifact matrix. Review/commit.

## Task 19: Document operations and stage a reversible cutover

**Files:** Modify docs/README.md and docs/CODEX_START_HERE.md; create docs/TAURI_DESKTOP_OPERATIONS.md.

**Interfaces:** Document exact build/dev/test commands, desktop/web scope, data locations, restart/recovery, handoff, optional online features and diagnostics.

- [ ] Rehearse adoption/cutover/rollback with fixture copies. Confirm old Deno/source Python data remains unchanged and is still usable.
- [ ] Explain retired-source markers during rollback: stop enrolled services first and use an isolated verified rollback copy or deliberate marker recovery, never concurrently restart an old writer against a retired source and call it synchronized.
- [ ] Explain serial exchange versus automatic merge, deferred workflows and stored-result refresh. Do not imply that a portable complete bundle includes audio files.
- [ ] Document the conflict replacement/archive action, including that play logging and scan writes create revisions. Preserve active/pending/conflict snapshots; default ordinary archive retention is ten and low-space failures do not delete protected history.
- [ ] Desktop-added tracks need an explicit web “Μόνο νέα” BPM/key run after handoff; existing web auto-analysis covers tracks added by its own scans, not all imported tracks.
- [ ] Keep the Deno implementation available until successful acceptance; archive/remove it only in a later deliberate cleanup.
- [ ] Pass: another agent can follow operations with no hidden runtime installations or undocumented data conversions. Review/commit.

## Task 20: Final acceptance and independent review

**Files:** Produce a factual validation report under docs/ with source revision, target artifacts, route matrix, commands, native QA, performance results and known gaps.

- [ ] Run full backend tests, existing frontend tests/build and native tests after integration. Suggested commands:

      cd backend && uv run pytest
      cd frontend && bun test tests && bun run build
      cargo test --manifest-path native/src-tauri/Cargo.toml
      python scripts/desktop/check_parity_inventory.py
      python scripts/desktop/verify_bundle.py --artifact <installed-artifact>

- [ ] Repeat installed-artifact gates for each advertised target and perform the complete two-way handoff/failure/recovery suite.
- [ ] Obtain independent architecture, data-safety and cross-platform review. Resolve blockers; distinguish untested targets from passing ones.
- [ ] Pass: retained parity is proven, exceptions match user scope, offline self-containment is real, originals are intact and rollback works. Do not claim production deployment, signing, unsupported platforms or performance measurements without evidence.

## Execution recommendation

Use supervised Codex native agents in dependency-ready lanes with one integration owner. Suggested parallel lanes after the shared runtime interfaces freeze: native shell/lifecycle; shared core/profile/parity; exchange/data safety; packaging/native QA. Keep changes to main.py, worker.py, shared manifests and build configuration serialized.

The highest-risk tasks are paired-state handoff, logical path mapping and packaged lifecycle. Review these before widening execution. The migration does not depend on completing the broader provider/collection refactor first, provided the shared API/schema contract is frozen and tested. If that refactor lands concurrently, integrate it once into the shared Python package and update the baseline rather than porting it again.

Planning artifacts are reviewable output. This document is not evidence that any runtime, parity, installer or performance gate has passed.

## Two-pass validation record

The requested GPT-6 Astra/high review was applied before the independent Claude Opus 5.5/xhigh review. Both reports are preserved under docs/superpowers/reviews/. This revision incorporates the second pass's plan corrections; it has not received a third model approval or runtime validation.
