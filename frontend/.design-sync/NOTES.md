# CrateMind Design Sync Notes

## Repo-specific quirks

- **No published package / no `dist/`**: This is an app, not a library. Synth-entry mode via `.ds-entry.ts` barrel file that re-exports all design-system components.
- **Tailwind v4 CSS**: `src/index.css` has `@import "tailwindcss"` and `@theme`/`@utility` directives that only compile via the Tailwind Vite plugin. Must use `.design-sync/compiled.css` (output of `npm run build` with `@font-face` stripped) as `cssEntry`. Rebuild Vite before re-syncing to refresh compiled CSS.
- **Always-dark theme**: The DS is permanently dark (`color-scheme: dark`). Preview cards render on a white page background — components may appear small/invisible when they rely on dark context (e.g., glass surfaces against white).
- **`@/` path alias**: tsconfig maps `@/*` to `./src/*`. Converter resolves this via `tsconfig` config key.
- **Default exports**: `ElectricBorder` and `ShinyText` use `export default` — barrel re-exports them as named (`export { default as ... }`).
- **`usePref` dependency**: `GlassCard` imports `usePref` from `../../lib/prefs` (localStorage-based prefs). Renders fine without context — defaults to `reduceMotion: false`.
- **`useReducedMotion` from motion/react**: Used by GlassCard, SoftAurora. Bundled into `_ds_bundle.js` via esbuild.
- **Excluded app-dependent components**: BpmAnalysisCard, CommandPalette, MiniPlayer, ProfileEditor, SoundCloudReviewDrawer, RecommendationCard, SetTimeline, SoundCloudCard, TrackTable, AppShell, Sidebar — all use `@/lib/api`, react-router, or player state.
- **No Storybook**: shape is `package`.

## Known render warns

- Floor cards render with minimal props on white background — dark-themed components (GlassCard, GlassPanel, ElectricFrame) barely visible against white.
- EnergyMeter floor card shows "—" (null value fallback) — correct behavior.
- AnimatedNumber floor card shows typographic placeholder — no authored preview.
- BentoSpotlight floor card appears empty — needs children to render.

## Re-sync risks

- `.design-sync/compiled.css` is derived from `npm run build` output. If Tailwind tokens or utilities change in `src/index.css`, must rebuild Vite AND regenerate compiled.css before re-syncing.
- Font files come from `@fontsource-variable/inter` and `@fontsource/jetbrains-mono` in node_modules. Package upgrades may change font file names.
- `.ds-entry.ts` barrel must be updated when components are added/removed/renamed.
- Render check was skipped (no playwright). Install playwright + chromium for machine-verified renders on re-sync.
