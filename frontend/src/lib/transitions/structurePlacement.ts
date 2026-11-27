// Where a transition window sits when it is timed from the tracks' measured structure (pure): the incoming track's first
// bass lands on the bass swap, and the swap sits on the outgoing phrase line where its bass stops. Times are source seconds.
import { snapToBar, timeAfterBars, type BeatGrid } from "../beatGrid";
import { sectionKinds, type TrackStructure } from "../trackStructure";
import type { EqCurve, FilterCurve } from "./types";

/** What the planner reads of a structure; the phrase lines come from the lane's own grid (`grid.phrases`). */
export type LaneStructure = Pick<TrackStructure, "sections">;

const EPS = 1e-6;
const bar = (grid: BeatGrid, t: number) => snapToBar(grid, t, "nearest");

/**
 * The bars after the window start at which the incoming bass is heard. An incoming high-pass opens only at the end,
 * whatever the EQ does; curves without a bass swap count the window end as theirs (a decision, not read from the curves).
 */
export function swapBar(eq: EqCurve, filter: FilterCurve, bars: number): number {
  if (filter === "hpf_in" || filter === "hpf_in_hpf_out" || filter === "hpf_in_lpf_out") return bars;
  if (eq === "bass_swap_start" || eq === "fade_out_start") return 0;
  if (eq === "bass_swap_center" || eq === "bass_swap_staged" || eq === "three_band") return Math.floor(bars / 2);
  return bars;
}

/**
 * The bar where the bass first comes in, when an intro precedes it and it is in the track's first half; else null.
 * With a build-up before it, this is the drop: the build-up's bass plays through the lead-in, as an intro would.
 */
export function bassEntryS(s: LaneStructure, grid: BeatGrid, duration: number): number | null {
  const first = sectionKinds(s.sections).indexOf("main");
  if (first < 1) return null;
  const t = bar(grid, s.sections[first].start_s);
  return t <= duration / 2 ? t : null;
}

/** Where the bass stops for good (the outro's start); null when the track ends with bass. */
export function bassStopS(s: LaneStructure): number | null {
  const outro = sectionKinds(s.sections).indexOf("outro");
  return outro < 0 ? null : s.sections[outro].start_s;
}

/** The grid's phrase lines, each on its nearest bar line, sorted, without duplicates. */
export function phraseBars(grid: BeatGrid): number[] {
  const bars = (grid.phrases ?? []).map(t => bar(grid, t)).sort((a, b) => a - b);
  return bars.filter((t, i) => i === 0 || t - bars[i - 1] > EPS);
}

/**
 * The outgoing window start that puts the swap (`k` bars in) on the latest phrase line at or before the bass stop, in the
 * track's second half, with the whole window inside the track and not before `notBeforeS`; null when no line qualifies.
 */
export function structureOutStart(grid: BeatGrid, duration: number, s: LaneStructure, bars: number, k: number, notBeforeS?: number): number | null {
  const stop = bassStopS(s);
  const limit = stop == null ? Infinity : bar(grid, stop);
  const earliest = Math.max(snapToBar(grid, 0, "up"), notBeforeS ?? -Infinity);
  const lines = phraseBars(grid);
  for (let i = lines.length - 1; i >= 0 && lines[i] >= duration / 2 - EPS; i--) {
    if (lines[i] > limit + EPS) continue;
    const w = timeAfterBars(grid, lines[i], -k);
    if (w >= earliest - EPS && timeAfterBars(grid, w, bars) <= duration + EPS) return w;
  }
  return null;
}

/** The incoming start `leadS` before the first bass, on a bar line; null without a bass entry or when it is before today's start. */
export function structureInStart(grid: BeatGrid, duration: number, s: LaneStructure, leadS: number, todayStartS: number): number | null {
  const entry = bassEntryS(s, grid, duration);
  if (entry == null) return null;
  const start = bar(grid, entry - leadS);
  return start >= todayStartS - EPS ? start : null;
}
