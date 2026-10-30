# Library and Player Refinements Implementation Plan

**Goal:** Preserve useful Library sizing defaults and improve the player, tagging, scan and native titlebar experience in both shared frontends.

**Architecture:** Keep table preferences in the existing web/desktop preference adapter, scoped separately from the compact set-builder table. Reuse shared keyboard, number and frosted surface components; keep native titlebar permissions restricted to dragging. Optimize existing scan/sync boundaries without skipping recovery work.

**Global constraints:** Source-only round: no desktop/frontend production build, Rust compilation, packaging, app restart or commit. No live scans, provider jobs, source-audio writes or database migrations. Preserve all previous dirty work. Web and Tauri database replicas remain separate.

## Task 1: Library table
- [x] Use saved desktop full-table widths as defaults/minimums; migrate and validate stored values.
- [x] Hide created, last-played and genre by default; add Columns and reset-width controls. Preserve user visibility at narrow widths.
- [x] Add sortable melody/weirdness beside energy/darkness; keep header/rows/grid aligned.
- [x] Add shared localized number count and Kbd navigation hints; verify persistence, migration, resize completion and sort behavior with focused tests.

## Task 2: Player, tagging and notification presentation
- [x] Limit audio waveform width to 800px in dock and tagging card while preserving responsive height and existing glow.
- [x] Give the 2x4 cue pads full dock height; move cue-management controls into pad settings and retain all saved cues/edit/seek/keyboard behavior.
- [x] Keep one tagging play button with adjacent previous/next; uppercase format and remove card genre chip.
- [x] Reuse frosted materials for notifications and nonwrapping keyboard hints; inspect actual rendered dark/light and smaller layouts.

## Task 3: Fast scan
- [x] Trace delta detection, metadata/hash/probe and analysis calls, missing-root safety and identity recovery.
- [x] Reuse file stat and batch existing observation reads; skip identity rederivation for matching raw delta snapshots.
- [x] Retain full recovery/mirror replay and conservative duplicate/missing protection. Verify measurable call counts using generated fixtures; document residual costs.

## Task 4: Native titlebar and Vite
- [x] Use macOS Overlay/hidden title and reserve 32px with a supported drag region.
- [x] Limit drag capability to main local loader and exact authenticated loopback origin, keeping global Tauri disabled.
- [x] Remove native-loader __dirname usage, route limiter module through Vite source assets, and exclude generated dist folders from dev watching.
- [x] Run non-build syntax/config/security-shape checks and DSP tests; explicitly defer native appearance/drag and emitted-worklet build proof to next authorized build.

## Review focus
- Persist widths on pointer cancel/blur/unmount without React updater side effects; keep valid legacy settings.
- Hidden columns remain available on narrow screens and compact set tables retain fixed right-side columns.
- Every cue remains accessible, including overflow/unassigned cues; enlarged pads retain keyboard/editor behavior.
- Missing/disconnected roots never mark reachable-library files missing through incomplete traversal.
- Native overlay leaves traffic-light clearance and no general native command surface; web layout gets zero top inset.

## Verification
Focused Bun/backend tests; no-emit TypeScript checking only if permitted by source-only constraint; browser inspection of the already-running Vite app and isolated UI preferences. No production bundles or native launch for this round. Report source changes separately from the running desktop build.

## Completion evidence

Implemented shared UI/source changes and verified web presentation at 800, 1280 and 2304px, dark/light notifications, table reload persistence, width-only reset, compact right columns, cue-management accessibility and 32px overlay inset simulation. Backend: 772 tests. Frontend: 165 tests plus no-emit type check. Native Rust was syntax-checked only; added overlay capability tests, real native dragging/appearance and production-emitted worklet remain deferred until the next authorized desktop build. No actual scan/provider job or source-audio mutation was performed.
