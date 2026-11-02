# djay waveform tuning implementation plan

> **For agentic workers:** Execute the bounded tasks below with native Codex subagents; the leader integrates and verifies. The user's instruction authorizes execution without a permission handoff.

**Goal:** Replace guessed deck waveform tuning with independently implemented behaviour measured from djay Pro 5.6.9.

**Architecture:** CMWD v2 contains five Uint8 planes: RMS, peak, red, green, blue. Envelope blocks are 40 samples at 44.1 kHz, with a shared track-maximum reference and a 0.01 floor. Colour uses a separate 512-sample Hamming FFT, 256-sample advance, six overlapping filters and circular hue mixing. Preserve phase-safe per-channel analysis rather than djay's cancellation-prone mono sum.

**Tech Stack:** Existing Python/NumPy analysis, TypeScript raster renderer, pytest and Bun; no new runtime dependencies.

**Spec:** `.omc/handoffs/2026-11-02-codex-deck-waveform-djay-tuning.md`, supplemented by read-only metadata and installed-binary inspection. The measured six-filter model supersedes the handoff's three-band guesses and proposed 294-sample peak hop.

## Global constraints

- Never write to, move or lock djay files. Inspect SQLite only through a private byte copy of db + WAL, never SHM.
- Never modify source audio or use personal data in automated tests/QA.
- Preserve the other session's artist-research files; no pushes.
- Greek user-facing copy; no new dependencies or schema/routes.
- Exact visual acceptance remains the user's same-track, same-zoom comparison.

## Review focus

- A single impulse in a long silent track must survive normalization.
- First/last samples and chunk boundaries must not drop or duplicate transients.
- Inverted stereo must remain visible; RMS must not exceed peak.
- V1 cache/ETag must not satisfy v2 requests; shared fixture proves both parsers agree.
- Broad zoom must aggregate a coherent colour, and normal envelope values must not undergo percentile clipping or square-root expansion.

## Task 1: Analysis and binary contract

**Files:** `backend/app/services/waveform_detail.py`, a focused colour-analysis helper if needed, `backend/tests/test_waveform_detail.py`, `backend/tests/fixtures/waveform_detail/`.

**Interface:** 48-byte header retained; version=2, sample_rate=44100, hop=win=40, frames=ceil(samples/40). Payload order `rms, peak, red, green, blue`; exactly `48 + 5*frames` bytes. Frame time `(i*40+20)/44100`. Colour frames start at 128/44100 and advance 256/44100; nearest colour frame supplies envelope RGB. Cache names/digests carry version 2.

- [x] Add failing synthetic tests for impulses, edges, phase safety, level scaling and v1 invalidation.
- [x] Implement unwindowed peak/RMS and measured colour filters, with bounded streaming and no live-data access.
- [x] Replace the hand-built shared fixture; verify targeted pytest tests.

## Task 2: Parser and rendering

**Files:** `frontend/src/lib/detailWaveform.ts`, `frontend/src/lib/deckScroll.ts`, waveform tests, and canvas tile drawing only if necessary.

**Interface:** `DetailWaveform` exposes `rms, peak, red, green, blue`; parser accepts v2 only. Envelope and colour aggregation must preserve physical amplitudes and temporal correspondence.

- [x] Add tests for the new fixture, sparse peaks, linear dynamics and coherent colour aggregation.
- [x] Remove percentile/sqrt reconstruction; use distinct measured envelope planes and frequency RGB directly.
- [x] Adapt theme hues without the old blanket white lift. Treat theme mapping as CrateMind design, not a recovered djay rule.
- [x] Verify Bun tests and build.

## Task 3: Evidence and integration

**Files:** `docs/DJAY_WAVEFORM_TUNING.md`; task-owned comparison tooling if useful.

- [x] Record measured constants, source method addresses, cache inventory and remaining uncertainty without copying proprietary code or personal fixtures.
- [x] Compare recovered colour model numerically with read-only cached reference data; keep personal inputs/results outside tracked fixtures.
- [x] Run full backend/frontend tests, contract/parity checks, and an independent code review.
- [x] Build and verify the macOS preview per handoff when local validation passes; do not claim user visual acceptance.

## Evidence discovered during execution

The main djay deck renderer builds a raw-PCM amplitude histogram. Separate peak/RMS analysis is verified, but a two-layer peak/RMS raster is not the final djay raster. The implementation deliberately retains that compact approximation; docs/DJAY_WAVEFORM_TUNING.md records the distinction. User visual acceptance and exact histogram texture remain open. Independent review also identified finalization memory growth; blockwise quantization fixed it and reduced the same 60-second synthetic allocation probe from 7.14 MiB to 2.34 MiB.

The follow-up requested by the user implements raw PCM density tiles; the earlier final-raster limitation is superseded by `2026-11-02-djay-density-rendering.md`. User comparison of the final result remains pending.
