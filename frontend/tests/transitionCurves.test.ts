import { describe, expect, test } from "bun:test";
import { eqAt, filterAt, sampleCurves, volumeAt, type Lane } from "../src/lib/transitions/curves";
import { EQ_CURVES, FILTER_CURVES, VOLUME_CURVES, type EqCurve, type FilterCurve, type VolumeCurve } from "../src/lib/transitions/types";

const N = 101;
const at = (u: number) => Math.round(u * (N - 1));
const curves = (volume_curve: VolumeCurve = "smooth", eq_curve: EqCurve = "none", filter_curve: FilterCurve = "none", beatFraction = 0.25) =>
  sampleCurves({ volume_curve, eq_curve, filter_curve }, N, beatFraction);
const LANE_KEYS: (keyof Lane)[] = ["volume", "eqLo", "eqMid", "eqHi", "filter"];

describe("volume curves", () => {
  test("smooth is equal-power at the midpoint", () => {
    const v = volumeAt("smooth", 0.5);
    expect(v.out).toBeCloseTo(Math.SQRT1_2, 6);
    expect(v.in).toBeCloseTo(Math.SQRT1_2, 6);
    for (const u of [0, 0.2, 0.7, 1]) {
      const p = volumeAt("smooth", u);
      expect(p.out ** 2 + p.in ** 2).toBeCloseTo(1, 6);
    }
  });

  test("linear sums to 1", () => {
    for (const u of [0, 0.1, 0.5, 0.9, 1]) {
      const v = volumeAt("linear", u);
      expect(v.out + v.in).toBeCloseTo(1, 9);
    }
  });

  test("overlap keeps the outgoing deck full until the last sample", () => {
    const c = curves("overlap");
    expect(Array.from(c.out.volume.slice(0, N - 1)).every(v => v === 1)).toBe(true);
    expect(c.out.volume[N - 1]).toBe(0);
    expect(Array.from(c.in.volume).every(v => v === 1)).toBe(true);
  });

  test("center_cut switches at the midpoint", () => {
    const c = curves("center_cut");
    expect(c.out.volume[at(0.49)]).toBe(1);
    expect(c.in.volume[at(0.49)]).toBe(0);
    expect(c.out.volume[at(0.5)]).toBe(0);
    expect(c.in.volume[at(0.5)]).toBe(1);
  });

  test("fade_fast holds the outgoing deck until 0.75", () => {
    expect(volumeAt("fade_fast", 0.74).out).toBe(1);
    expect(volumeAt("fade_fast", 0.875).out).toBeCloseTo(0.5, 9);
    expect(volumeAt("fade_fast", 1).out).toBe(0);
    expect(volumeAt("fade_fast", 0.3).in).toBeCloseTo(0.3, 9);
  });

  test("fade_fade / cut_fade / fade_cut", () => {
    expect(volumeAt("fade_fade", 0.25)).toEqual({ out: 0.75, in: 0.5 });
    expect(volumeAt("fade_fade", 0.75).in).toBe(1);
    expect(volumeAt("cut_fade", 0)).toEqual({ out: 1, in: 1 });
    expect(volumeAt("fade_cut", 0.99)).toEqual({ out: 1, in: 1 });
    expect(volumeAt("fade_cut", 1).out).toBe(0);
  });
});

describe("EQ curves", () => {
  test("bass_swap_center moves the lows only inside [0.45, 0.55]", () => {
    const c = curves("smooth", "bass_swap_center");
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      if (u <= 0.45) { expect(c.out.eqLo[i]).toBe(0); expect(c.in.eqLo[i]).toBe(-1); }
      if (u >= 0.55) { expect(c.out.eqLo[i]).toBe(-1); expect(c.in.eqLo[i]).toBe(0); }
    }
    expect(c.out.eqLo[at(0.5)]).toBeCloseTo(-0.5, 5);
    expect(Array.from(c.out.eqMid).every(v => v === 0)).toBe(true);
  });

  test("end and start swaps sit at the window edges", () => {
    expect(eqAt("bass_swap_end", 0.89, 0.25).out.lo).toBe(0);
    expect(eqAt("bass_swap_end", 1, 0.25).out.lo).toBe(-1);
    expect(eqAt("bass_swap_start", 0, 0.25).in.lo).toBe(-1);
    expect(eqAt("bass_swap_start", 0.1, 0.25).out.lo).toBe(-1);
  });

  test("three_band ramps all three bands on both decks", () => {
    const mid = eqAt("three_band", 0.5, 0.25);
    for (const band of ["lo", "mid", "hi"] as const) {
      expect(mid.out[band]).toBeCloseTo(-0.5, 9);
      expect(mid.in[band]).toBeCloseTo(-0.5, 9);
      expect(eqAt("three_band", 0, 0.25).out[band]).toBe(0);
      expect(eqAt("three_band", 0, 0.25).in[band]).toBe(-1);
      expect(eqAt("three_band", 1, 0.25).out[band]).toBe(-1);
      expect(eqAt("three_band", 1, 0.25).in[band]).toBe(0);
    }
  });

  test("bass_cut_quick drops the outgoing lows within one beat", () => {
    const bf = 0.125;
    expect(eqAt("bass_cut_quick", 0, bf).out.lo).toBe(0);
    expect(eqAt("bass_cut_quick", bf, bf).out.lo).toBe(-1);
    expect(eqAt("bass_cut_quick", 0.6, bf).out.lo).toBe(-1);
    expect(eqAt("bass_cut_quick", 0.6, bf).in).toEqual({ lo: 0, mid: 0, hi: 0 });
    const c = curves("center_cut", "bass_cut_quick", "none", bf);
    expect(c.out.eqLo[Math.ceil(bf * (N - 1))]).toBe(-1);
  });

  test("bass_cut_long, fade_out_start and bass_fade_out", () => {
    expect(eqAt("bass_cut_long", 0.5, 0.25).out.lo).toBeCloseTo(-0.5, 9);
    expect(eqAt("fade_out_start", 0, 0.25).out).toEqual({ lo: -1, mid: 0, hi: 0 });
    expect(eqAt("fade_out_start", 1, 0.25).out).toEqual({ lo: -1, mid: -1, hi: -1 });
    expect(eqAt("bass_fade_out", 1, 0.25).out.lo).toBe(-1);
    expect(eqAt("none", 0.5, 0.25)).toEqual({ out: { lo: 0, mid: 0, hi: 0 }, in: { lo: 0, mid: 0, hi: 0 } });
  });
});

describe("filter curves", () => {
  test("hpf_half_out ends at +0.5", () => {
    const c = curves("smooth", "none", "hpf_half_out");
    expect(c.out.filter[0]).toBe(0);
    expect(c.out.filter[N - 1]).toBeCloseTo(0.5, 6);
    expect(Array.from(c.in.filter).every(v => v === 0)).toBe(true);
  });

  test("LP is negative, HP positive, combos as named", () => {
    expect(filterAt("lpf_out", 1)).toEqual({ out: -1, in: 0 });
    expect(filterAt("lpf_in", 0)).toEqual({ out: 0, in: -1 });
    expect(filterAt("hpf_out", 1)).toEqual({ out: 1, in: 0 });
    expect(filterAt("hpf_in", 0)).toEqual({ out: 0, in: 1 });
    expect(filterAt("lpf_in_hpf_out", 0)).toEqual({ out: 0, in: -1 });
    expect(filterAt("lpf_in_hpf_out", 1)).toEqual({ out: 1, in: 0 });
    expect(filterAt("hpf_in_lpf_out", 1)).toEqual({ out: -1, in: 0 });
    expect(filterAt("none", 0.5)).toEqual({ out: 0, in: 0 });
  });
});

describe("sampleCurves", () => {
  test("every combination gives n finite, in-range Float32 samples per lane", () => {
    for (const v of VOLUME_CURVES) for (const e of EQ_CURVES) for (const f of FILTER_CURVES) {
      const c = sampleCurves({ volume_curve: v, eq_curve: e, filter_curve: f }, 33, 0.25);
      expect(c.n).toBe(33);
      for (const side of [c.out, c.in]) for (const key of LANE_KEYS) {
        const arr = side[key];
        expect(arr).toBeInstanceOf(Float32Array);
        expect(arr.length).toBe(33);
        const [lo, hi] = key === "volume" ? [0, 1] : [-1, 1];
        for (const x of arr) { expect(Number.isFinite(x)).toBe(true); expect(x >= lo && x <= hi).toBe(true); }
      }
    }
  });

  test("the first sample is u=0 and the last u=1", () => {
    const c = curves("linear");
    expect(c.out.volume[0]).toBe(1);
    expect(c.in.volume[0]).toBe(0);
    expect(c.out.volume[N - 1]).toBe(0);
    expect(c.in.volume[N - 1]).toBe(1);
  });

  test("fewer than two samples is refused", () => {
    expect(() => sampleCurves({ volume_curve: "linear", eq_curve: "none", filter_curve: "none" }, 1, 0.25)).toThrow();
  });
});
