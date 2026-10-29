# React Bits background sources

Optional renderers are adapted from the official [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) repository, pinned commit `e12c22192ac7b4b452c5e2feb9b586d74765d696`. The original five remaining optional components were retrieved 2026-10-28; Prismatic Burst, Faulty Terminal and the Grainient preset definitions were retrieved 2026-10-29. They run locally without new dependencies or external runtime requests. The complete upstream notice is preserved in `REACT_BITS_LICENSE.txt` and `frontend/public/licenses/react-bits.txt` (MIT + Commons Clause).

| Local source | Official component |
| --- | --- |
| `Scanner.tsx` | [Scanner](https://reactbits.dev/backgrounds/scanner) |
| `Grainient.tsx` | [Grainient](https://reactbits.dev/backgrounds/grainient) |
| `Threads.tsx` | [Threads](https://reactbits.dev/backgrounds/threads) |
| `Particles.tsx` | [Particles](https://reactbits.dev/backgrounds/particles) |
| `Aurora.tsx` | [Aurora](https://reactbits.dev/backgrounds/aurora) |
| `PrismaticBurst.tsx` | [Prismatic Burst](https://reactbits.dev/backgrounds/prismatic-burst) |
| `FaultyTerminal.tsx` | [Faulty Terminal](https://reactbits.dev/backgrounds/faulty-terminal) |

Each TypeScript source header links directly to its pinned upstream file. Associated component CSS and shader constants retain upstream contents. Application adaptations handle lifecycle, render limits, initialization failures and readiness signals.

## Profiles

- Ferrofluid has been removed. Previously stored `ferrofluid` preferences fail `isBackgroundId` and display the valid `soft-aurora` fallback in both the renderer and picker.
- Grainient · Lagoon retains the existing `grainient` preference, the official Lagoon palette, and the requested `angle={144}` / `flow={0}` override. Speed and animated grain are disabled for this still profile.
- Grainient · Aurora uses the official Aurora palette (`#05110f`, `#065f46`, `#34d399`, `#ecfccb`), angle 100, three bands, flow 1.1 and silk 0.6. See the pinned [Grainient presets](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/demo/Backgrounds/presets/Grainient.js).
- Scanner uses 16 bands instead of 8, wider lines and a broader, longer scan trail. Threads uses 90 instead of 24 lines, distance 1.1 instead of 0.35, and a larger wave amplitude. Particles uses 600 instead of 90 particles, spread 6 and camera distance 30, with constant 4px dots (`sizeRandomness={0}`). The upstream shader stretches depth by 10 and clips beyond 100; a large spread therefore throws away particles, while randomized sizes divide their diameter by distance. The revised profile narrows that depth span and bypasses inverse-distance shrinking, retaining a bounded 600 instanced quads, disabled connections, DPR 1 and the existing 30fps cap. Theme opacity is increased for these three profiles.
- Prismatic Burst and Faulty Terminal retain every supplied numeric/color/configuration prop. Prismatic Burst keeps `colors={[]}`, `mouseInteraction={false}`, `clickBurst={true}` and `intro={true}`. Faulty Terminal keeps `clickEffect="glitch"` and sets `mouseReact={false}` for page decoration. Pointer listeners are scoped to their container; the page background has `pointer-events: none`, so foreground controls cannot trigger effects.
- Faulty Terminal retains upstream `pageLoadAnimation={true}`: its first ready frame starts at reveal progress zero and the intro lasts two seconds. Readiness indicates successful drawing, not completion of the intro. Requested brightness 0.55 and the decorative layer opacity also lower the settled output; an immediate first-ready screenshot can therefore be nearly black.

## Runtime integration

- `backgrounds.ts` exports the `BackgroundId` union and nine picker options. The durable preference defaults to `soft-aurora`.
- `BackgroundPicker` accepts `{ compact?: boolean }`; it works in the settings card and narrow sidebar popover.
- `../layout/SoftAuroraBackground.tsx` mounts one choice, lazy-loads optional renderers, and unmounts all WebGL work for application/OS reduced motion and hidden pages.
- Native renderers cap DPR at 1.25 and frame rate at 30fps; profiles request DPR 1 where the upstream API supports it. Threads also bounds its render dimensions. Prismatic Burst's adaptive resolution governor uses thresholds around this 30fps budget.
- Light/dark settings and CSS opacity are separate. Each profile has a static CSS fallback.
- Shader/context creation errors and context loss select the fallback. A fresh background selection retries initialization. GPU buffers, programs, textures, framebuffers, listeners and observers are released on switches. New renderers delete GPU objects during cleanup and defer context loss until their canvas is actually disconnected, allowing StrictMode effect replay.
- The original `../SoftAurora.tsx` remains the default renderer with its existing lifecycle.

## Unavailable Pro sources

The public [installation guide](https://pro.reactbits.dev/docs/installation) requires a paid license key for `@reactbits-starter`. The following documented starter endpoints were requested normally on 2026-10-29; each returned HTTP 401 with `Unauthorized` and `License key required. The starter plan is a paid tier.` No source was copied, no component substitutes were created and no access controls were bypassed.

| Requested component | Registry request | Result |
| --- | --- | --- |
| [Voxel Arc](https://pro.reactbits.dev/docs/components/voxel-arc) | `https://pro.reactbits.dev/api/r/starter/voxel-arc-tw.json` | Skipped: license required |
| [Wireframe Ball](https://pro.reactbits.dev/docs/components/wireframe-ball) | `https://pro.reactbits.dev/api/r/starter/wireframe-ball-tw.json` | Skipped: license required |
| [Terminal Rain](https://pro.reactbits.dev/docs/components/terminal-rain) | `https://pro.reactbits.dev/api/r/starter/terminal-rain-tw.json` | Skipped: license required |
| [Frame Border](https://pro.reactbits.dev/docs/components/frame-border) | `https://pro.reactbits.dev/api/r/starter/frame-border-tw.json` | Skipped: license required; no placement configuration supplied |

Frame Border is a framing component rather than a selectable page background. No global frame placement was inferred.

## Inspection contract and validation boundary

The outer element is `.cm-background[data-background="<BackgroundId>"]`. An initialized canvas has `data-background-ready="true"`. During animated rendering there should be exactly one background canvas. For static states there are none; `[data-background-fallback]` reports `reduced-motion`, `page-hidden`, `context-lost`, `renderer-error`, or transient `loading`. The native QA inventory includes the nine options.

The 2026-10-29 pass compared upstream sources and reviewed lifecycle/props, then inspected the existing web development server. All nine profiles initialized in both themes with one background canvas, and prior canvases disconnected on switches. Screenshots were captured and representative settled frames inspected; Particles framing was corrected after the initial sparse result. Browser checks also confirmed reduced-motion fallback and safe fallback from a saved Ferrofluid preference. No production/Tauri build, test suite, packaging, manual server restart or automatic commit was run. Native WebView behavior and GPU performance across devices remain unverified.
