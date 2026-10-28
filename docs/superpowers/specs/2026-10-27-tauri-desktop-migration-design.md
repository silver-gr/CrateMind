# CrateMind Tauri Desktop Migration — Design

Implementation follow-up: [local preview validation](../../TAURI_MIGRATION_VALIDATION.md).
The design status below records the original planning baseline.

Date: 2026-10-27
Status: implementation design; no application migration performed
Repository baseline: f71dc17ac596732ab14c3e81d9fe984210733c62

## Goal and agreed scope

Deliver one installable, self-contained Tauri 2 application using the existing React interface and a packaged, shared Python backend. Preserve current library-management behavior and data. Establish a maintainable boundary for native integrations without building another version of the provider/collection domain.

The user's later scope changes override the earlier request for unrestricted feature parity:

- BPM/key computation and its provider validation/review workflows stay in the existing Python/web application for now.
- SoundCloud and Spotify acquisition, matching, import and provider-review workflows stay in the web application for now.
- Desktop reads stored BPM/key, provenance, provider observations and accepted results, including their use in search, harmonic browsing, recommendations and sets.
- All library edits must travel in both directions: tags, profiles, cues, sets, collection/canonical decisions, provider state and analysis results.
- Automatic synchronization may exist externally. The migration must also support regular export/import.
- Do not recreate the complex Spotify/SoundCloud/local track and collection model in Rust or a separate desktop Python fork.

“Parity” below means retained functionality at the frozen baseline, with these explicit exceptions. Current placeholders such as Phrase Finder remain placeholders; roadmap implementation is not migration scope.

## Architecture decisions

1. Keep one Python domain implementation in backend/app. Introduce web and desktop-core runtime profiles; web remains the default and preserves existing behavior.
   Put create_app in a side-effect-free app_factory module. The source web main module instantiates it; the desktop imports the factory directly and never imports an implicitly instantiated web app.
2. Add a Tauri Rust host under native/, leaving desktop/ as the existing Deno fallback during migration.
3. Package Python with PyInstaller onedir. Ship its interpreter, all retained modules, supporting libraries, static frontend and required media tools inside the installer.
4. Python serves the packaged SPA and retained API from one authenticated ephemeral loopback origin. Retain relative /api URLs and streaming HTTP media. Do not proxy audio through JSON IPC or fetch entire tracks into blobs.
5. Rust supervises startup, native windows/menus/dialogs and the complete child-process tree. Rust does not open the application SQLite databases.
   Python alone resolves, writes and recovers active.json, exchange-state.json and pending-operation records. Rust owns only the application-data location, single-instance/window/process lifecycle and stop→fixed-helper→restart orchestration. It does not implement a second pointer-switch algorithm.
6. Keep SQLModel models, SQL functions, canonical projection rules, identity synchronization, collection operations and backup services shared. Refactor only runtime/dependency seams needed by this migration.
   The broader BPM-provider and Spotify/SoundCloud/local-domain cleanup remains a shared web/backend follow-up. Freeze a tested core API/schema contract for packaging; do not copy its current complexity into a second model.
7. Use existing Python jobs for scanning, duplicate detection and fingerprinting. Add lifecycle/resource-control adapters rather than a second scheduler.
8. Retain NumPy for the existing waveform implementation. Exclude SciPy, librosa, Essentia and analysis-only clients after verifying the desktop import graph.
9. Freeze compatible Tauri 2/Rust/Python/library/tool versions per release. Proposed core Python line: CPython 3.13, subject to the packaging spike. Existing web analysis environments remain supported independently.

Self-contained means no installed Python, Node, Bun, Deno, uv, Homebrew or development tools; no user-started backend; no network needed to install or perform core operations. Multiple supervised local processes are acceptable. Optional artist enrichment retains existing configured behavior and is not required for offline operation.

## Code evidence and parity baseline

The adjacent 2026-10-27-tauri-parity-baseline.json records all 104 Python HTTP routes, their source locations and desktop disposition. It contains 92 retained routes and 12 explicit deferrals:

- All five /api/analysis/bpm/* routes.
- POST /api/scan/analyze.
- All five /api/soundcloud/* routes.
- GET /api/identity/calibration and its generated provider-review link.

No standalone Spotify router exists at this baseline. Provider-specific actions also occur inside generic identity endpoints; those need request-level profile guards and matching UI gates, not deletion of the identity subsystem.

Every baseline route now has a desktop_guard, and future desktop/exchange routes have a separate planned_routes inventory rather than changing the historical 104-route count. The identity mutation policy is exact:

| Route/action | Desktop policy |
|---|---|
| confirm-identity, reject-identity, undo-identity, canonical/revoke-identity | Resolve both entities from the current identity DB; permit only local↔local requests. A client-declared service or ID prefix is not authoritative. |
| canonical/decision and canonical/pattern-accept | Retain shared metadata decisions, including choosing among already stored provider observations. |
| native collections, algebra/priority views, consolidation, lineage and recovery decisions | Retain shared behavior. |
| retire-asset | Retain the existing local-asset-only behavior. |
| replay of previously decided links and automatic candidate refresh during identity sync | Explicitly allowed as shared derived maintenance; it creates no new explicit provider-review decision. |

Desktop IdentityLinker offers only local candidates/actions. Read-only stored Spotify/SoundCloud observations remain visible. Deferred responses use a Greek string detail and a separate machine-readable code, never an object in detail.

Important owning sources:

| Concern | Current source |
|---|---|
| Shared frontend and feature gates | frontend/src/app/App.tsx; frontend/src/lib/api.ts; frontend/src/lib/capabilities.tsx |
| All core routes and capabilities | backend/app/main.py; backend/app/api/ |
| Import-time configuration/engine | backend/app/config.py; backend/app/db.py |
| Core jobs and automatic analysis | backend/app/jobs/worker.py |
| Existing DSP dependency graph | backend/app/services/audio_analysis.py |
| Waveforms/artwork | backend/app/services/waveform.py; backend/app/services/artwork.py |
| Paired catalog/identity backup | backend/app/services/backup.py |
| Identity ownership/projection | backend/app/services/identity_library.py; identity_sync.py; canonical_library.py |
| Deno-specific metadata import | desktop/src/api/importer.ts |
| Desktop data/window behavior | desktop/src/services/appPaths.ts; desktop/src/services/config.ts; desktop/src/desktop/window.ts |

Code inspection found eager DSP imports through both main -> analysis and scan -> worker -> audio_analysis. Hiding analysis routes alone does not remove that dependency tree. Local identity matching also imports SoundCloud normalization helpers; retain those shared local helpers.

## Runtime-profile contract

Provide RuntimeProfile = web | desktop-core before importing app.db or application routers. Default web behavior and existing web tests remain intact.

Desktop-core:

- Retains existing models and all stored columns/tables, including analysis/provider columns.
- Registers retained APIs using the same handlers and services.
- Disables the 12 deferred routes with a structured 501 feature-unavailable response.
- Prevents scan completion from launching BPM/key analysis; keeps local artist rebuilding, duplicate safeguards and identity synchronization.
- Rejects SoundCloud/Spotify-specific linking/review mutations through generic identity handlers; retains local-asset linking, local canonical decisions, collections and read-only provider observations.
- Does not initialize provider fetchers, credentials, analysis workers or remote artwork fallback automatically.
- Does not serve or package dataset-specific calibration reports; those remain web-owned provider-review output.
- Serves embedded/cached artwork or the existing generated fallback offline.
- Preserves optional artist enrichment/comparison using existing configuration; this is not a new dependency on online service availability.

Extend capabilities compatibly with provider_workflows, library_exchange and native_dialogs. Keep existing booleans. Missing new fields from an older web/Deno response must select the documented legacy behavior rather than breaking startup. In desktop-core, analysis and provider_workflows are false; library_exchange and native_dialogs are true. Other capabilities describe real data/tool/config availability, not the shell's name.

Hide deferred actions and automatic provider requests in the shared UI. Preserve read-only stored result cards. Explain the web-owned actions in Greek; do not present failed requests as implementation errors.

Create an explicit desktop frontend build mode before packaging. It disables both service-worker registration and PWA prompts; the web production build retains them. Do not add a redundant persisted shell cache to changing loopback origins. The desktop HTML omits the web-only inline localStorage theme bootstrap; Python supplies an allowlisted initial theme attribute before the WebView becomes visible, and external frontend code hydrates the same preference state without relaxing script CSP.

## Launch, origin and native boundary

Parent-to-child initialization is a versioned JSON record on stdin:

    DesktopInitV1 {
      protocol_version: 1,
      launch_id: string,
      session_secret: string,
      paths: { app_data, resources },
      tools: { ffmpeg, ffprobe, fpcalc },
      runtime_profile: "desktop-core"
    }

Python resolves the active generation, catalog/identity pair, generation cache, exports and mappings from app_data and explicit desktop configuration before importing application modules. Rust does not pre-resolve database paths. Disable development .env discovery in desktop-core; never ship local .env files or credentials.

Startup:

1. Establish single-instance ownership before starting Python.
2. Spawn the packaged executable by resolved resource path; pipe stdin/stdout/stderr and continuously drain them.
3. Python binds 127.0.0.1:0 and retains that socket. Emit BOUND with port, protocol version and launch_id; pass the same socket to Uvicorn. No free-port discovery/rebind race.
4. Rust waits for authenticated health and lifespan completion, watching for early child exit. Default timeout: 90 seconds; Greek startup/retry diagnostics retain the failing phase.
5. Rust creates the hidden WebView on bundled startup HTML and installs a launch-specific HttpOnly, SameSite=Strict session cookie natively before navigating. Keep secrets out of URLs, command arguments, frontend storage and logs. Read cookies from an async context where required by WebView2.
6. Navigate to the exact server origin and show the main window only after a successful load.

Use a unique launch-specific cookie name; host cookies are not port-isolated. An outer streaming ASGI boundary validates the cookie and exact Host authority. Mutations require exact Origin. On safe GET/HEAD, do not require Origin/Referer presence because native media stacks may omit them, but reject explicitly foreign Origin/Referer and conflicting Fetch Metadata when present. Test valid same-origin media with omitted headers; missing authentication still fails. Root document navigation has its own authenticated navigation policy. Rust health uses a distinct authenticated header and does not bypass other endpoints. No permissive desktop CORS or proxy-header trust.

Send a CSP allowing packaged/self-hosted scripts/styles/fonts, required inline-style behavior of current UI, and same-origin media/connect; explicitly handle the audited existing style/font requirements. Avoid introducing unsafe script evaluation. Serve Referrer-Policy: same-origin. Unknown /api paths remain API errors, never SPA HTML.

The HTTP-served main WebView initially gets no Tauri IPC, filesystem or shell capabilities. Native Settings actions go through a small authenticated Python-to-Rust request protocol:

    NativeRequestV1 { id, action: pick_library_roots | pick_export_dir | reveal_path | open_external | apply_exchange | restart_for_config, arguments }
    NativeResultV1 { id, canceled, value?, error? }

For apply_exchange, arguments identify only a previously verified preview and its explicit decision; no arbitrary paths/commands are accepted. The backend registers a bounded EXCHANGE_PREPARED record with Rust, identifying an immutable staging bundle by ID/digest and any conflict-replacement confirmation. The HTTP commit response is 202; enqueue the native commit from an after-response callback so the response completes before intentional shutdown. Rust then owns stop, fixed Python helper execution and authenticated restart; the Python helper alone verifies/imports/switches the active pointer. Unknown, stale, changed or expired previews fail without touching active data.

GET/PATCH /api/desktop/config expose validated per-device configuration. Version 1 includes library_roots entries with root_key, logical_prefix, logical_flavor (posix/windows), local_prefix and enabled. root_key is stable for the logical source root; entries originate from stored Track.volume_root plus enrolled source-root descriptors. A Settings panel shows mapped/unmapped/disconnected states, adds a new logical root or maps an imported root through the native picker, and validates component boundaries/ambiguity before saving. PATCH writes atomically and returns a new configuration revision; its after-response restart_for_config action passes only that revision. Python reloads settings through a normal supervised restart. Do not clear cached settings or hot-swap roots in a running backend. Unmapped roots do not prevent opening Settings and never trigger a global missing sweep.

Validate paths/schemes and correlate replies. Native menus are owned by Rust. Restrict window navigation to the exact current origin; open approved http/https external links in the system browser. Block arbitrary file/javascript/custom-command navigation.

## Persistence and database adoption

The packaged resource directory is read-only. Keep configuration, logs, preferences, datasets, caches, backups and exports under application-owned writable paths.

Use an atomic active-dataset pointer outside SQLite:

    app_data/
      active.json
      desktop-config.json
      preferences.json
      datasets/<generation>/catalog.sqlite
      datasets/<generation>/identity.sqlite
      datasets/<generation>/exchange-state.json
      datasets/<generation>/cache/
      backups/
      exports/
      exchange/
      logs/

There is one Python application writer per active local dataset. A separate web replica uses its own local dataset. External synchronization must not copy/replace live SQLite/WAL files underneath either application.

Use one shared pre-import active-dataset resolver. When CRATEMIND_DATASET_ROOT is set, both ordinary web startup and desktop startup resolve active.json to the catalog, its exact optional identity partner, generation-scoped cache and exchange state before app.db is imported. Reject conflicting explicit CRATEMIND_DB_PATH/CRATEMIND_IDENTITY_DB_PATH overrides rather than mixing generations. Matching explicit paths may be accepted after validation. Unenrolled web installations keep the existing fixed-path defaults. New exchange operations require enrollment; the stopped CLI and restarted ordinary web command must resolve the same dataset root.

The normal two-app workflow enrolls web first through the shared stopped-source CLI: enroll --catalog ... --identity ... --data-dir .... It records a verified private copy, initializes lineage and S0, writes the active pointer and returns CRATEMIND_DATASET_ROOT. Originals remain intact, with a small non-secret enrollment marker beside them; updated unenrolled startup refuses those retired originals. Desktop imports S0 rather than discovering a checkout/.env. A Deno-only/empty installation is an explicit alternate initial authority; a later empty web replica imports that lineage instead of enrolling an unrelated history.

Put dataset resolution/ownership in shared config/identity path access, not only the HTTP runner. Inventory provider/reconciliation writer entry points, including build_identity.py, calibrate_identity.py, preview.py, audit_consistency.py, validate_consolidation.py and promote_canonical.py. Each must either be proven read-only or resolve the active generation and acquire its maintenance lease while the service is stopped. Preserve existing algorithms and the builder's refusal to overwrite human decisions; migrating paths/ownership is not authorization to rebuild identity. Do not leave scripts writing hardcoded backend/data databases after enrollment.

Enrolled services hold an OS-backed exclusive DatasetLease on the dataset root for their complete lifetime, including idle periods. The stopped import CLI must acquire that same lease; a PID file or successful SQLite connection does not prove the app is stopped. The OS releases the lease on process death. Recovery and active-pointer validation happen before writers are admitted.

Startup upgrades are covered as well as imports. Before any enrolled startup schema change or lazy durable table initialization, take a verified paired pre-migration backup under the lease. Materialize the known shared schema through production helpers before reporting readiness; do not let first browsing silently create untracked durable schema. Record data-rewriting migrations as explicit local revisions without erasing pre-existing dirty edits or advancing the last published baseline until export.

Use one small shared MaintenanceCoordinator in both profiles. Its operation scope covers every durable logical mutation through its final catalog/identity synchronization, including HTTP edits, canonical writes and background jobs. Pausing job submission alone is insufficient. Export stops new durable admission, then drains active operations/jobs or returns a bounded busy result, calls create_backup once, and keeps admission closed through publication/baseline advancement. Do not wrap create_backup in another SQLite quiesce_writers reservation. This coordinates existing jobs/services rather than adding a scheduler or redesigning domain transactions.

Adoption:

1. Import web S0 from enrollment, or discover only explicitly supported Deno-only sources without importing app.db. Never silently combine unrelated histories.
2. Require legacy source writers stopped and take a stable raw copy of main database files plus existing WAL files into private staging before invoking existing helpers that open databases read-write. Snapshot/recover/checkpoint only the staging copy. Recheck source signatures/bytes to detect a concurrent change; old uncooperative binaries are an explicit stopped-writer precondition, not something a new lock magically controls. Existing Python lifespan's post-migration backup cannot provide the first snapshot.
3. Restore into a new dataset directory. Preserve primary keys, track/cue/set relationships, identity IDs, accepted/rejected decisions and source paths.
4. Configure the restored catalog filename explicitly; current restore produces catalog.sqlite.
5. Run shared additive migration only on the clone; verify integrity, IDs, decisions and representative workflows, then publish active.json atomically.
6. Retain original data and the verified backup. Never invoke reconciliation/build_identity.py as an upgrade mechanism.

Deno metadata JSON import is a separate, explicit legacy reconciliation operation. It is not a full restore and must report unmatched/ambiguous items. Preserve its useful desktop-only behavior through one shared Python adapter, using the existing TS contract/fixtures as the reference.

Frontend preferences cannot depend on loopback localStorage because the port/origin changes on restart. Hydrate a process-local frontend preference cache from backend-owned preferences.json before rendering, then persist changes atomically. Include library sorting, table column widths, sidebar state and current app preferences. Per-device paths/window geometry/volume do not travel as library edits.

Do not add a browser-preference import/export feature in this migration. Persist all new desktop settings correctly; users may set old web/Deno display preferences again. This does not alter library data.

The preference inventory also includes theme.ts, useResizable.ts and frontend/index.html's early theme setup. Theme and panel sizes must survive different-port launches without a visible default-theme flash or CSP errors. Keep media caches scoped to the active dataset generation, including negative artwork entries; switching/rolling back between identical track IDs in different datasets must not reuse another library's cached artwork.

## Two-way export/import contract

Provide complete-state handoff in either direction using the existing verified catalog+identity backup machinery. Include tags, profiles, cues, sets, searches, collection/canonical decisions, analysis results and provider state. Audio files, secrets, device preferences and caches stay outside bundles.

This release supports serial handoff and explicit conflict detection. It does not silently merge concurrent divergent edits and does not implement a continuous sync service or a second collection/identity model.

Add versioned exchange lineage around existing backups:

Use a single .cmexchange ZIP container made with the Python standard library. Its only members are exchange.json, backup/manifest.json, backup/catalog.sqlite and optional backup/identity.sqlite. The backup members are the existing verified backup output; exchange.json wraps lineage and semantic digest. Stream extraction into private staging, reject unexpected/duplicate/absolute/traversal/symlink entries, verify declared sizes and available disk before extraction, enforce those sizes while streaming, then call the existing backup verifier. Never unpack over active data. This avoids users accidentally transferring only today's metadata JSON while omitting its companion databases.

    ExchangeManifestV1 {
      format_version: 1,
      lineage_id: uuid,
      snapshot_id: uuid,
      parent_snapshot_id: uuid | null,
      schema_contract: { fingerprint, normalized_catalog_schema, normalized_identity_schema },
      logical_roots: [{ root_key, logical_prefix, logical_flavor }],
      state_digest: string,
      files: verified backup manifest entries
    }

Existing backup source_token is path-based and is not a library identity. A shared exchange-state.json records adopted/exported baseline snapshot and semantic state digest; it travels with a verified handoff. Export establishes the new handoff baseline only after atomic bundle publication succeeds.

If state and schema are unchanged from the last published baseline, re-export reuses that exact immutable snapshot ID, parent and archive bytes; copying it to another destination does not advance lineage. Keep the needed baseline archive in application-owned exchange storage, independent of whether the user deletes an external export copy. Real new edits create a new revision. A→B export, unchanged A re-export and edited B→A return must remain a valid serial handoff.

Generate the supported schema contract from temporary catalog/identity databases using the production initializers/known lazy schema helpers at build time. Fingerprint normalized table/column affinity, keys and supported constraints for both databases; model/schema changes must alter this contract. Import accepts only tables/columns/structural contracts known to the importer after its supported migrations. A newer-schema bundle refused by an older build gets a Greek update-required message; do not rely on a manually bumped compatibility integer or SQLite merely opening the file.

The shared state_digest covers durable row values in both immutable snapshot databases and sorted logical-root descriptors, using deterministic serialization/order; local mount bindings stay excluded. For purely additive compatibility, an absent table is equivalent to an empty table, and absent columns are equivalent to NULL: omit empty tables and NULL-valued fields from the value digest. Keep this serialization version stable across additive schema versions. Schema compatibility is separate. Never omit non-NULL human/provider values to hide conflicts. Exclude only enumerated derived FTS/shadow tables and tested operational caches/jobs, and never use file mtimes. Additive empty/NULL initialization stays clean; data rewrites are revisions until published and cannot reset dirty user changes.

Conservative v1 rule: scans or projection refreshes that write timestamps/observation metadata count as local revisions even when the audio is unchanged. They must be exported before accepting a conflicting return snapshot. Pure reads and mapping changes do not dirty the baseline. A truly no-write delta scan remains clean; do not promise that every unchanged-file scan is a no-write operation. Test full and delta scans against their actual declared write behavior. Avoid a second, field-normalizing copy of the complex identity/provider domain solely to hide these writes.

Compute the digest from the exact immutable paired backup that will be exchanged, after writer admission is paused. Keep writers paused until publication and baseline update complete. Persist an export-intent record before publishing; recover interrupted publication/baseline advancement on restart before allowing writes. Failed publication must not advance the baseline.

The first authoritative installation assigns lineage_id once and makes an onboarding snapshot with null parent. A new replica adopts that lineage only into a new/empty or explicitly backed-up destination; an existing unrelated lineage is never silently combined. A known already-applied snapshot is a no-op; a stale ancestor never replaces current state; unknown parents and incompatible schema versions are refused with an actionable report.

Normal import requires matching lineage, compatible schema, valid checksums/integrity, the expected parent and a local durable state matching its baseline. If histories diverge, refuse automatic replacement and show the concrete differences. Provide an explicit non-merging action, “Αντικατάσταση με την εισερχόμενη έκδοση”: require confirmation bound to the fresh preview/local digest, first publish a verified conflict .cmexchange containing all local state, retain its rollback generation, then adopt the incoming snapshot/lineage baseline. If the conflict backup fails, replacement cannot proceed. The next handoff continues from the incoming branch; no values are silently merged and no source audio is changed. The stopped web CLI exposes the same deliberate resolution mode. This supports all edits in either direction and recovery from divergence, not automatic reconciliation of simultaneous edits.

Stop audio and stop/drain jobs before import; configure server graceful shutdown below the eight-second process-tree deadline. Python restores/migrates/verifies a new directory, switches active.json atomically, then the service restarts. Failed imports leave old active data intact. Record the incoming digest and post-initialization local digest separately; additive empty/NULL migrations retain a clean value baseline, while meaningful data rewrites remain a local migration revision. Cross-version exchange must satisfy the generated schema contract.

Root mapping is a shared Python facility with a device-local configuration overlay available in both runtime profiles, outside the exchanged databases and semantic digest. Desktop stores it in desktop-config.json; the web profile loads its own explicit device mapping file. Keep stored logical paths unchanged, including identity metadata JSON. Define resolve_source_path(logical_path, mappings) -> local Path and logical_source_path(local_path, mappings) -> stored logical path. Match whole components using the logical path's source-platform flavor, not string startsWith; reject ambiguous/overlapping mappings. Resolve at every filesystem boundary: playback, provider availability, waveform/artwork, fingerprints, hashes, scanner reads and web-owned analysis/provider audio-file submission. The scanner writes logical paths and logical roots into shared state; it must not feed mapped device paths into identity synchronization. New roots receive an explicit logical/local mapping. Preserve source paths and entity IDs; do not rewrite Track.absolute_path alone.

M3U exports and native reveal actions also resolve paths for the current device without mutating stored paths. An M3U export containing an unmapped or unavailable selected file fails before publication with an actionable list; it never emits another device's path or silently omits tracks. CSV absolute_path remains the stored logical/audit value and is documented as such.

An A-to-B import under different mount roots and B-to-A export must keep IDs, canonical decisions and playable paths stable. Pure reads/mapping changes preserve the baseline digest. If a scan writes operational metadata it produces a revision and must be exported under the conservative rule above; it must still preserve identity IDs and decisions. A desktop-added mapped track returned to the web app must reach analysis using the web machine's resolved local path. Missing/unmounted roots require an explicit mapping/availability state, never a global missing sweep.

Desktop provides export/import preview and commit UI. Web exports through the shared service/API and imports using a stopped-backend CLI in v1; no fragile hot-swap of the current web process's imported global engines. This must be documented as the operational handoff procedure.

## Native/media foundation and lifecycle

Retain original-file HTTP Range playback, single-audible-deck behavior, listening cues, waveform/RMS generation, embedded artwork, metadata probing and acoustic fingerprints. Preserve current codec limitations, including the existing AIFF refusal, until a separately tested playback change is requested.

Centralize absolute tool resolution and process ownership. Bundle ffmpeg, ffprobe and fpcalc with their required libraries/notices; no PATH/Homebrew dependency. Initial media subprocess concurrency is bounded at two, configurable from one to four. Existing caller timeouts remain explicit. Process cancellation must reap children; no PCM JSON transfer through the WebView.

The minimum production resource staging, absolute tool resolver and owned-process interface must exist in the first frozen-core spike, before shell/lifecycle acceptance. Later resource-budget and installer tasks harden those same interfaces; they do not introduce a second temporary implementation.

Keep a future native-worker protocol boundary documented, but build no BPM/key worker, new DSP algorithm, plugin host, DJ deck or real-time audio engine in this migration.

Graceful shutdown requests job stop, drains output and closes databases. At eight seconds, Rust terminates/reaps the process tree. Use Windows Job Objects; use Unix process groups plus parent-pipe EOF handling. Unexpected child exit displays recovery UI and never starts a second concurrent backend. Existing interrupted-job recovery must remain valid.

Keep at most ten ordinary completed handoff archives by default, but never prune the active baseline, pending-operation references or conflict archives automatically. Keep conflict/rollback retention visible and configurable; low space fails safely instead of deleting required history. A retained baseline archive remains usable even if an external export copy is removed.

## Packaging and acceptance

Ship separate native builds for macOS arm64, macOS x64, Windows x64 and Linux x64. Proposed test floors are macOS 14, Windows 10/11 and Ubuntu 22.04; the packaging spike must verify the actual dependency/SDK floor before release claims. A platform remains incomplete until its installed artifact passes.

Preserve the full PyInstaller onedir tree, symlinks and executable permissions using Tauri resources, not only an externalBin executable. Keep Windows stdio functional and suppress console windows in the Rust launcher. Package an explicit allowlist of required code, compiled frontend, runtime libraries, media binaries and notices. Exclude generated calibration JSON/HTML, developer datasets, reconciliation outputs, databases and .env files. Required reconciliation source modules may still be shared/packageable code; do not confuse code with generated private reports. Lock dependency/tool versions and hashes; generate notices and dependency inventories.

Make backup publication and directory durability platform-aware. The existing helper uses POSIX-style directory fsync; Windows export/import requires a tested replacement with explicit atomic-rename/durability behavior rather than assuming the helper works unchanged.

For offline Windows installation, include the WebView2 offline installer rather than relying on a downloading bootstrapper. Linux runtime-library requirements must be bundled via a tested supported format or clearly established as supported OS components; no developer package installation at launch.

Required gates:

- Frozen core starts with no SciPy/librosa/Essentia/analysis-client imports; NumPy waveform use is allowed.
- Web profile's existing behavior/tests remain valid.
- Every retained API and core UI workflow has a mapped verification owner.
- No source audio bytes or mtimes change during scan, analysis-result display, fingerprint, export, adoption or handoff.
- Export destinations reject absolute/traversal filenames, symlink escapes and output/source-root overlap before any source file can be overwritten.
- Clean-machine offline install works without Python/Node/Bun/Deno/media tools.
- Native WKWebView/WebView2/WebKitGTK pass media authentication, playback/seek/range, cues, WebGL/reduced motion and restart tests.
- Source and adopted databases retain IDs/relationships/decisions; handoffs preserve edits both ways and reject divergence safely.
- No orphan child processes, simultaneous writers or secrets in diagnostics.
- Signed/notarized final installers and update artifacts pass installed-artifact verification. No publishing or rollout is authorized by this planning task.

Only local macOS arm64 execution is currently evidenced by the workspace. Intel Mac, Windows and Linux runs require actual hardware/VMs or authorized CI later; until then they are explicitly untested release gates, not successful platforms. Test required codecs in the early Task 5 native spike, before M3. If a required codec fails, decide/test the bounded bundled-ffmpeg compatibility path and its seeking/load/security behavior before proceeding; do not silently drop the format.

## References

- [Tauri Python/executable sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri resource layouts](https://v2.tauri.app/develop/resources/)
- [Native cookie API](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.set_cookie)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Windows WebView2 installation](https://v2.tauri.app/distribute/windows-installer/)
- [PyInstaller operating modes](https://pyinstaller.org/en/stable/operating-mode.html)
- [Frozen multiprocessing and stdio](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html)

Evidence was source/git inspection and current official documentation. No application migration, packaging spike, database operation or runtime validation has been performed by this design task.
