# djay PCM density rendering implementation plan

> **For agentic workers:** Native Codex agents execute the bounded backend and review tasks below; the leader owns frontend integration and verification. Execution is explicitly authorized.

**Goal:** Replace peak/RMS layers with actual signed-PCM density shading in both deck palettes.

**Architecture:** A bounded asynchronous tile endpoint streams only a requested source-audio interval through FFmpeg, bins actual channel samples into display rows, applies the recovered density and gamma kernel, and returns an alpha tile. The frontend combines alpha with existing CMWD v2 colours and caches finished canvases. No full-track PCM copy or new dependency.

**Tech Stack:** FastAPI, NumPy, existing FFmpeg process owner, React canvas, pytest and Bun.

**Spec:** `docs/DJAY_WAVEFORM_TUNING.md` plus the recovered density formula in `/tmp/cratemind-djay-findings.md` and independent scalar reference `/tmp/cratemind_djay_density_reference.py`.

## Global constraints

- djay files and source audio remain read-only; synthetic tests only.
- Preserve artist-research files and prior waveform work; no commit or push requested.
- Do not perform decoding or expensive pixel analysis in the animation-frame callback.
- Keep the existing six-filter colour analysis and both palettes.
- Greek UI messages; no schema changes or runtime dependencies.

## Review focus

- Equal peak/RMS signals with different sample distributions must render differently.
- Signed asymmetry and opposite-phase stereo must survive; no absolute-value mirroring or channel summation.
- Global sample boundaries and a kernel halo must make adjacent tiles match a contiguous render.
- Seeking, resizing, zooming and track changes must cancel stale work; late replies must never overwrite a current tile.
- Hard limits must cover request admission, media-slot waits, decoding, histogram size, retries and frontend memory.

## Backend task

**Files:** new `backend/app/services/waveform_density.py`, adjacent route in `backend/app/api/tracks.py`, cancellation support in `backend/app/services/media_tools.py`, synthetic density/process tests, route inventory and its exact-set test.

**Interface:** `GET /api/tracks/{track_id}/waveform/density?tile_index=0&pixels_per_second=128&height=240&dpr=2`.
Fixed width 2048; density finite 16–8192 device pixels/s; integer height 2–1024; DPR finite 0.5–8. Reject negative or absurdly distant indices. Header `<4sHHIIddd16s` (56 bytes): `CMDN`, version1, reserved0, width, height, start_seconds, pixels_per_second, dpr, source/request digest. Payload: row-major Uint8 alpha, exactly width*height bytes. Source stat/signature and tile parameters determine ETag. Use private/no-cache responses and no persistent PCM files.

Use a small nonblocking density admission limit and the existing shared media process pool, extending its wait with optional cancellation/deadline. An async route propagates request disconnect/cancellation to the worker and process. Decode timeout includes queue time. Stream PCM in bounded blocks, include horizontal kernel halo, and preserve exact frame counts at EOF. Check source signature before/after. A small bounded in-memory alpha cache is optional, never an unbounded task queue.

- [x] Synthetic red/green tests: exact scalar-reference parity, identical peak/RMS but different histograms, sign/phase, silence/EOF, chunk splits and tile seams.
- [x] Implement streaming service, cancellable route and versioned payload.
- [x] Test invalid geometry, busy requests, disconnect/timeout cleanup, source preservation and cache invalidation.
- [x] Classify the route and verify inventory.

## Frontend task

**Files:** `frontend/src/lib/waveformDensity.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/deckScroll.ts`, `frontend/src/components/DeckScrollWaveform.tsx`, relevant tests.

- [x] Parse and validate CMDN geometry; fetch through existing authenticated buffer wrapper.
- [x] Implement bounded request lifecycle: visible before neighbours, one pending request per deck, abort obsolete requests, backoff failures, and generation-safe insertion.
- [x] Compose existing frequency/theme RGB with density alpha; preserve straight RGBA and signed rows. Remove the peak/RMS body from the active path.
- [x] Keep RGBA canvases within existing LRU ceiling. Clamp requested tile density to at least16; cap device tile height at1024 while scaling the final canvas normally.
- [x] Repaint paused decks on arrival; show Greek loading/unavailable status rather than silently substituting old shading.
- [x] Tests for parser, colour/alpha compositing, stale replies, cancellation, retry bounds and paused repaint.

## Integration

- [x] Independent review, synthetic visual comparison and tile cost/memory measurement.
- [x] Full frontend tests/build; targeted and full backend tests, recording any independently verified baseline failure.
- [x] Schema/parity checks, frozen backend self-test, rebuilt/verified macOS preview.
- [x] Update the evidence document, then reopen preview for user comparison. Exact user visual acceptance remains a separate check.

Validation so far: 440 frontend tests; 116 focused backend cases; full backend 1,033 pass with the previously reproduced HEAD baseline audit_log-fixture failure. Browser fixture verified actual paused rendering, signed asymmetry, stereo phase, source hashes, palette/zoom/seek/resize and unmount/remount. Independent reviewer finding about neighbour prefetch was fixed with a regression test.

Final: the false 409 for mapped logical paths was fixed with a red/green regression; 87 relevant checks passed after the fix. Packaged smoke checks with an empty PATH passed for seven generated codecs, authentication, ETags, source hashes and EOF shutdown. Native app resources were refreshed and resealed, final bundle verification passed, and the preview reopened. No commit or push.
