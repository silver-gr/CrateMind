# Set Sources, Shared Surfaces and PWA Icon Plan

## Goal and constraints

Add source-aware next-track recommendations; remove redundant set-selector summaries and decorate the statistics cards with icons. Make the existing frosted surface design the shared default, preserving useful differences between controls and panels. Give the PWA the desktop glyph within a dark rounded frame. Commit owned changes, then build and verify the desktop app. No database or music changes; preserve unrelated .github/copilot-instructions.md.

## Cleanup plan

1. Inventory duplicated menu/field backgrounds, borders, shadow and focus classes. Define shared theme-aware surface utilities; replace equivalent inline classes at UI primitives and their overriding consumers. Preserve sizing, colors for semantic statuses, interaction and accessibility.
2. Reuse the existing three-way source selector for recommendations, disabling sources without tracks rather than requiring keys. Preserve explicit bridge recommendations and guard/refill requests against stale source/set context. Add icons to duration/tracks/BPM/key stats and remove duplicate selector count/duration/idle autosave text, retaining useful saving/error feedback.
3. Use existing desktop glyph as the PWA image reference; dark framed rounded icon, no wordmark. Update manifest/favicon/apple/maskable references with cache versioning and preserve maskable safe area.
4. Run focused and full frontend tests, web and desktop builds, native Clippy/build, isolated packaged smoke checks, live web UI review. Commit owned paths in logical groups. Install the verified desktop bundle with a retained rollback and refresh the ZIP. Do not open or restart the personal app unless needed for a safe replacement.

## Verification focus

- Selection, actual playing owner, paused/unavailable sources, set changes, bridge preservation and recommendation refill races.
- Dark/light active/disabled/focus menu states and remaining explicit background overrides.
- Correct icon sizes, manifest metadata, offline cache refresh and maskable padding.
- Current Python frozen source manifest, signatures, bundled resources, startup screen, glyph icon and no user-data changes.
