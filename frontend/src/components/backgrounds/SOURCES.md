# React Bits background sources

Optional renderers are adapted from the official [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) repository, pinned commit `e12c22192ac7b4b452c5e2feb9b586d74765d696`. The original five remaining optional components were retrieved 2026-10-28; Prismatic Burst, Faulty Terminal, Iridescence and the Grainient preset definitions were retrieved 2026-10-29. They run locally without new dependencies or external runtime requests. The complete upstream notice is preserved in `REACT_BITS_LICENSE.txt` and `frontend/public/licenses/react-bits.txt` (MIT + Commons Clause).

| Local source | Official component |
| --- | --- |
| `Scanner.tsx` | [Scanner](https://reactbits.dev/backgrounds/scanner) |
| `Grainient.tsx` | [Grainient](https://reactbits.dev/backgrounds/grainient) |
| `Threads.tsx` | [Threads](https://reactbits.dev/backgrounds/threads) |
| `Particles.tsx` | [Particles](https://reactbits.dev/backgrounds/particles) |
| `Aurora.tsx` | [Aurora](https://reactbits.dev/backgrounds/aurora) |
| `PrismaticBurst.tsx` | [Prismatic Burst](https://reactbits.dev/backgrounds/prismatic-burst) |
| `FaultyTerminal.tsx` | [Faulty Terminal](https://reactbits.dev/backgrounds/faulty-terminal) |
| `Iridescence.tsx` | [Iridescence](https://reactbits.dev/backgrounds/iridescence) |
| `GradientASCII.tsx` | [Gradient ASCII](https://reactbits.dev/backgrounds/gradient-ascii) |
| `Prism.tsx` | [Prism](https://reactbits.dev/backgrounds/prism) |
| `Balatro.tsx` | [Balatro](https://reactbits.dev/backgrounds/balatro) |

Gradient ASCII, Prism and Balatro (with their CSS) were retrieved 2026-11-01 from the then-current `main` commit `4dc7b5b7772e1217c8fb8d2a7aa074302180e5b4`; their headers link that pinned commit. The other renderers remain pinned to the commit above. `Particles.tsx` already exposed every prop the Warp profile needs (`drift`, `driftSpeed`, `depthOfField`, `variation`, `connectionDistance`, `hoverEffect`, `shape`, `lightMode`), so it was not updated.

Each TypeScript source header links directly to its pinned upstream file. Associated component CSS and shader constants retain upstream contents. Application adaptations handle lifecycle, render limits, initialization failures and readiness signals.

## Profiles

- Ferrofluid has been removed. Previously stored `ferrofluid` preferences fail `isBackgroundId` and display the valid `soft-aurora` fallback in both the renderer and picker.
- Grainient · Lagoon retains the existing `grainient` preference, the official Lagoon palette, and the requested `angle={144}` / `flow={0}` override. Speed and animated grain are disabled for this still profile.
- Grainient · Aurora uses the official Aurora palette (`#05110f`, `#065f46`, `#34d399`, `#ecfccb`), angle 100, three bands, flow 1.1 and silk 0.6. See the pinned [Grainient presets](https://github.com/DavidHDev/react-bits/blob/e12c22192ac7b4b452c5e2feb9b586d74765d696/src/demo/Backgrounds/presets/Grainient.js).
- Scanner uses 16 bands instead of 8, wider lines and a broader, longer scan trail. Threads uses 90 instead of 24 lines, distance 1.1 instead of 0.35, and a larger wave amplitude. Particles uses 600 instead of 90 particles, spread 6 and camera distance 30, with constant 4px dots (`sizeRandomness={0}`). The upstream shader stretches depth by 10 and clips beyond 100; a large spread therefore throws away particles, while randomized sizes divide their diameter by distance. The revised profile narrows that depth span and bypasses inverse-distance shrinking, retaining a bounded 600 instanced quads, disabled connections, DPR 1 and the existing 30fps cap. Theme opacity is increased for these three profiles.
- Prismatic Burst and Faulty Terminal retain every supplied numeric/color/configuration prop. Prismatic Burst keeps `colors={[]}`, `mouseInteraction={false}`, `clickBurst={true}` and `intro={true}`. Faulty Terminal keeps `clickEffect="glitch"` and sets `mouseReact={false}` for page decoration. Pointer listeners are scoped to their container; the page background has `pointer-events: none`, so foreground controls cannot trigger effects.
- Faulty Terminal retains upstream `pageLoadAnimation={true}`: its first ready frame starts at reveal progress zero and the intro lasts two seconds. Readiness indicates successful drawing, not completion of the intro. Requested brightness 0.55 and the decorative layer opacity also lower the settled output; an immediate first-ready screenshot can therefore be nearly black.
- Faulty Terminal's layer opacity is reduced from 0.50 to 0.30 in dark mode and from 0.28 to 0.16 in light mode; its shader configuration is unchanged.
- Iridescence uses the supplied Pearl configuration exactly: `color="#ffffff"`, `hueShift={-119}`, `saturation={1.45}`, `brightness={1}`, `contrast={1}`, `speed={0.75}`, `scale={0.4}`, `detail={8}`, `warp={1.1}`, `rotation={-55}`, `mouseReact={true}`, `amplitude={0}`, `stir={1.55}`, `sheen={0.35}`, `clickSwirl={false}`, `grain={0.45}`, `fade={0}`. Its upstream shader and CSS are retained. Passive pointer movement preserves the requested stirring and sheen without intercepting controls; click swirls remain disabled. Theme layer opacity is 0.42 dark / 0.26 light.
- Gradient ASCII mounts two layers in one renderer, each 50% of the page height (`.cm-background-half--top` / `--bottom`). Top: `colors=['#1e3fd8','#f6f8ff','#a5d8ff','#38bdf8']`, `shape="horizon"`, `characters=" =+xX0S8#@"`, `cellSize={18}`, `density={0.8}`. Bottom: `colors=["#a855f7","#6366f1","#3b82f6","#7c3aed"]`, `shape="rise"`, `cellSize={22}`, `density={0.8}`, `variation={10}`, `scrambleRadius={0.25}`. Both pass `lightMode` and `dpr={1}`. The component reacts to the pointer (hover scramble trail, click ripple); for the page background `mouseInteraction={false}` and `clickEffect="none"` disable both, so `scrambleRadius` is accepted but inert. Two canvases exist for this option (each with `data-background-ready`), an exception to the one-canvas rule below. Theme opacity 0.55 dark / 0.30 light.
- Prism applies the upstream [`spire` preset](https://github.com/DavidHDev/react-bits/blob/4dc7b5b7772e1217c8fb8d2a7aa074302180e5b4/src/demo/Backgrounds/presets/Prism.js) (`height 6`, `baseWidth 3.4`, `scale 3.2`, `glow 1.5`, `colorFrequency 1.8`; other values are the preset `LOOK` defaults, which equal the component defaults) plus `animationType="3drotate"`, `interactive={false}`, `lightMode`, `dpr={1}`. Upstream `resolution` stays 0.5. Opacity 0.55 dark / 0.28 light.
- Particles · Warp (`particles-warp`) is a second profile of the same `Particles.tsx`: colors `#6366f1 #a855f7 #ffffff`, 3,620 particles, spread 12.5, speed 0.6, base size 230, glow 1.75, twinkle 0.5, `shape="sparkle"`, `depthOfField={1.05}`, connections with distance 160, `drift="forward"` at 2.4, `alphaParticles`, `variation={8}`, `hoverEffect="attract"` with hover and click burst off, `lightMode`, `pixelRatio={1}`. The existing `particles` profile is unchanged. This is the heaviest option: 3,620 instanced sparkle quads plus a connection pass. Bounds already in `Particles.tsx` apply and were not changed: connection candidates are limited to the first 900 particles (`MAX_LINKED`), at most 9,000 line segments (`MAX_LINES`), DPR 1 and the 30fps cap. Opacity 0.85 dark / 0.50 light.
- Balatro applies the upstream [`arcade` preset](https://github.com/DavidHDev/react-bits/blob/4dc7b5b7772e1217c8fb8d2a7aa074302180e5b4/src/demo/Backgrounds/presets/Balatro.js) (`pixelSize 4`, `crt 1`; no `color3`, so the component default `#162325` is kept), then overrides: `pixelSize={0}`, `crt={1}`, `color1="#6366f1"`, `color2="#0098ff"`, `contrast={5}`, `speed={1.2}`, `swirl={0.19}`, `scale={0.95}`, `lighting={0.6}`, `rotationSpeed={-0.3}`, `clickSwirl={false}`, `mouseInteraction={false}`, `lightMode`. Balatro has no `dpr` prop; `maxDevicePixelRatio={1}` bounds it, and the upstream 2.4M-pixel budget remains. Opacity 0.38 dark / 0.22 light.
- For all four, upstream `intro` defaults are kept. Pointer listeners are scoped to the (pointer-events none) page container instead of `window`, DPR is capped at 1.25 (and 1 by profile), frames are capped at 30fps, and failed WebGL/shader initialization throws to the error boundary. Light-theme `lightMode` is passed through each component's own prop.

## Runtime integration

- `backgrounds.ts` exports the `BackgroundId` union and fourteen picker options. The durable preference defaults to `soft-aurora`.
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

The outer element is `.cm-background[data-background="<BackgroundId>"]`. An initialized canvas has `data-background-ready="true"`. During animated rendering there should be exactly one background canvas (two for Gradient ASCII). For static states there are none; `[data-background-fallback]` reports `reduced-motion`, `page-hidden`, `context-lost`, `renderer-error`, or transient `loading`. The native QA inventory includes all fourteen options. Gradient ASCII has two ready canvases.

The initial 2026-10-29 pass compared upstream sources and reviewed lifecycle/props, then inspected the existing web development server. The original nine profiles initialized in both themes with one background canvas, and prior canvases disconnected on switches. Screenshots were captured and representative settled frames inspected; Particles framing was corrected after the initial sparse result. Browser checks also confirmed reduced-motion fallback and safe fallback from a saved Ferrofluid preference. Iridescence was added afterward with exact upstream shader/CSS and supplied-profile comparisons, TypeScript checking, and a mocked lifecycle check covering DPR, 30fps pacing, readiness, hidden/resume, context loss, GPU/listener/observer cleanup, StrictMode context retention and unavailable-WebGL fallback; that earlier nine-profile browser proof does not cover it. No production/Tauri build, packaging, manual server restart or automatic commit was run. Native WebView behavior and GPU performance across devices remain unverified.
