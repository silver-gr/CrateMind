# CrateMind DJ Workspace Implementation Plan

**Goal:** A compact DJ-library workspace with reliable playback shortcuts, eight durable cue pads, useful set actions, aligned tables and selectable themed React Bits backgrounds.
**Architecture:** Shared React UI and Python cue storage serve web and Tauri. Playback controls retain the existing source identity and single-audible-deck guarantees. Backgrounds mount one local renderer at a time with reduced-motion and low-cost fallbacks.
**Spec:** User request and five screenshots in current chat, 2026-10-28.

## Global constraints
- Preserve all existing cues and source music; no source audio/tag changes. No deletion of extra cues beyond eight pads.
- Greek UI, current cyan/chartreuse/violet palette, light and dark themes.
- Shared web/Tauri behavior; device preferences persist via existing preferenceStorage.
- No production writes or commits. Test writes only generated fixtures until final app startup. Any schema change requires compatible private-copy migrations and exchange validation.
- Space toggles the active deck, never inputs/dialogs; keys1–8 trigger assigned pads without rating writes. Empty pad click assigns; empty keyboard key must not silently create a cue.

## Tasks
- [x] Table/set lane: shared header/body column geometry; center all values/headers except title, BPM, key and fixed right action; persistent active-playing row/play affordance; move top set toolbar into right sidebar selector/menu without losing export/save/new/copy/mark-played.
- [x] Playback/cue lane: choose durable eight-slot mapping without overloading cue labels; preserve existing/overflow cues; 2x4 beveled colored pads with number/time, empty assign controls, per-pad time editor. Compact artwork with glass play overlay; waveform remains central; BPM/equalizer above volume. Keep limiter/gain behavior and cue identity guards.
- [x] Background lane: inspect official Scanner/Ferrofluid/Grainient/Threads/Particles/Aurora sources; reuse licensed implementations and existing dependencies; palette-specific light/dark controls; one renderer, bounded DPR, visibility/reduced-motion/WebGL-loss fallbacks.
- [x] Root integration: move audio settings beside theme in all sidebar states; persisted background selection; player dock adequate min/initial height; synchronize active playback status used by set row highlight.
- [x] Verification: fixture tests for key collisions, pad persistence/time edits/overflow, table geometry, all set actions; browser proof for Space/1–8 + typing guard, player layout, pads and six backgrounds/theme variants; full relevant unit/build tests; native smoke with generated audio; preserve live library before/after rebuild/reopen.

## Review focus
- Switching tracks while saving/editing cues must never attach a write to another track.
- Number/Space key handling must not also rate metadata, activate a focused unrelated button, or scroll the page.
- Pad numbers must stay attached to assigned cues across timestamp edits and restart, and deleting one must not delete/reassign other cues.
- 8 pads and waveform must remain usable at supported desktop sizes; menu actions available after toolbar removal.
- Every selected background must clean GPU/listeners on switch; one renderer only, none under reduced motion, no unreadable light-theme text.

## Implementation decisions
- Pads are stable per-device layouts referencing existing cue IDs in preferenceStorage. Cue records, schema and exchange stay unchanged; initial assignment is chronological, holes persist, overflow can be reassigned through the pad cog.
- Space intentionally overrides ordinary button activation while a deck is selected; text fields, open editors/dialogs/menus and ordinary non-player switches/selects retain native interaction. Player seek/volume controls and closed cue buttons accept Space; Enter still activates cue buttons. 1–8 are reserved for pads; Tagging Queue help discloses the collision policy.
- All six new backgrounds use pinned official native-WebGL2 sources, no new dependencies, with their complete upstream notice also shipped in public/licenses/react-bits.txt.
