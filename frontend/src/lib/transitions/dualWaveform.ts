// Geometry of the dual transition waveform (the editor's two stacked lanes). Pure: no DOM, no React.
//
// The shared horizontal axis is AUDIO time: seconds of the mixed output, 0 at the window start. Each lane maps its own
// source seconds onto it, `audio = (source − anchorS) / rate`, so the outgoing lane (anchor = window start, rate = rateOut)
// and the incoming lane (anchor = inStartS, rate = rateIn ?? 1) line up at the window start and their bar lines stay
// aligned at unequal rates.
import type { DetailWaveform } from "../detailWaveform";
import { sampleBands } from "../deckScroll";
import { barIndexAt, barSeconds, beatsInRange, snapToBar, timeAfterBars, type BeatGrid, type GridBeat } from "../beatGrid";
import { BARS_MAX, BARS_MIN } from "./types";

/** One lane of the editor: which track, its grid and how its source seconds map onto the audio axis. */
export interface LaneSpec { trackId: number; revision: number | null | undefined; grid: BeatGrid; duration: number; rate: number; anchorS: number }
export type LaneMap = Pick<LaneSpec, "anchorS" | "rate">;
export type LaneBounds = Pick<LaneSpec, "grid" | "duration" | "rate">;
export interface WindowState { outStartS: number; bars: number; inStartS: number }

export const EDGE_HIT_PX = 10;
export const DRAG_THRESHOLD_PX = 4;
export const VIEW_MIN_BARS = 2;
export const VIEW_MAX_BARS = 32;
export const BAR_STEPS = [1, 2, 4, 8, 16, 32] as const;

/** Waveform-only copy (the rest of the editor's strings live in `copy.ts`). */
export const WAVEFORM_COPY = {
  label: "Παράθυρο μετάβασης",
  hint: "Σύρε το παράθυρο ή τα άκρα του. Βέλη: 1 beat, Shift: 1 bar, Alt: είσοδος, [ ]: διάρκεια.",
} as const;

const EPS = 1e-6;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const safeRate = (r: number) => (Number.isFinite(r) && r > 0 ? r : 1);

export const sourceToAudio = (lane: LaneMap, sourceS: number) => (sourceS - lane.anchorS) / safeRate(lane.rate);
export const audioToSource = (lane: LaneMap, audioS: number) => lane.anchorS + audioS * safeRate(lane.rate);

export interface ViewGeometry { centerAudioS: number; width: number; pxPerSec: number }

/** `bars` bars of the outgoing lane (each `barAudioS` audio seconds) fill `width` CSS px, centred on `centerAudioS`. */
export function viewGeometry(view: { centerAudioS: number; bars: number }, barAudioS: number, width: number): ViewGeometry {
  const span = Math.max(1, view.bars) * (Number.isFinite(barAudioS) && barAudioS > 0 ? barAudioS : 2);
  return { centerAudioS: view.centerAudioS, width, pxPerSec: Math.max(1, width) / span };
}
export const audioToX = (g: ViewGeometry, audioS: number) => g.width / 2 + (audioS - g.centerAudioS) * g.pxPerSec;
export const xToAudio = (g: ViewGeometry, x: number) => g.centerAudioS + (x - g.width / 2) / g.pxPerSec;

/** Audio length of the window: its bars counted on the outgoing grid in source seconds, played at `rateOut`. */
export const windowAudioS = (outGrid: BeatGrid, outStartS: number, bars: number, rateOut: number) =>
  (timeAfterBars(outGrid, outStartS, bars) - outStartS) / safeRate(rateOut);

/** Playhead x of each lane from its own source position. */
export function playheadXs(g: ViewGeometry, out: LaneMap, inn: LaneMap, p: { outS: number; inS: number }): { out: number; in: number } {
  return { out: audioToX(g, sourceToAudio(out, p.outS)), in: audioToX(g, sourceToAudio(inn, p.inS)) };
}

export interface AudioBeat extends GridBeat { audio: number }

/** A lane's beats inside the audio range [audio0, audio1], each with its audio time. */
export function laneBeats(lane: LaneMap & { grid: BeatGrid }, audio0: number, audio1: number): AudioBeat[] {
  return beatsInRange(lane.grid, audioToSource(lane, audio0), audioToSource(lane, audio1)).map(b => ({ ...b, audio: sourceToAudio(lane, b.time) }));
}

/** 0..1 height of a curve sample: full volume, a flat EQ knob and an open filter sit at the top. */
export function curveLevel(kind: "volume" | "eq" | "filter", v: number): number {
  if (kind === "volume") return clamp01(v);
  if (kind === "eq") return clamp01(1 + Math.min(0, v));
  return clamp01(1 - Math.abs(v));
}

/** Flat [x, y, x, y, …] for 0..1 levels spread evenly over [x0, x1]: 1 → `top`, 0 → `bottom`. */
export function curvePolyline(levels: ArrayLike<number>, x0: number, x1: number, top: number, bottom: number): number[] {
  const n = levels.length;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    pts.push(n === 1 ? x0 : x0 + ((x1 - x0) * i) / (n - 1), bottom + (top - bottom) * clamp01(levels[i]));
  }
  return pts;
}

export type WindowHit = "start" | "end" | "body" | null;

/** Which part of the window bracket [x0, x1] is under `x`; the edges take ±`edge` px and the nearer one wins. */
export function hitTestWindow(x: number, x0: number, x1: number, edge = EDGE_HIT_PX): WindowHit {
  const d0 = Math.abs(x - x0), d1 = Math.abs(x - x1);
  if (d0 <= edge || d1 <= edge) return d0 <= d1 ? "start" : "end";
  return x > x0 && x < x1 ? "body" : null;
}

/** Apple's rubber-band: past a bound the element follows less and less, never more than `dimension`. Sign kept. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (overshoot === 0 || !(dimension > 0)) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** The beat at or before (`down`), nearest to, or at or after (`up`) `t`; list grids use their real beats inside the bar. */
export function snapToBeat(grid: BeatGrid, t: number, dir: "down" | "nearest" | "up"): number {
  if (grid.kind === "straight") {
    const x = (t - grid.anchor) / grid.period;
    const n = dir === "down" ? Math.floor(x + EPS) : dir === "up" ? Math.ceil(x - EPS) : Math.round(x);
    return grid.anchor + n * grid.period;
  }
  const bar0 = snapToBar(grid, t, "down");
  const bar1 = timeAfterBars(grid, bar0, 1);
  const inside = beatsInRange(grid, bar0 + EPS, bar1 - EPS).map(b => b.time);
  const cands = inside.length === 3 ? [bar0, ...inside, bar1] : [0, 1, 2, 3, 4].map(k => bar0 + ((bar1 - bar0) * k) / 4);
  if (dir === "down") return [...cands].reverse().find(c => c <= t + EPS) ?? bar0;
  if (dir === "up") return cands.find(c => c >= t - EPS) ?? bar1;
  return cands.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best), cands[0]);
}

/** One beat after (`dir` 1) or before (−1) the beat nearest `t`. */
export function stepBeat(grid: BeatGrid, t: number, dir: 1 | -1): number {
  const at = snapToBeat(grid, t, "nearest");
  return snapToBeat(grid, dir > 0 ? at + EPS * 10 : at - EPS * 10, dir > 0 ? "up" : "down");
}

/**
 * The window snapped onto the grids and kept inside both tracks, in source time:
 * the outgoing start on a bar (`unit` "bar") or beat line, `bars` a whole number in 1..32, the outgoing end ≤ its duration,
 * the incoming start on one of its own beats with `inStartS + window audio · rateIn ≤ in.duration`. When a track is
 * shorter than the window, bars shrink one at a time.
 */
export function snapWindow(w: WindowState, out: LaneBounds, inn: LaneBounds, unit: "bar" | "beat" = "bar"): WindowState {
  const snapOut = (t: number, dir: "down" | "nearest" | "up") => (unit === "bar" ? snapToBar(out.grid, t, dir) : snapToBeat(out.grid, t, dir));
  const outLo = snapOut(0, "up");
  const inLo = snapToBeat(inn.grid, 0, "up");
  const wanted = clamp(Math.round(Number.isFinite(w.bars) ? w.bars : BARS_MIN), BARS_MIN, BARS_MAX);
  for (let bars = wanted; bars >= BARS_MIN; bars--) {
    let outStart = Math.max(outLo, snapOut(w.outStartS, "nearest"));
    if (timeAfterBars(out.grid, outStart, bars) > out.duration + EPS) outStart = snapOut(timeAfterBars(out.grid, out.duration, -bars), "down");
    if (outStart < outLo - EPS || timeAfterBars(out.grid, outStart, bars) > out.duration + EPS) continue;
    const inSpan = windowAudioS(out.grid, outStart, bars, out.rate) * safeRate(inn.rate);
    let inStart = Math.max(inLo, snapToBeat(inn.grid, w.inStartS, "nearest"));
    if (inStart + inSpan > inn.duration + EPS) inStart = snapToBeat(inn.grid, inn.duration - inSpan, "down");
    if (inStart < inLo - EPS) continue;
    return { outStartS: outStart, bars, inStartS: inStart };
  }
  return { outStartS: Math.max(outLo, w.outStartS), bars: BARS_MIN, inStartS: Math.max(inLo, w.inStartS) };
}

/** `[`/`]`: the next length on 1, 2, 4, 8, 16, 32 (a value between two steps goes to the neighbour in that direction). */
export function stepBars(bars: number, dir: 1 | -1): number {
  if (dir > 0) return BAR_STEPS.find(s => s > bars) ?? BAR_STEPS[BAR_STEPS.length - 1];
  return [...BAR_STEPS].reverse().find(s => s < bars) ?? BAR_STEPS[0];
}

export const barsLabel = (bars: number) => (bars === 1 ? "1 bar" : `${bars} bars`);

/** «μπάρες 51–58 · 8 bars»: the outgoing track's bars under the window (for screen readers). */
export function windowDescription(outGrid: BeatGrid, outStartS: number, bars: number): string {
  const a = Math.max(1, barIndexAt(outGrid, outStartS));
  const b = Math.max(a, barIndexAt(outGrid, timeAfterBars(outGrid, outStartS, bars) - barSeconds(outGrid, outStartS) / 16));
  return a === b ? `μπάρα ${a} · ${barsLabel(bars)}` : `μπάρες ${a}–${b} · ${barsLabel(bars)}`;
}

/** Per-column [rms, peak, r, g, b] of a lane's source range [t0, t1] split into `width` columns. */
export function laneColumns(detail: DetailWaveform, sourceT0: number, sourceT1: number, width: number): number[][] {
  const cols: number[][] = [];
  const n = Math.max(0, Math.floor(width));
  const step = (sourceT1 - sourceT0) / Math.max(1, n);
  for (let x = 0; x < n; x++) cols.push(sampleBands(detail, sourceT0 + x * step, sourceT0 + (x + 1) * step, [0, 0, 0, 0, 0]));
  return cols;
}
