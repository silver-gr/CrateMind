# Tauri desktop operations

The desktop uses the existing React interface and shared Python services. Its bundled Python runtime, NumPy, librosa/SciPy, ffmpeg, ffprobe and fpcalc run locally. Desktop computes BPM/key locally, without providers, after a scan adds tracks and from Settings. The BPM review (provider comparison), Essentia and SoundCloud/Spotify acquisition, matching and provider review remain in the web application. Stored results remain available on desktop. Optional artist enrichment still requires its configured service.

Window chrome differs per platform. On macOS the main window uses the native overlay title bar (traffic lights over the page's 32 px drag strip) and the native app menu. On Windows the main window is borderless: the page draws the same strip with its own minimise, maximise/restore and close buttons, and there is no native menu (the sidebar and command palette cover its screens). The page may only drag the window, toggle maximise by double-click and, on Windows, minimise, maximise or close it (`native/src-tauri/src/security.rs`).

The legacy Deno application and its `desktop/` source were retired on 2026-10-29.
The supported Tauri host is in `native/`. Existing Deno databases, music and
backups remain in their original locations, including
`~/Library/Application Support/CrateMind`; source retirement does not migrate or
delete that data. The bounded Python importer below remains available. Its
schema evidence lives in `backend/tests/fixtures/deno_legacy/`; historical source
paths in the shipped contract identify those original bytes. Do not run two
writers against the same catalog. Implementation verification uses generated
fixtures, never a scan or conversion of the user's live library.

## Build and local verification

Run commands from the repository root unless a working directory is shown. Keep expensive commands sequential on machines with limited memory.

```sh
cd backend
UV_PROJECT_ENVIRONMENT=.venv-desktop uv sync --locked --python 3.13.18 --no-default-groups --group desktop
cd ../frontend
bun install --frozen-lockfile
bun test tests
bun run build:desktop
cd ..
python3 scripts/desktop/build_backend.py --self-test
python3 scripts/desktop/stage_resources.py --ffmpeg /absolute/path/to/ffmpeg --ffprobe /absolute/path/to/ffprobe --fpcalc /absolute/path/to/fpcalc
python3 scripts/desktop/verify_bundle.py --artifact native/src-tauri/resources
python3 scripts/desktop/smoke_installed.py --artifact native/src-tauri/resources
cd native
bun install --frozen-lockfile
CARGO_BUILD_JOBS=1 bun run build:preview
```

The build wrapper preserves the complete Python onedir, including framework symlinks that the macOS bundler would otherwise dereference. Local macOS builds use ad-hoc signatures for executable integrity; this is not Developer ID signing or notarization. The selected media binaries and their dependent libraries determine the supported OS floor. The currently inspected macOS resources require macOS 15. A preview is a local development artifact, not a signed public release.

Backend and host checks:

```sh
cd backend
uv run pytest
cd ../frontend
bun test tests
bun run build
bun run build:desktop
cd ..
CARGO_BUILD_JOBS=1 CARGO_BUILD_WARNINGS=deny cargo clippy --locked --manifest-path native/src-tauri/Cargo.toml --all-targets
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path native/src-tauri/Cargo.toml
backend/.venv/bin/python scripts/desktop/check_parity_inventory.py --runtime desktop-core
backend/.venv/bin/python scripts/desktop/generate_schema_contract.py --check
```

Native WebView checks use `scripts/desktop/native_qa.md`. `create_qa_fixture.py` creates only new temporary data and generated tones. Its separate provenance manifest records source hashes/mtimes. The installed artifact must be tested again after backend/frontend or bundled-resource changes.

## Bring existing web data into desktop

Enrollment is an explicit, stopped-source operation. Stop the source backend and all provider/reconciliation jobs first. Old Deno/source binaries cannot honor the new ownership lease. Never copy a live SQLite file without its WAL or replace databases underneath a running service.

```sh
cd backend
uv run python -m app.library_exchange.cli enroll \
  --catalog /absolute/path/to/original-catalog.sqlite \
  --identity /absolute/path/to/paired-identity.sqlite \
  --data-dir /absolute/path/to/web-replica
```

Omit `--identity` when that library has no identity partner. Enrollment copies the original DB/WAL files to private staging, verifies and initializes a new generation, and produces the initial `.cmexchange` archive. It preserves original database bytes and leaves a small enrollment marker beside them. Interrupted marker/pointer publication can be recovered by repeating the same enrollment command. Do not delete the source files or markers as an improvised retry.

Use the returned `CRATEMIND_DATASET_ROOT` and `CRATEMIND_PATH_MAPPINGS_FILE` for the normal web runner:

```sh
CRATEMIND_DATASET_ROOT=/absolute/path/to/web-replica \
CRATEMIND_PATH_MAPPINGS_FILE=/absolute/path/to/web-replica/web-path-mappings.json \
uv run uvicorn app.main:app --port 8000
```

Remove conflicting explicit `CRATEMIND_DB_PATH`/`CRATEMIND_IDENTITY_DB_PATH` environment overrides. The active pointer selects the exact paired generation. The source runner acquires an OS-backed ownership lease before importing database routes and holds it while jobs can still write.

In desktop Settings, import the initial `.cmexchange` and map its logical roots to this machine's music folders. The archive includes all library state, not audio. Source audio stays in its existing locations. Local mapping and display preferences remain per device.

The older JSON metadata import is a separate desktop-only adapter. It matches existing scanned tracks by path or unique hash, reports unmatched/ambiguous items, and preserves existing manual BPM choices. It does not replace complete library exchange or create/move audio files.

For a Deno-only library, the bounded adapter recognizes the shipped legacy schema,
copies only stopped source DB/WAL files into private staging, preserves IDs and
durable values in a new shared-schema generation, and produces a `.cmexchange`.
Unknown schemas/columns are refused. Original files are never opened for writing.

```sh
uv run python -m app.library_exchange.cli inspect-deno --source /absolute/path/to/deno/cratemind.sqlite
uv run python -m app.library_exchange.cli adopt-deno --source /absolute/path/to/deno/cratemind.sqlite --data-dir /new/isolated/deno-replica --require-stopped
```

The packaged executable offers the same explicit operator commands through
`--exchange-cli`, without an installed Python. On macOS its path is
`CrateMind Preview.app/Contents/Resources/backend/cratemind-backend`; pass, for
example, `--exchange-cli adopt-deno` followed by the arguments above. This operator
entry is not exposed to webpage commands. Import the resulting archive in Settings.

## Serial two-way handoff

1. Finish edits/jobs in the active replica and export a complete `.cmexchange`.
2. Import into the other replica after previewing the lineage and local changes. Desktop supervises its own stop, fixed import helper and restart.
3. For the source web runner, stop the service and import through the shared CLI, then restart the same normal command.

```sh
uv run python -m app.library_exchange.cli export --data-dir /absolute/path/to/web-replica --output /safe/export/new-state.cmexchange
uv run python -m app.library_exchange.cli inspect --data-dir /absolute/path/to/web-replica --bundle /safe/export/returned-state.cmexchange
uv run python -m app.library_exchange.cli import --data-dir /absolute/path/to/web-replica --bundle /safe/export/returned-state.cmexchange --require-stopped
```

An idle running service still blocks CLI imports/previews. Keep exports outside music roots and internal dataset directories. Re-exporting unchanged state reuses the immutable snapshot identity and bytes. New revisions require a fresh destination if a file already exists with different content.

This protocol detects divergent edits; it does not merge simultaneous branches. Desktop's explicit “Αντικατάσταση με την εισερχόμενη έκδοση” first archives the complete local branch and keeps its rollback generation. The CLI equivalent requires `--replace-incoming --confirm-local-digest <digest-from-fresh-preview>`. Stale previews, incompatible schemas, changed archives and invalid lineage cannot be bypassed by confirmation.

Tags, cues, profiles, sets, play history, analysis/provider state, canonical decisions and collection edits travel together. Play logging and scans that write timestamps count as revisions. Pure reads and remapping an existing root do not. Desktop scans analyse the BPM/key of the tracks they add. Tracks that arrive through an import are not analysed automatically on either runtime; run “Μόνο νέα” BPM/key analysis for any that still lack values.

## Locations, recovery and rollback

Tauri supplies an app-owned data root. Python alone owns `active.json`, the active `datasets/<generation>/` pair and `exchange-state.json`. Per-device settings live in `desktop-config.json` and `preferences.json`. Media caches are scoped to the active generation. Bundled resources are read-only inputs.

The exchange directory retains immutable archives, previews and interrupted publication records. Normal archive retention is ten; the active baseline and conflict archives are protected. Generation directories are retained for rollback. Low-space errors preserve existing data. Do not manually replace active DB/WAL files or edit snapshot lineage to silence a conflict.

Recovery runs under the dataset lease before writers start. A failed import preserves the old active generation. For rollback, stop enrolled services and use an isolated verified previous copy; do not restart the retired original concurrently and call it synchronized. A manual active-pointer or retired-marker recovery requires an explicit data-recovery procedure and backup.

The 2026-10-29 source retirement is separate from live-user cutover: existing
databases and installed copies are preserved. Implementation tests do not adopt
the user's live library. Windows, Linux, Intel Mac, distribution signing/notarization and clean-machine OS support require their own actual installer runs before being advertised as verified. The workflow file prepares validation; its presence is not evidence that CI ran.


## Playback leveling and limiting

Auto Gain and Audio Limiter are optional per-device preferences, off by default. They are available in Settings → Ήχος & Ανάλυση and the player audio-settings popover. Both web and desktop use the same implementation. These controls change playback only; source audio files, tags, and catalog schema are unchanged.

Auto Gain measures integrated loudness and true peak once with the existing FFmpeg tool. JSON results live beside the active catalog in `cache/playback-loudness`, invalidated by resolved source path, size and nanosecond modification time. The target is −18 LUFS, gain is bounded to +12 dB maximum and capped by −1 dB true-peak headroom. Silence is never boosted. One measurement runs at a time; stale selected-track requests are canceled in the renderer and responses cannot change a newer track's gain.

The playback graph is source → steady normalization gain → optional stereo-linked sample-peak limiter → master volume. The limiter uses 5 ms lookahead, a −1 dBFS sample ceiling and 60 ms release. This is not a claim of reconstructed analog true-peak limiting. Disabling effects preserves the connected audible bypass. If worklet loading stalls for 1.5 seconds, is unsupported, or its processor fails, the player switches to a compatibility processor using the same stereo-linked DSP core. Readiness is reported only after an audio block has been processed. The compatibility path uses 1024-frame callbacks and adds buffering latency; native AudioWorklet remains preferred. Only failure of both paths displays an unavailable message and leaves the audible bypass operational.

Validation on 2026-10-27: native WKWebView loaded and processed the actual worklet; generated input peaks of 8 were limited to 0.891250908, with zero measured stereo ratio error. Six generated codec fixtures returned cached loudness measurements, with all seven source fixtures byte/mtime unchanged. Browser interaction checks verified Auto Gain gain/RMS, volume/mute, seeking, source-switch gain reset and bypass. The Ego Chromium test environment stalled AudioWorklet module loading. The compatibility processor was then verified in the actual browser: generated input peak 3.184810 was limited to 0.891250908; disabling restored the original level and re-enabling/seek preserved limiting. The shared core is tested identically for both processing paths. No heard-audio claim is made by these automated checks. Evidence is under local `build/desktop/audio-validation/`.


## DJ workspace controls

Space pauses/resumes the current deck, including after waveform seeking and cue-pad clicks. Number keys 1–8 jump to the matching pad; an empty number key never creates a cue. Text editing, open menus and dialogs keep their own keyboard behavior. In Tagging Queue, 1–8 are reserved for the current player while a track is selected; rating controls remain available onscreen.

Eight pads are displayed as two rows of four. Click an empty pad to capture the current playhead, click an assigned pad to seek, and use its cog to edit its time/type/label or assign an existing cue. Clearing a pad assignment does not delete the cue. Pad numbers and colors are shared with the waveform and full cue list. Extra cues remain in that list. Assignments are device-local preferences referencing cue IDs; the actual cue records remain in the shared catalog/exchange. Timestamp edits do not reshuffle pads.

Set selection and New/Copy/Save/Export actions now live in the right sidebar; Save still writes a JSON backup and ordinary edits remain automatically saved. Background selection and audio settings sit beside the theme toggle. The selectable backgrounds are Soft Aurora plus Scanner, Ferrofluid/Frost, Grainient/Lagoon, Threads, Particles and Aurora. Motion respects both OS and app preferences, pauses while hidden, and falls back to static decoration after context loss. Only one background renderer is mounted. Upstream background notices ship in `frontend/licenses/react-bits.txt`.

2026-10-28 validation: 139 frontend tests, both frontend builds, browser pixel checks for all14 background/theme combinations and native WKWebView checks for the same14. Browser checks covered keyboard/editor guards, persistent pad time edits, overflow assignment, two-deck ownership, table/header geometry, all set actions and 1440px player layout. Native checks also verified persisted cue-pad layout and generated-codec playback. Test-only source files stayed unchanged. Evidence: local `build/desktop/dj-workspace-validation/`.
