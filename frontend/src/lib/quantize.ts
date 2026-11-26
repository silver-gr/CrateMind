// Quantize («Q»): loop ends and cues land on the deck's beats. Pure; callers pass a grid only when Sync would trust it.
import { beatPhase, beatPosition, timeAtBeat, type BeatGrid } from "./beatGrid";
import { gridFits } from "./deckSync";

/** The grid Quantize goes by: the one Sync holds the beats with (stored, or an estimate with the user's downbeat, and
 * not contradicted by the deck's tempo). null: no beats to trust, so nothing is snapped. */
export const quantizeGrid = (grid: BeatGrid | null, bpm: number | null): BeatGrid | null =>
  grid && (!grid.estimated || grid.overridden) && gridFits(grid, bpm) ? grid : null;

/** The beat number (a multiple of `step` beats) nearest `t` that is inside the track and, on a beat list, inside the
 * list; null when there is none. */
function nearestBeat(grid: BeatGrid, t: number, maxS: number, step: number): number | null {
  if (!Number.isFinite(t)) return null;
  let n = Math.round(beatPosition(grid, t) / step) * step;
  if (timeAtBeat(grid, n) < 0) n += step;
  else if (timeAtBeat(grid, n) > maxS) n -= step;
  const s = timeAtBeat(grid, n);
  if (!(s >= 0 && s <= maxS)) return null;
  if (grid.kind === "list" && (s < grid.times[0] || s > grid.times[grid.times.length - 1])) return null;
  return n;
}

/**
 * `t` moved onto the nearest beat (`step`: 0.5 for half beats) that lies in 0..`maxS`. null when there is no such beat:
 * more than half a step before the first or after the last beat of a list, where the grid says nothing.
 */
export function snapToBeat(grid: BeatGrid, t: number, maxS = Infinity, step = 1): number | null {
  const n = nearestBeat(grid, t, maxS, step);
  return n === null ? null : timeAtBeat(grid, n);
}

/**
 * Where a hot-cue jump lands on a playing deck: the cue moved by less than half a beat, so that it sits as far from a
 * beat as `from` (the playhead when the jump takes effect) does and the deck stays in time with the other one. A
 * playhead late in its beat lands just before the cue, so the cue's own beat is still heard. Kept within 0..`maxS`;
 * the cue itself when either point has no beat to go by.
 */
export function cueJump(grid: BeatGrid, from: number, cue: number, maxS = Infinity): number {
  if (beatPhase(grid, from) < 0 || nearestBeat(grid, cue, maxS, 1) === null) return cue;
  const at = beatPosition(grid, cue);
  const shift = beatPosition(grid, from) - at;
  const target = timeAtBeat(grid, at + shift - Math.floor(shift + 0.5));
  return Math.min(Math.max(target, 0), maxS);
}

/** A loop a whole number of beats long: the beat phase carries on through its wrap, so Sync can hold the beats through it. */
export function loopOnBeats(grid: BeatGrid, loop: { start: number; end: number }): boolean {
  const beats = beatPosition(grid, loop.end) - beatPosition(grid, loop.start);
  return Math.round(beats) >= 1 && Math.abs(beats - Math.round(beats)) < 1e-3;
}
