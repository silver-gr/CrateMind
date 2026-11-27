// Transition automation curves (plan Appendix B), sampled for `AudioParam.setValueCurveAtTime`.
// u ∈ [0,1] across the window; volume is amplitude 0..1, EQ/filter are mixer knob values −1..1 (eqDb / filterParams).
import { ECHO_CUT_U } from "./echoOut";
import type { EqCurve, FilterCurve, TransitionParams, VolumeCurve } from "./types";

export interface Lane { volume: Float32Array; eqLo: Float32Array; eqMid: Float32Array; eqHi: Float32Array; filter: Float32Array }
export interface CurveSet { out: Lane; in: Lane; n: number }
export interface Eq { lo: number; mid: number; hi: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 before `a`, 1 after `b`, linear between. */
const ramp = (u: number, a: number, b: number) => clamp01((u - a) / (b - a));
/** 0 − x, never −0 (a cut-to-zero knob reads as a plain 0). */
const neg = (x: number) => 0 - x;

/** «Ηρεμία και drop»: the lull is the window's last sixteenth (one bar of the preset's 16), the outgoing deck at this level. */
export const LULL_U = 1 / 16;
export const LULL_LEVEL = 0.25;

export function volumeAt(c: VolumeCurve, u: number): { out: number; in: number } {
  switch (c) {
    case "smooth": return { out: Math.cos((u * Math.PI) / 2), in: Math.sin((u * Math.PI) / 2) };
    case "linear": return { out: 1 - u, in: u };
    case "overlap": return { out: u < 1 ? 1 : 0, in: 1 };
    case "fade_fade": return { out: 1 - u, in: Math.min(1, 2 * u) };
    case "cut_fade": return { out: 1 - u, in: 1 };
    case "fade_cut": return { out: u < 1 ? 1 : 0, in: Math.min(1, 2 * u) };
    case "center_cut":
    case "echo_out": return u < ECHO_CUT_U ? { out: 1, in: 0 } : { out: 0, in: 1 }; // the echo itself is the plan's `echo`
    case "fade_fast": return { out: u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25, in: u };
    // The outgoing deck falls over the second half to the lull level, holds it through the lull and stops at the end,
    // where the incoming deck (silent until then) comes in at full weight.
    case "lull_drop": return u < 1 ? { out: 1 - (1 - LULL_LEVEL) * ramp(u, 0.5, 1 - LULL_U), in: 0 } : { out: 0, in: 1 };
  }
}

const flat = (): Eq => ({ lo: 0, mid: 0, hi: 0 });
const bassSwap = (s: number) => ({ out: { lo: neg(s), mid: 0, hi: 0 }, in: { lo: s - 1, mid: 0, hi: 0 } });

/** `beatFraction` = one beat as a fraction of the window (for `bass_cut_quick`). */
export function eqAt(c: EqCurve, u: number, beatFraction: number): { out: Eq; in: Eq } {
  switch (c) {
    case "bass_swap_center": return bassSwap(ramp(u, 0.45, 0.55));
    case "bass_swap_end": return bassSwap(ramp(u, 0.9, 1));
    case "bass_swap_start": return bassSwap(ramp(u, 0, 0.1));
    case "bass_swap_staged": {
      // The incoming deck comes in without its lows, the basses swap at the middle, the outgoing mids and highs leave last.
      const s = ramp(u, 0.45, 0.55), top = neg(ramp(u, 0.75, 1));
      return { out: { lo: neg(s), mid: top, hi: top }, in: { lo: s - 1, mid: 0, hi: 0 } };
    }
    case "band_by_band": {
      // One band after another: highs over the first quarter, mids over the middle half, lows at the window's end.
      const hi = ramp(u, 0, 0.25), mid = ramp(u, 0.25, 0.75), lo = u < 1 ? 0 : 1;
      return { out: { lo: neg(lo), mid: neg(mid), hi: neg(hi) }, in: { lo: lo - 1, mid: mid - 1, hi: hi - 1 } };
    }
    case "three_band": return { out: { lo: neg(u), mid: neg(u), hi: neg(u) }, in: { lo: u - 1, mid: u - 1, hi: u - 1 } };
    case "bass_cut_quick": return { out: { lo: u < beatFraction ? 0 : -1, mid: 0, hi: 0 }, in: flat() };
    case "bass_cut_long":
    case "bass_fade_out": return { out: { lo: neg(u), mid: 0, hi: 0 }, in: flat() };
    case "fade_out_start": return { out: { lo: -1, mid: neg(u), hi: neg(u) }, in: flat() };
    case "none": return { out: flat(), in: flat() };
  }
}

/** Knob: negative = low-pass sweep, positive = high-pass sweep (see `filterParams`). */
export function filterAt(c: FilterCurve, u: number): { out: number; in: number } {
  const lpOut = neg(u), hpOut = u, lpIn = u - 1, hpIn = 1 - u;
  switch (c) {
    case "lpf_out": return { out: lpOut, in: 0 };
    case "lpf_in": return { out: 0, in: lpIn };
    case "lpf_in_lpf_out": return { out: lpOut, in: lpIn };
    case "lpf_in_hpf_out": return { out: hpOut, in: lpIn };
    case "hpf_out": return { out: hpOut, in: 0 };
    case "hpf_in": return { out: 0, in: hpIn };
    case "hpf_in_hpf_out": return { out: hpOut, in: hpIn };
    case "hpf_in_lpf_out": return { out: lpOut, in: hpIn };
    case "hpf_half_out": return { out: 0.5 * u, in: 0 };
    case "none": return { out: 0, in: 0 };
  }
}

const lane = (n: number): Lane => ({
  volume: new Float32Array(n), eqLo: new Float32Array(n), eqMid: new Float32Array(n), eqHi: new Float32Array(n), filter: new Float32Array(n),
});

/** `n` samples at u = i/(n−1), so the first is the window start and the last its end (n ≥ 2). */
export function sampleCurves(p: Pick<TransitionParams, "volume_curve" | "eq_curve" | "filter_curve">, n: number, beatFraction: number): CurveSet {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`sampleCurves needs at least 2 samples, got ${n}`);
  const out = lane(n), inn = lane(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const v = volumeAt(p.volume_curve, u), e = eqAt(p.eq_curve, u, beatFraction), f = filterAt(p.filter_curve, u);
    out.volume[i] = v.out; inn.volume[i] = v.in;
    out.eqLo[i] = e.out.lo; out.eqMid[i] = e.out.mid; out.eqHi[i] = e.out.hi;
    inn.eqLo[i] = e.in.lo; inn.eqMid[i] = e.in.mid; inn.eqHi[i] = e.in.hi;
    out.filter[i] = f.out; inn.filter[i] = f.in;
  }
  return { out, in: inn, n };
}
