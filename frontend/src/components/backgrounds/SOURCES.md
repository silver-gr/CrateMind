# React Bits background sources

The six optional renderers are adapted from the official [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) repository, commit `e12c22192ac7b4b452c5e2feb9b586d74765d696`, retrieved 2026-10-28. They run locally without additional dependencies or external runtime requests. The complete upstream notice is preserved in `REACT_BITS_LICENSE.txt` (MIT + Commons Clause). Application use is allowed; redistribution or sale of the components as a component product is restricted.

| Local source | Official component |
| --- | --- |
| `Scanner.tsx` | [Scanner](https://reactbits.dev/backgrounds/scanner) |
| `Ferrofluid.tsx` | [Ferrofluid](https://reactbits.dev/backgrounds/ferrofluid) |
| `Grainient.tsx` | [Grainient](https://reactbits.dev/backgrounds/grainient) |
| `Threads.tsx` | [Threads](https://reactbits.dev/backgrounds/threads) |
| `Particles.tsx` | [Particles](https://reactbits.dev/backgrounds/particles) |
| `Aurora.tsx` | [Aurora](https://reactbits.dev/backgrounds/aurora) |

Each TypeScript source header links directly to its pinned upstream file. Associated CSS files are copied unchanged. The 19 upstream shader constants remain unchanged; adaptations are lifecycle and application settings.

`Ferrofluid` uses the official [Frost preset](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/demo/Backgrounds/presets/Ferrofluid.js) geometry and simulation parameters, with cyan/violet reflections and slower motion. `Grainient` uses the official [Lagoon preset](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/demo/Backgrounds/presets/Grainient.js) palette with a violet-tinted dark base and the requested `angle={144}` / `flow={0}`. Its grain and gradient are static to keep that no-flow choice still. Other profiles use CrateMind's cyan, chartreuse and violet palette.

The original `../SoftAurora.tsx` remains the default renderer. Its lifecycle now caps rendering at 30fps, uses DPR 1, pauses while hidden, checks program linking, and explicitly disposes its OGL geometry/program.

## Runtime integration

- `backgrounds.ts` exports the `BackgroundId` union and seven picker options. The durable preference defaults to `soft-aurora`.
- `BackgroundPicker` accepts `{ compact?: boolean }`; it works in the settings card and narrow sidebar popover.
- `../layout/SoftAuroraBackground.tsx` mounts one choice, lazy-loads optional renderers, and unmounts all WebGL work for application/OS reduced motion and hidden pages.
- Native renderers cap DPR at 1.25 and frame rate at 30fps; profiles request DPR 1 where the upstream API supports it. Threads also bounds its render dimensions.
- Light/dark settings and CSS opacity are separate. Renderers retain their distinct shader geometry in both themes.
- Shader/context creation errors and context loss select a static, profile-specific CSS fallback. A fresh background selection retries initialization. GPU buffers, programs, textures, framebuffers, listeners and observers are released on switches.

## Browser inspection contract

The outer element is `.cm-background[data-background="<BackgroundId>"]`. A successfully initialized canvas has `data-background-ready="true"`. During animated rendering there is exactly one background canvas. For static states there are none; `[data-background-fallback]` reports `reduced-motion`, `page-hidden`, `context-lost`, `renderer-error`, or transient `loading`.

Source verification compared all 19 shader constants, all six CSS files and the complete license against retrieved upstream copies. TypeScript validation passed. Full rendered theme and fallback verification belongs to the application browser QA pass.
