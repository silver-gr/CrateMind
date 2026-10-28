# Tauri desktop migration — independent plan review, pass 1

Reviewer model: GPT-6 Astra
Reasoning effort: high
Project: existing CrateMind repository at /Users/silver/Projects/CrateMind
Reviewed: 2026-10-27
Scope: planning artifacts against current owning sources; no application changes, plan edits, database operations, builds or runtime validation.
Verdict: changes required before execution.

The shared Python core, explicit analysis/provider deferrals, serial handoff, same-origin media transport, native cookie bootstrap and installed-artifact gates are appropriate. The review found four grouped blockers. Existing safeguards in the plan should be preserved.

## 1. BLOCKERS & CONFLICTS

### B1 — P1: Define how the existing web runner selects the imported generation

**Evidence.** The [design](/Users/silver/Projects/CrateMind/docs/superpowers/specs/2026-10-27-tauri-desktop-migration-design.md:185) imports into a new directory and atomically switches active.json; Task 15's CLI uses --data-dir and intentionally avoids hot-swapping the web engines. However, [config.py](/Users/silver/Projects/CrateMind/backend/app/config.py:20) selects a fixed db_path, and [db.py](/Users/silver/Projects/CrateMind/backend/app/db.py:13) captures configuration at import time. Neither reads active.json. [identity_library.database_path](/Users/silver/Projects/CrateMind/backend/app/services/identity_library.py:13) also lets CRATEMIND_IDENTITY_DB_PATH override the catalog's sibling, potentially retaining the old identity database. Task 15 does not assign a web startup/configuration adapter.

**Consequence.** A stopped CLI import can validate and publish successfully while the normal documented web command restarts against the old catalog, or pairs the new catalog with the old explicit identity database. The planned fixture round trip alone would not prove the real web workflow.

**Minimal plan fix.** Add a shared, pre-import active-dataset resolver with an explicit opt-in web dataset-root configuration; preserve the legacy fixed-path default for installations not enrolled in exchange. Define configuration precedence and reject conflicting explicit catalog/identity overrides. Both the web runner and stopped CLI must resolve the same active generation, exchange state and mapping configuration. Assign ownership in Task 15/configuration work.

**Acceptance test.** Start the ordinary source web command in a fresh process using temporary enrolled configuration; export, stop, import desktop edits, restart that same command and verify API-visible catalog and identity changes. Include an old explicit identity override, conflicting catalog override, crash recovery and pointer rollback. Verify an unenrolled web installation retains existing path behavior.

### B2 — P1: Specify one exchange exclusion boundary covering complete operations, not only SQLite transactions or job submission

**Evidence.** The [design](/Users/silver/Projects/CrateMind/docs/superpowers/specs/2026-10-27-tauri-desktop-migration-design.md:179) requires writer admission paused through publication/baseline update, but no task defines its shared interface or all participants. The existing [submission_lock](/Users/silver/Projects/CrateMind/backend/app/jobs/worker.py:31) protects job dispatch only. Ordinary profile/cue routes use SQLModel sessions, while [write_canonical](/Users/silver/Projects/CrateMind/backend/app/api/identity.py:106) opens its own SQLite connection. [scanner.py](/Users/silver/Projects/CrateMind/backend/app/services/scanner.py:382) deliberately commits the catalog before synchronizing the identity database. [create_backup](/Users/silver/Projects/CrateMind/backend/app/services/backup.py:193) obtains paired SQLite write reservations internally; those reservations cannot identify a logical operation paused between its catalog and identity commits. Task 15 requires stopped-writer enforcement without defining a process ownership mechanism.

**Consequence.** An implementation that pauses job submission or merely wraps create_backup can capture a split logical operation, allow an HTTP mutation during baseline advancement, or accept a supposedly stopped import while an idle web process still owns old engines. Nesting the existing quiesce_writers around create_backup would also reacquire write reservations on separate connections.

**Minimal plan fix.** Define one small shared maintenance contract for both profiles: stop admission of every durable mutator, drain or refuse active logical operations/jobs through their final identity synchronization, then take the existing paired backup and hold admission closed until publication/baseline completion. Specify a dataset ownership lease honored by enrolled web startup, desktop and the import CLI, so --require-stopped is enforced rather than asserted. State that backup locking is acquired once. This is lifecycle coordination, not a new scheduler or domain transaction redesign.

**Acceptance test.** Pause a synthetic scan between catalog commit and identity sync; request export and prove it waits/refuses rather than publishing a mixed snapshot. Race cue/profile and canonical mutations with export and preview commit; every write must be wholly included or rejected/queued until the operation ends. An idle-but-running enrolled web process must prevent CLI import; killed ownership must recover safely. Assert the export path does not deadlock on nested SQLite reservations.

### B3 — P1: Calibration is a deferred provider-review workflow and dataset-specific output, not a generic packaged asset

**Evidence.** The route baseline retains GET /api/identity/calibration. Tasks 3 and 18 explicitly package calibration JSON/HTML. Yet [identity.py](/Users/silver/Projects/CrateMind/backend/app/api/identity.py:57) loads generated reconciliation files and validates projection_build_at against the active library. [calibrate_identity.py](/Users/silver/Projects/CrateMind/reconciliation/calibrate_identity.py:245) reads the developer's catalog/identity databases and embeds source metadata, collection examples and provider candidates in those reports. Its [renderer](/Users/silver/Projects/CrateMind/reconciliation/calibrate_identity.py:155) includes human provider-match verdicts and review-label export. [UnifiedLibrary.tsx](/Users/silver/Projects/CrateMind/frontend/src/pages/UnifiedLibrary.tsx:100) exposes that review link. This conflicts with the user's deferral of all Spotify/SoundCloud matching/provider-review workflows.

**Consequence.** Following the plan literally packages private library-derived reports, displays stale material for another dataset or yields a permanent 503, and retains a provider-review workflow the user deferred.

**Minimal plan fix.** Classify this route and UI action as deferred in desktop-core, preserving the web implementation. Update the baseline disposition and derived counts to 92 retained / 12 deferred, unless another explicitly agreed scope change is made. Remove generated calibration outputs from mandatory installer resources; resource allowlists must exclude developer datasets/reconciliation reports. Do not rebuild calibration or invent a new report-transfer subsystem for this migration.

**Acceptance test.** Desktop receives the same structured unavailable behavior for calibration as other deferred workflows and exposes no calibration-review link. Web retains its current fresh/stale-report tests. A package built from a checkout containing synthetic sentinel calibration reports contains none of their filenames/content, while retained identity browsing and stored accepted results still work.

### B4 — P2: Path mapping must cover exported playable paths

**Evidence.** [Task 10](/Users/silver/Projects/CrateMind/docs/superpowers/plans/2026-10-27-tauri-desktop-migration.md:194) lists playback/scanning/analysis filesystem consumers but omits exporter_m3u. The [current M3U exporter](/Users/silver/Projects/CrateMind/backend/app/services/exporter_m3u.py:19) writes Track.absolute_path verbatim. Under the plan this becomes the preserved logical/source-device path.

**Consequence.** Audio can play correctly inside desktop on machine B while an exported DJ set still references machine A's mount path. This breaks a retained user workflow on the exact cross-device scenario the mapping feature supports.

**Minimal plan fix.** Explicitly include M3U generation and native reveal actions in the logical-to-device path boundary. M3U output should use the selected device's resolved playable paths without mutating catalog paths. Define what happens for unmapped/unavailable tracks. State separately whether CSV absolute_path is an audit/logical value or a device-use value, so it is not changed accidentally.

**Acceptance test.** Import a fixture from a POSIX source root to a Windows/different-mount mapping, export a set, and verify each M3U file reference resolves to the destination fixture audio; source catalog/identity paths and digest remain unchanged. Repeat in the opposite direction and cover an unmapped track.

## 2. SIMPLIFICATION REQUESTS

### S1 — P2: Disable desktop service-worker registration, not just the install prompt

**Evidence.** Task 7 makes PWA install prompts web-only, but [main.tsx](/Users/silver/Projects/CrateMind/frontend/src/main.tsx:6) imports PWA registration unconditionally and [pwa.ts](/Users/silver/Projects/CrateMind/frontend/src/lib/pwa.ts:33) registers in every production build. [sw.js](/Users/silver/Projects/CrateMind/frontend/public/sw.js:6) adds an independent shell cache and navigation fallback. API requests already bypass this cache.

**Consequence.** Desktop gains a redundant persisted cache for ephemeral ports and an extra stale-shell/recovery path during restart or upgrade.

**Minimal plan fix.** Make both registration and prompts web-only before registration can occur, using an explicit desktop build/bootstrap mode. Keep the existing web PWA behavior.

**Acceptance test.** An installed desktop creates no service-worker registration/cache; a web production build still does. Backend failure and upgrade show the intended native recovery/new frontend, including deliberate port reuse.

### S2 — P2: Reuse an unchanged published handoff rather than minting needless lineage steps

**Evidence.** The design advances the baseline on export and accepts only the expected parent. It says repeated export/replay is safe but does not define whether exporting unchanged state creates another snapshot.

**Consequence.** A second unchanged export by A after B has received the first can move A's expected parent and make B's valid serial return look like a fork.

**Minimal plan fix.** Define unchanged re-export as reuse of the already-published immutable snapshot/parent, or otherwise preserve equivalent retry semantics without implementing general ancestor merging. Explain that an unsent export containing actual new edits is a different revision.

**Acceptance test.** A exports S1 to B, A repeats export without edits, B edits/exports S2, and A accepts S2. A real post-S1 edit still triggers divergence refusal.

### S3 — P2: Pull prerequisite tool/resource work forward; keep later tasks as hardening

**Evidence.** Task 3 requires a frozen artifact reporting actual packaged tool versions; Task 6 proves cancellation/tree cleanup of scan/fingerprint helpers; Task 16 first introduces centralized tool execution/resource control; Task 18 creates staging/resource verification scripts. The milestone table reads as a numeric dependency sequence although these dependencies run backward.

**Consequence.** Executors may duplicate temporary tool/process wrappers or report earlier gates green with PATH tools and mocks.

**Minimal plan fix.** Add explicit dependency edges. Move the minimum absolute tool resolution, resource staging and subprocess ownership interfaces ahead of Tasks 3/6; retain concurrency tuning and final installer matrix in Tasks 16/18.

**Acceptance test.** M1's isolated executable already resolves real bundled tools with an empty PATH, and M2's lifecycle tests exercise those same production invocation/ownership seams.

## 3. SUGGESTED IMPROVEMENTS

### I1 — P2: Complete the preference and early-theme inventory

**Evidence.** Task 8 names prefs, Library, TrackTable and Sidebar, but [theme.ts](/Users/silver/Projects/CrateMind/frontend/src/lib/theme.ts:15), [useResizable.ts](/Users/silver/Projects/CrateMind/frontend/src/lib/useResizable.ts:26) and the [inline theme bootstrap](/Users/silver/Projects/CrateMind/frontend/index.html:15) also read/write localStorage. The design's CSP audit mentions styles/fonts but does not explicitly reconcile that inline script.

**Consequence.** Theme and resized panels can reset on a port change, and CSP may block the prepaint theme logic.

**Minimal plan fix.** Add these owners to Task 8 and state how the hydrated preference theme reaches the document before the visible first paint, using the selected CSP policy rather than relaxing script execution generally.

**Acceptance test.** Light theme plus custom panel size survive two different-port launches with no visible dark/default flash and no CSP violations; web behavior remains intact.

### I2 — P2: Keep media caches scoped to the active dataset generation

**Evidence.** The proposed app-data layout puts cache outside datasets. Existing [artwork.py](/Users/silver/Projects/CrateMind/backend/app/services/artwork.py:21) currently isolates cache by catalog parent and then keys artwork/negative entries only by track ID. Moving that to a single shared desktop cache would remove the current dataset isolation.

**Consequence.** Adoption, unrelated-library replacement or rollback can show another dataset's artwork or suppress extraction because its track ID has an old .none entry. Waveform source signatures reduce this risk for waveforms but do not fix artwork.

**Minimal plan fix.** Retain generation-scoped cache directories or explicitly invalidate media caches on active-dataset changes; ensure the bootstrap cache path preserves this distinction. No content-addressed cache redesign is needed.

**Acceptance test.** Switch between two synthetic generations with the same track ID and different artwork, including a negative-cache case; each displays its own result and rollback restores correct behavior.

### I3 — P2: Include hostile export destinations in the existing source-audio safety gate

**Evidence.** The plan promises exports stay outside source libraries. [export._dest](/Users/silver/Projects/CrateMind/backend/app/api/export.py:34) simply joins a configured directory and filename, and [ExportRequest](/Users/silver/Projects/CrateMind/backend/app/schemas.py:164) has no filename confinement. Native export-directory selection adds another way to choose a source directory.

**Consequence.** Happy-path bytes/mtime checks do not prove the stated invariant for absolute names, traversal, symlinks or a source-root destination.

**Minimal plan fix.** Add destination containment and source-file non-overwrite cases to retained export acceptance; repair only the shared export boundary if they fail. Keep this bounded to the explicit source-safety promise.

**Acceptance test.** Synthetic source audio remains byte/mtime-identical when an export filename is absolute/traversing, a destination symlink points into the library, or the selected output directory overlaps a source root; invalid destinations fail clearly.

Evidence limits: this was a static plan/source review. No claim is made that Tauri native cookies, PyInstaller artifacts, cross-platform lifecycle or installed media playback already work. The plan's existing native spikes remain the right place to establish those facts.

<oai-mem-citation>
<citation_entries>
MEMORY.md:146-168|note=[prior architecture context checked against current sources]
</citation_entries>
<rollout_ids>
01a17778-f508-7a70-b940-9c3478037809
</rollout_ids>
</oai-mem-citation>
