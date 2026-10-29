# Backgrounds, Key Wheel and Font Serving Implementation Plan

> **For agentic workers:** Execute the bounded tasks below with native subagents where independent. User instruction overrides build/test/commit steps: no app build, compilation, packaging or automatic commits this round.

**Goal:** Offer the requested backgrounds and presets, a context-aware key wheel, and correctly served local fonts.

**Architecture:** Retain the shared React UI and one lazy background renderer with existing visibility/reduced-motion cleanup. Keep key-wheel source selection local to Set Builder. Allow Vite to serve only the resolved font package directories in addition to its normal workspace roots.

**Tech Stack:** React, TypeScript, Vite, existing WebGL background components, Tauri shared frontend.

**Spec:** User request in this conversation dated 2026-10-29: replace Ferrofluid with Grainient Lagoon/Aurora; add supplied background configurations when accessible; make sparse effects fuller; key wheel sources Now playing / Selection / Last track with availability states; repair relocated-font access.

## Global Constraints

- No build, compilation, packaging, app restart, database mutation or music-file writes.
- Fetch public component sources and preserve licenses; skip inaccessible Pro components without circumvention.
- Preserve exact supplied props for new profiles; maintain reduced-motion, hidden-page and GPU cleanup behavior.
- Preserve existing dirty waveform and Clippy work.

## Tasks

- [x] Backgrounds: inspect official sources/presets, remove Ferrofluid option, add two Grainient profiles and accessible requested components, fuller Scanner/Particles/Threads, update provenance and QA inventory. Verify by source review and existing browser when possible.
- [x] Key compatibility: identify selected and actively playing track identities, create three-option segmented control, disable missing/unkeyed sources, derive highlight and explanation from selected source, ensure fallback when source disappears. Verify representative state transitions.
- [x] Font serving: preserve workspace inference and deny rules, allow resolved installed font-package paths, verify all listed font requests return correct binary content.

## Review Focus

- Saved Ferrofluid preferences fall back to a valid selection.
- No track, paused playback, missing key, and selection removed from set.
- Theme/reduced-motion/page-hidden behavior and renderer switches release resources.
- No application-layer overlays become interactive or intercept music controls.
- Font allowlist remains narrow and portable when dependencies are symlinked.

## Validation Boundary

Use source/whitespace checks, safe read-only HTTP requests and existing browser/dev server only. Report unverified visuals and unavailable source components explicitly; do not claim a packaged desktop update.

## Results

- Nine backgrounds initialized in both themes in the existing web dev server; screenshots captured and representative settled frames inspected. Particles framing corrected after the first sparse render. Reduced-motion and obsolete Ferrofluid preference fallback checked in browser.
- Selected-track and last-track modes checked through the UI; playing/pause/resume checked by publishing isolated browser-only playback state without playing audio or writing listening history.
- 31 relocated font files returned valid WOFF/WOFF2 bytes over HTTP, including Greek and Latin variants.
- New focused tests were written but not executed. No production/Tauri build, packaging, manual server restart, database edit or commit performed. Four Pro components skipped after normal registry HTTP401 license responses.
