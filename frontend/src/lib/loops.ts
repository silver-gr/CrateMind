import { MIN_LOOP_S } from "./audio/stretchDeck";
import { beatPosition, shiftByBeats, type BeatGrid } from "./beatGrid";
import { snapToBeat } from "./quantize";

// Controller loop planning (pure). Loop positions are track time in seconds; beat lengths come from the track's own BPM
// (or, with Quantize, its beat grid), not the fader-scaled tempo, because the engine loops the source audio.
export type Loop = { start: number; end: number };
export type LoopOp = "toggle" | "half" | "double" | "in" | "out";
export type LoopPlan =
  | { ok: true; kind: "clear" }
  | { ok: true; kind: "beats"; beats: number }
  | { ok: true; kind: "set"; loop: Loop; beats: number }
  | { ok: false; reason: "no-bpm" | "range" | "limit" };

export const LOOP_DEFAULT_BEATS = 4;
/** Half / double steps cover 1/8 to 32 beats. */
export const LOOP_MIN_BEATS = 1 / 8;
export const LOOP_MAX_BEATS = 32;

export const beatSeconds = (bpm: number | null | undefined) => (bpm != null && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null);
const stepBeats = (beats: number, factor: 0.5 | 2) => Math.min(LOOP_MAX_BEATS, Math.max(LOOP_MIN_BEATS, beats * factor));

/**
 * `beats` is the length the next fresh loop gets; it follows half / double even while no loop is set.
 * `grid` (Quantize, see lib/quantize.ts): the playhead counts as its nearest beat and lengths are counted in the grid's
 * beats, so a loop starts on a beat and is a whole number of beats long (or the chosen fraction of one). Where the grid
 * has no beat near the playhead, the loop is planned as without it.
 */
export function planLoop(op: LoopOp, s: { position: number; duration: number; bpm: number | null | undefined; loop: Loop | null; beats: number; grid?: BeatGrid | null }): LoopPlan {
  const beat = beatSeconds(s.bpm);
  const fits = (loop: Loop, beats: number): LoopPlan =>
    loop.start >= 0 && loop.end <= s.duration && loop.end - loop.start >= MIN_LOOP_S ? { ok: true, kind: "set", loop, beats } : { ok: false, reason: "range" };
  const snapped = s.grid ? snapToBeat(s.grid, s.position, s.duration) : null;
  const grid = snapped === null ? null : s.grid!;
  const position = snapped ?? s.position;
  /** The time `beats` after `t` (before it when negative); null without a tempo. */
  const after = (t: number, beats: number) => grid ? t + shiftByBeats(grid, t, beats) : beat === null ? null : t + beats * beat;
  /** A loop between two set points: on a grid it runs a whole number of beats from its start. */
  const between = (start: number, end: number): Loop =>
    grid ? { start, end: start + shiftByBeats(grid, start, Math.max(1, Math.round(beatPosition(grid, end) - beatPosition(grid, start)))) } : { start, end };
  if (op === "toggle") {
    if (s.loop) return { ok: true, kind: "clear" };
    const end = after(position, s.beats);
    return end === null ? { ok: false, reason: "no-bpm" } : fits({ start: position, end }, s.beats);
  }
  if (op === "half" || op === "double") {
    const factor = op === "half" ? 0.5 : 2;
    const beats = stepBeats(s.beats, factor);
    if (beats === s.beats) return { ok: false, reason: "limit" };
    if (!s.loop) return { ok: true, kind: "beats", beats }; // only the next loop's length changes
    const { start, end } = s.loop;
    const length = s.grid ? shiftByBeats(s.grid, start, (beatPosition(s.grid, end) - beatPosition(s.grid, start)) * factor) : (end - start) * factor;
    return fits({ start, end: start + length }, beats);
  }
  if (op === "in") {
    if (s.loop && s.position < s.loop.end - MIN_LOOP_S) return fits(between(position, s.loop.end), s.beats);
    const end = after(position, s.beats);
    return end === null ? { ok: false, reason: "no-bpm" } : fits({ start: position, end }, s.beats);
  }
  if (s.loop && s.position > s.loop.start + MIN_LOOP_S) return fits(between(s.loop.start, position), s.beats);
  const start = after(position, -s.beats);
  return start === null ? { ok: false, reason: "no-bpm" } : fits({ start, end: position }, s.beats);
}
