// Plans one transition from the two decks' grids and cues (pure). Bars are counted on the outgoing grid in SOURCE seconds;
// the window lasts `windowAudioS` of audio at the outgoing rate, during which the incoming deck consumes source at `rateIn ?? 1`.
import { barSeconds, snapToBar, timeAfterBars, type BeatGrid } from "../beatGrid";
import type { TrackCue } from "../types";
import { sampleCurves, type CurveSet } from "./curves";
import { BARS_MAX, BARS_MIN, type TransitionParams } from "./types";

export interface LaneInput { trackId: number; grid: BeatGrid | null; duration: number; cues: TrackCue[]; rate: number; onEngine: boolean }

export interface TransitionPlan {
  kind: "mix" | "cut";
  /** Source seconds on the outgoing track; equal on a cut (the cut point). */
  outStartS: number;
  outEndS: number;
  /** Source seconds the incoming deck starts at and has reached by the window's end. */
  inStartS: number;
  inEndS: number;
  windowAudioS: number;
  bars: number;
  rateIn: number | null;
  rampBackBars: 8;
  loop: { start: number; end: number } | null;
  curves: CurveSet | null;
  reasons: string[];
}

/** Largest incoming rate change a tempo match may use (same limit as the backend's resolver). */
export const MAX_TEMPO_DEVIATION = 0.16;
const EPS = 1e-6;

/**
 * The incoming deck's rate that matches the outgoing deck's tempo: fold(outGridTempo·rateOut / inGridTempo) into
 * [0.7071, 1.4142); null when it is more than 16 % from 1 (the backend's `tempo_match_rate` is the same quantity).
 */
export function tempoMatchRate(outGridTempo: number, rateOut: number, inGridTempo: number): number | null {
  if (![outGridTempo, rateOut, inGridTempo].every(x => Number.isFinite(x) && x > 0)) return null;
  let r = (outGridTempo * rateOut) / inGridTempo;
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return Math.abs(r - 1) > MAX_TEMPO_DEVIATION ? null : r;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const cueTimes = (cues: TrackCue[], kind: TrackCue["kind"]) =>
  cues.filter(c => c.kind === kind).map(c => c.position_ms / 1000).filter(Number.isFinite).sort((a, b) => a - b);
const beatS = (grid: BeatGrid, t: number) => barSeconds(grid, t) / 4;

/** Incoming start: the saved anchor, else the first entry cue on its bar, else the first downbeat at or after 0:00; raw (entry ?? 0) when `grid` is null. */
function inAnchor(inn: LaneInput, grid: BeatGrid | null, params: TransitionParams, reasons: string[]): number {
  if (params.in_anchor_s != null) return clamp(params.in_anchor_s, 0, inn.duration);
  const entry = cueTimes(inn.cues, "entry")[0];
  if (entry != null) reasons.push("entry_cue");
  if (!grid) return entry ?? 0;
  if (entry == null) return snapToBar(grid, 0, "up");
  const s = snapToBar(grid, entry, "nearest");
  return s >= 0 ? s : snapToBar(grid, entry, "up");
}

/** Outgoing start for `bars`: the saved anchor, else the last exit cue after the midpoint, else the last bar line that fits the window. */
function outAnchor(out: LaneInput, grid: BeatGrid, params: TransitionParams, bars: number, reasons: string[]): number {
  if (params.out_anchor_s != null) return clamp(params.out_anchor_s, 0, out.duration);
  const exits = cueTimes(out.cues, "exit").filter(t => t > out.duration / 2);
  if (exits.length) {
    reasons.push("exit_cue");
    return snapToBar(grid, exits[exits.length - 1], "nearest");
  }
  let s = snapToBar(grid, out.duration - barSeconds(grid, out.duration) * (bars + 1), "down");
  // Irregular grids: step back a bar at a time (bounded) until the window ends inside the track.
  for (let i = 0; i < BARS_MAX && s > 0 && timeAfterBars(grid, s, bars) > out.duration + EPS; i++) s = timeAfterBars(grid, s, -1);
  return s;
}

interface Fit { outStartS: number; outEndS: number; inStartS: number; inEndS: number; windowAudioS: number; bars: number; rateIn: number | null; reasons: string[] }

/** The anchors and window for the requested bars, halving the bars (down to 1) until both tracks hold it; null window = no room/grid. */
function fitWindow(out: LaneInput, inn: LaneInput, params: TransitionParams): { fit: Fit | null; inStartS: number; reasons: string[] } {
  const base: string[] = [];
  const hasGrids = out.grid != null && inn.grid != null;
  const inStartS = inAnchor(inn, hasGrids ? inn.grid : null, params, base);
  if (!out.grid || !inn.grid) return { fit: null, inStartS, reasons: [...base, "no_grid"] };
  if (out.grid.estimated || inn.grid.estimated) base.push("grid_estimated");
  const inBeat = beatS(inn.grid, inStartS);
  let bars = clamp(Math.round(params.bars), BARS_MIN, BARS_MAX);
  for (;;) {
    const reasons = [...base];
    const outStartS = outAnchor(out, out.grid, params, bars, reasons);
    const outEndS = timeAfterBars(out.grid, outStartS, bars);
    const windowAudioS = (outEndS - outStartS) / out.rate;
    const rateIn = params.tempo_match ? tempoMatchRate(60 / beatS(out.grid, outStartS), out.rate, 60 / inBeat) : null;
    const inEndS = inStartS + windowAudioS * (rateIn ?? 1);
    if (outStartS >= 0 && windowAudioS > 0 && outEndS <= out.duration + EPS && inEndS <= inn.duration + EPS) {
      if (params.tempo_match && rateIn == null) reasons.push("bpm_out_of_range");
      return { fit: { outStartS, outEndS, inStartS, inEndS, windowAudioS, bars, rateIn, reasons }, inStartS, reasons };
    }
    if (bars === BARS_MIN) return { fit: null, inStartS, reasons: [...base, "no_room"] };
    bars = Math.max(BARS_MIN, Math.floor(bars / 2));
  }
}

/** Where the window sits in each track and how many bars fit (0 bars when it does not fit or a grid is missing). */
export function resolveAnchors(out: LaneInput, inn: LaneInput, params: TransitionParams): { outStartS: number; inStartS: number; bars: number; reasons: string[] } {
  const { fit, inStartS, reasons } = fitWindow(out, inn, params);
  return fit ? { outStartS: fit.outStartS, inStartS: fit.inStartS, bars: fit.bars, reasons } : { outStartS: out.duration, inStartS, bars: 0, reasons };
}

const cutPlan = (out: LaneInput, inStartS: number, reasons: string[]): TransitionPlan => ({
  kind: "cut", outStartS: out.duration, outEndS: out.duration, inStartS, inEndS: inStartS, windowAudioS: 0, bars: 0,
  rateIn: null, rampBackBars: 8, loop: null, curves: null, reasons,
});

/**
 * A mix plan, or a cut at the outgoing track's end when there is nothing to mix: preset «none», an element deck on either
 * side, a missing grid (`no_grid`) or no room for even 1 bar (`no_room`).
 */
export function planTransition(out: LaneInput, inn: LaneInput, params: TransitionParams): TransitionPlan {
  if (params.preset === "none" || !out.onEngine || !inn.onEngine) {
    const reasons: string[] = [];
    return cutPlan(out, inAnchor(inn, out.grid && inn.grid, params, reasons), reasons);
  }
  const { fit, inStartS, reasons } = fitWindow(out, inn, params);
  if (!fit || !out.grid) return cutPlan(out, inStartS, reasons);
  const span = fit.outEndS - fit.outStartS;
  const beat = beatS(out.grid, fit.outStartS);
  const loop = params.loop_beats ? { start: fit.outStartS, end: Math.min(fit.outEndS, fit.outStartS + params.loop_beats * beat) } : null;
  const curves = sampleCurves(params, Math.max(64, Math.round(fit.windowAudioS * 30)), beat / span);
  return {
    kind: "mix", outStartS: fit.outStartS, outEndS: fit.outEndS, inStartS: fit.inStartS, inEndS: fit.inEndS,
    windowAudioS: fit.windowAudioS, bars: fit.bars, rateIn: fit.rateIn, rampBackBars: 8, loop, curves, reasons,
  };
}
