# Spectral overview and seeking implementation plan

**Goal:** Use the supplied djay comparisons to improve colour separation, replace decorative deck overview bars with continuous audio-derived silhouettes, and restore overview click/drag seeking.

**Architecture:** Reuse the existing coalesced CMWD v2 cache for overview RMS/peak/RGB. Build the overview canvas only when data, dimensions or palette change, then redraw the cached image cheaply. Keep the lightweight envelope cache used by controller telemetry. Add a native range input in DeckHeader and connect it to the existing guarded `seekTo` handler; MiniPlayer changes stay limited to props.

**Evidence:** The screenshots show useful signed-PCM detail but narrow pastel theme hues. `AudioWaveform` currently uses a time-position gradient, 2 px bars/1 px gaps and a dim reflection. `DeckHeader` has no seek callback or input. The single-deck dock already has a functioning range overlay. GitNexus MCP is unavailable; direct caller/usage review found DeckHeader, MiniPlayer and display-only TaggingQueue, plus `cachedWaveform` controller telemetry.

## Constraints

- Source audio and djay files remain read-only. Synthetic tests/QA only.
- Preserve unrelated artist-research and native QA edits; no commit, push or release requested.
- Do not alter transport engines, jog behaviour, timing or source ownership.
- Preserve existing palette choices while broadening theme spectral roles. No persistent preference overwrite.
- Overview rendering cannot trigger whole-track density requests or per-frame FFT/aggregation.
- All new user-facing copy is Greek.

## Tasks and ownership

- [x] Overview executor: new `frontend/src/lib/overviewWaveform.ts`, `frontend/src/components/ui/SpectralOverview.tsx`, opt-in `spectral` mode in `TrackWaveform.tsx`, and synthetic helper tests. Retain existing envelope loader/cache for telemetry and non-deck callers. Acquire/release detail requests with stale-result guards. Use the recovered continuous overview geometry, documented approximations where CMWD differs, and shared palette mapping.
- [x] Leader: expose `waveformColor(r,g,b,palette)` in `deckScroll.ts`; broaden theme hue anchors across rose/amber/green/cyan/blue/violet with bounded chroma enhancement and unchanged brightness/neutral handling. Add hue-family and neutral regression tests. Update the theme option label.
- [x] Leader: add `onSeek`, `canSeek` and cue/slot props to DeckHeader; render an accessible native range over the overview, plus compact cue triangles using existing cue presentation. Wire through the sole MiniPlayer caller and opt its single-deck overview into spectral rendering. Keep the existing `seekTo` identity/readiness guards and playing/paused state.
- [x] Verify synthetic overview dynamics, no dashed gaps or invented colour gradients, exact first/last coverage, source-revision changes, disabled state, keyboard, click, drag, paused seek, playing seek and cue click precedence. Independently review changes.
- [x] Run frontend tests/builds and synthetic browser QA with the actual header and seek control. Rebuild/verify preview using current repo version and existing desktop procedure, then reopen for the user's comparison.

## Shared interface

`waveformColor(r:number, g:number, b:number, palette:WaveformPalette): [number,number,number]` returns byte-domain RGB, preserving input brightness and neutral colours. `renderOverviewRGBA(w:DetailWaveform,width:number,height:number,palette:WaveformPalette)` produces a continuous full-track overview. `TrackWaveform` adds optional `spectral?:boolean` (default false); existing props and `cachedWaveform()` are unchanged.

## Acceptance

The overview shows the track's actual sections with frequency-derived colours at every point, stays readable before playback, and moves playback by click/drag without toggling play/pause. The detailed density texture remains unchanged. User comparison against the supplied djay screenshots remains the final perceptual check.

Follow-up details: shared cm-overview-seek CSS removes native thumb inset in both header and single-deck dock. An 8-minute benchmark exposed resize/palette rescans; a WeakMap 4096-bin summary now reduces repeated rendering to about 1–6 ms. All 470 frontend tests pass and the actual header seek/browser lifecycle checks pass. Desktop frontend, frozen backend self-test and native bundle verification passed; the preview was reopened. No commit or push.
