# Tauri migration validation — 2026-10-27

The local **macOS arm64 preview is implemented, packaged and verified**. It reuses
the shared Python backend and React interface. BPM/key processing and
SoundCloud/Spotify workflows remain in web; stored results remain usable on
desktop. The live user library has not been enrolled, scanned or migrated.

This is a local preview acceptance record, not full cross-platform release
acceptance. The remaining platform, manual UI and release gates are listed below.

## Deliverables

- Preview archive: [CrateMind-Preview-macOS-arm64.zip](../build/desktop/CrateMind-Preview-macOS-arm64.zip).
- Application: [CrateMind Preview.app](../native/src-tauri/target/release/bundle/macos/CrateMind%20Preview.app).
- [Build, enrollment, handoff and rollback instructions](TAURI_DESKTOP_OPERATIONS.md).
- [Native acceptance evidence](../build/desktop/native-acceptance-evidence.json).
- [Archive extraction verification](../build/desktop/delivery-verification.json).
- [Positive frozen Deno adoption evidence](../build/desktop/frozen-adoption-evidence.json).
- [Independent implementation review](superpowers/reviews/2026-10-27-tauri-final-implementation-review.md).

Source baseline: `f71dc17ac596732ab14c3e81d9fe984210733c62`.
Implementation branch: `codex/tauri-desktop-migration`. Changes remain uncommitted;
no push, deployment, public release or live-data cutover was performed.

The frozen build manifest records hashes for 96 backend/build files, including
untracked implementation files. Its aggregate source hash is
`001ab61d13442b5017a50a98a824a01f0c2b283963dfbf7bcd0c1a4ffdb044a8`;
all recorded files matched the current source when checked after the build.
Native-source, frontend-dist and executable hashes are in the acceptance evidence.

## What changed

- Added the Tauri host, authenticated ephemeral loopback origin, native dialogs
  and fixed actions, single-instance/process ownership, diagnostics and restart.
  The HTTP renderer has no broad Tauri IPC, filesystem or shell grants.
- Extracted web/desktop runtime profiles without copying the Python domain.
  Desktop cannot start deferred processing or provider-pair mutations. NumPy
  remains for waveforms; the frozen runtime does not load SciPy/librosa/Essentia.
- Added paired dataset generations, OS ownership leases, complete-operation
  maintenance admission, generated schema compatibility, crash recovery and
  complete `.cmexchange` handoff with explicit conflict archival.
- Added portable logical paths, per-device mappings/preferences, source-safe
  exports, native Settings and previewed imports. Mappings are reconciled against
  the active generation; unrelated histories cannot silently reuse old bindings.
- Retained the legacy metadata import and added bounded Deno database adoption
  through the shared operator CLI. Both preserve original files.
- Packaged Python, frontend, ffmpeg/ffprobe/fpcalc and required libraries. The
  macOS wrapper restores PyInstaller symlinks after Tauri bundling and signs the
  resulting local development app inside out.

## Verification performed

| Check | Observed result |
| --- | --- |
| Full backend suite, `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run pytest` | **630 passed**, 22.52 seconds |
| Frontend, `bun test tests` | **67 passed**, 195 assertions |
| Web and desktop production builds | Both passed TypeScript and Vite builds |
| Native, locked Cargo tests with one build job | **17 passed**, zero failures |
| Inventory and generated schema contract | Current; 104 baseline routes = 92 retained + 12 deferred; nine additional planned endpoints classified |
| Frozen core outside checkout with empty PATH | Passed; Python 3.13.18, PyInstaller 6.22.3, SQLite 3.54.1; no forbidden imports |
| Bundled tools outside development PATH | ffmpeg/ffprobe 9.0.2 and fpcalc 1.6.2 execute |
| Packaged HTTP lifecycle | Authenticated SPA/API work, unauthenticated API receives 403, parent EOF exits in 0.316 seconds |
| Real subprocess desktop→web→desktop handoff | Desktop edit/export, web return, preview, completed 202, admission closure, stopped helper, restart and persisted preferences passed |
| Positive frozen Deno adoption | Preserved WAL-only title, track/cue IDs, stored BPM and accepted SoundCloud link; resulting bundle imported by source Python; original DB/WAL/audio bytes and mtimes unchanged |
| Bundle inspection | 114 native binaries verified, four Python symlinks preserved, no developer databases/.env/private calibration output, local ad-hoc app seal verified |
| Delivery archive roundtrip | ZIP extracted privately; symlinks/signatures/resource verification and frozen self-test passed again |

The inventory establishes coverage ownership and route classification; its counts
are not a substitute for behavioral or native-screen acceptance. Existing shared
behavior is exercised by the full backend/frontend suites and the added profile,
path, exchange, process, adoption and data-safety tests.

Vite still reports a large main chunk and its existing future-native-config-loader
warning about `__dirname`. Neither failed the build; no thresholds were lowered.

## Actual native WebView runs

Two runs used a marked temporary fixture with seven generated audio files, a
tag/set/cue/profile and explicit device mappings. Both runs passed authenticated
fetch, HttpOnly-cookie isolation, absence of the global Tauri API, rendered Greek
Settings/library screens, preference writes and persisted light theme. The second
run used a different ephemeral port and recovered the previous saved marker.

| Format | Range behavior | Native playback and seek |
| --- | --- | --- |
| WAV | 206; invalid range 416 | Passed; seek 0.6 seconds |
| MP3 | 206; invalid range 416 | Passed; seek 0.6 seconds |
| FLAC | 206; invalid range 416 | Passed; seek 0.6 seconds |
| M4A | 206; invalid range 416 | Passed; seek 0.6 seconds |
| Ogg/Vorbis | 206; invalid range 416 | Passed; seek 0.6 seconds |
| Opus | 206; invalid range 416 | Passed; seek 0.6 seconds |
| AIFF | 415 | Existing unsupported-format refusal preserved |

These were muted decoder/playback probes, not heard-audio verification. All seven
source hashes and mtimes were unchanged. Seeded physical window geometry restored
consistently across both launches. All sampled host/backend/WebKit processes exited
after the test host terminated.

Native testing found and fixed two concrete wry/macOS cookie issues: the IPv4
cookie URL filter omitted `127.0.0.1`, and an explicit `Secure="FALSE"` property
still created an HTTPS-only NSHTTPCookie. The host now reads cookies natively with
explicit host/path/name checks and omits that property while verifying Strict,
HttpOnly and non-Secure attributes. Backend authentication was not relaxed.

## Size and measured memory

- App logical size, excluding duplicated symlink targets: **106,914,596 bytes**
  (about 107 MB / 102 MiB).
- Delivery ZIP: **48,272,854 bytes** (about 48 MB).
- ZIP SHA-256: `29dad37441e7b8682913a528311b99203ae66a38f4bbbdfc3e53ab409470202a`.
- Post-QA RSS snapshots: **341.9 MiB** and **354.7 MiB**. These include the native
  host, Python backend and newly created WebKit content/GPU/network processes.

RSS sums double-count shared resident pages. WebKit XPC attribution used new PIDs
at isolated launch and matching exit; unrelated pre-existing WebKit processes
were excluded. These are two loaded-fixture snapshots, not peak memory, idle
measurements, startup medians or a large-library performance benchmark. No
framework-comparison speedup is claimed.

## Plan status and remaining acceptance gates

| Plan area | Status |
| --- | --- |
| Tasks 1–3: inventory, shared profile, frozen core | Implemented and tested locally |
| Tasks 4–8: native host, authentication, lifecycle, preferences/configuration | Implemented; automated macOS fixture checks pass; manual interactions remain below |
| Tasks 9–10: onboarding/legacy adoption and portable paths | Implemented; generated-data preservation/roundtrip tests pass |
| Task 11: retained API/UI parity | Shared behavior retained and full suites pass; exhaustive native acceptance of every screen is not established |
| Tasks 12–15: complete exchange, recovery, web enrollment/writers and desktop handoff | Implemented; unit/failure/subprocess roundtrip and frozen adoption checks pass |
| Task 16: bounded native media tools | Implemented; timeout, cancellation, concurrency and media regressions pass |
| Task 17: native UX/performance acceptance | Codec/auth/preferences automated checks and bounded RSS measurements pass; broader manual/performance gates remain |
| Task 18: target installers | Local macOS arm64 preview built and archive verified; other targets/signing/clean-machine acceptance remain |
| Tasks 19–20: operations and final review | Documentation and factual evidence delivered; independent source review has no unresolved findings; release gates remain explicit |

Still unverified: Intel Mac, Windows and Linux native builds/installed artifacts;
clean-machine offline installation; distribution signing/notarization; manual
folder dialogs, copy/paste/focus/shortcuts, resize/close persistence, accessibility,
reduced-motion and artwork visual checks; heard playback; exhaustive retained-screen
native QA; representative large-library scrolling/scan throughput/startup benchmarks.
The current bundled dependencies require **macOS 15**. CI configuration was prepared
but not pushed or run. No live user cutover was attempted.

All validation used generated or privately copied fixtures. The original Deno
implementation and user data remain available; no music was moved, deleted or
retagged. Use the operations guide for a deliberate first enrollment and rollback.
