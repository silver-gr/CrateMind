// The two hand presets of batch 10: «Ηρεμία και drop» and «Μία ζώνη τη φορά» (their curves and the plans they produce).
import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { eqAt, LULL_LEVEL, LULL_U, volumeAt, type Lane } from "../src/lib/transitions/curves";
import { bassClashBars, keyClashBars } from "../src/lib/transitions/flags";
import { planTransition, type LaneInput } from "../src/lib/transitions/planner";
import { applyPreset, HAND_PRESETS, presetFor } from "../src/lib/transitions/presets";
import type { HandPreset, TransitionParams } from "../src/lib/transitions/types";

/** 120 BPM: 0.5 s beats, 2 s bars, 16 s phrases. */
const straight = (phrases?: number[]): BeatGrid => ({ kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false, phrases });
const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: straight(), duration: 240, cues: [], rate: 1, onEngine: true, ...o });
const hand = (preset: HandPreset, o: Partial<TransitionParams> = {}): TransitionParams =>
  ({ ...HAND_PRESETS[preset], preset, out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o });
/** Seconds into the window of sample `i` of a plan's curves. */
const secondsAt = (i: number, n: number, windowS: number) => (i / (n - 1)) * windowS;
/** The first sample where the incoming band is at least the outgoing one. */
const crossing = (out: Float32Array, inn: Float32Array) => out.findIndex((o, i) => inn[i] >= o);

describe("«Ηρεμία και drop»", () => {
  test("a hand preset: 16 bars, its own volume curve, the outgoing high-pass, no EQ; it round-trips", () => {
    expect(HAND_PRESETS.lull_drop).toEqual({ volume_curve: "lull_drop", eq_curve: "none", filter_curve: "hpf_out", bars: 16, loop_beats: null });
    const base = hand("echo_out");
    expect(presetFor(applyPreset("lull_drop", base))).toBe("lull_drop");
  });

  test("the volume curve: the outgoing deck alone, falling to the lull, the incoming deck silent until the window's end", () => {
    expect(volumeAt("lull_drop", 0)).toEqual({ out: 1, in: 0 });
    expect(volumeAt("lull_drop", 0.5)).toEqual({ out: 1, in: 0 });
    expect(volumeAt("lull_drop", 1 - LULL_U).out).toBeCloseTo(LULL_LEVEL, 9);
    expect(volumeAt("lull_drop", 0.99)).toEqual({ out: LULL_LEVEL, in: 0 });
    expect(volumeAt("lull_drop", 1)).toEqual({ out: 0, in: 1 });
    // Never louder on the way down.
    for (let u = 0, last = 1; u <= 1; u += 1 / 256) { const v = volumeAt("lull_drop", u).out; expect(v).toBeLessThanOrEqual(last); last = v; }
  });

  test("the plan: thinned from the start, a one-bar lull, and the drop on the window's end, 16 bars into the incoming track", () => {
    const plan = planTransition(lane(), lane(), hand("lull_drop"));
    expect(plan.kind).toBe("mix");
    expect(plan.bars).toBe(16);
    expect([plan.outStartS, plan.outEndS, plan.inStartS, plan.inEndS, plan.windowAudioS]).toEqual([206, 238, 0, 32, 32]);
    expect("echo" in plan).toBe(false);
    const { out, in: inn, n } = plan.curves!;
    // The outgoing high-pass is past the bass (knob 0.3) by the window's third.
    expect(out.filter[Math.round(0.35 * (n - 1))]).toBeGreaterThan(0.3);
    expect(inn.filter.every(x => x === 0)).toBe(true);
    // The lull: from where the outgoing deck reaches its lull level to the drop.
    const lullFrom = out.volume.findIndex(v => v <= LULL_LEVEL + 1e-6);
    expect(plan.windowAudioS - secondsAt(lullFrom, n, plan.windowAudioS)).toBeCloseTo(2, 1); // one bar at 120 BPM
    // The incoming deck is silent until the last sample, then at full weight with a flat EQ.
    expect(inn.volume.subarray(0, n - 1).every(v => v === 0)).toBe(true);
    expect([inn.volume[n - 1], inn.eqLo[n - 1], inn.eqMid[n - 1], inn.eqHi[n - 1], out.volume[n - 1]]).toEqual([1, 0, 0, 0, 0]);
    // The drop: 16 bars after the incoming start, so on its phrase line when the start is on one.
    expect(plan.inEndS - plan.inStartS).toBe(32);
  });

  test("the lull is the window's last sixteenth: half a bar at 8 bars", () => {
    const plan = planTransition(lane(), lane(), hand("lull_drop", { bars: 8 }));
    const { out, n } = plan.curves!;
    const lullFrom = out.volume.findIndex(v => v <= LULL_LEVEL + 1e-6);
    expect(plan.windowAudioS - secondsAt(lullFrom, n, plan.windowAudioS)).toBeCloseTo(1, 1);
  });

  test("timed from the structure: the drop is the outgoing phrase line at its bass stop and the incoming track's first bass", () => {
    const outStructure = { sections: [{ start_s: 0, beats: 64, bass: false, level: 0 }, { start_s: 32, beats: 336, bass: true, level: 1 }, { start_s: 200, beats: 80, bass: false, level: 0 }] };
    const inStructure = { sections: [{ start_s: 0, beats: 128, bass: false, level: 0 }, { start_s: 64, beats: 352, bass: true, level: 1 }] };
    const lines = Array.from({ length: 16 }, (_, i) => i * 16);
    const plan = planTransition(lane({ grid: straight(lines), structure: outStructure }), lane({ grid: straight(lines), structure: inStructure }), hand("lull_drop"));
    expect(plan.reasons).toEqual(expect.arrayContaining(["structure_out", "structure_in"]));
    expect([plan.outEndS, plan.inEndS]).toEqual([192, 64]);
  });

  test("the bass is never doubled and the keys never meet", () => {
    const structure = { sections: [{ start_s: 0, beats: 480, bass: true, level: 1 }], quality: 1 };
    const flagLane = { grid: straight(), structure };
    const w = { outStartS: 120, inStartS: 0, bars: 16, rateIn: null };
    expect(bassClashBars(flagLane, flagLane, hand("lull_drop"), w)).toBeNull();
    expect(keyClashBars({ key_text: "8A" }, { key_text: "2B" }, hand("lull_drop"))).toBeNull();
  });
});

describe("«Μία ζώνη τη φορά»", () => {
  test("a hand preset: 16 bars, overlap volume, its own EQ curve, no filter; it round-trips", () => {
    expect(HAND_PRESETS.band_by_band).toEqual({ volume_curve: "overlap", eq_curve: "band_by_band", filter_curve: "none", bars: 16, loop_beats: null });
    expect(presetFor(applyPreset("band_by_band", hand("echo_out")))).toBe("band_by_band");
    // The same volume with all three bands together is still «Ανάμειξη».
    expect(presetFor({ ...applyPreset("band_by_band", hand("echo_out")), eq_curve: "three_band" })).toBe("blend");
  });

  test("the EQ curve: highs over the first quarter, mids over the middle half, lows on the window's end", () => {
    const at = (u: number) => eqAt("band_by_band", u, 1 / 64);
    expect(at(0)).toEqual({ out: { lo: 0, mid: 0, hi: 0 }, in: { lo: -1, mid: -1, hi: -1 } });
    expect(at(0.125).out.hi).toBeCloseTo(-0.5, 9);
    expect(at(0.25)).toEqual({ out: { lo: 0, mid: 0, hi: -1 }, in: { lo: -1, mid: -1, hi: 0 } });
    expect(at(0.5).out.mid).toBeCloseTo(-0.5, 9);
    expect(at(0.75)).toEqual({ out: { lo: 0, mid: -1, hi: -1 }, in: { lo: -1, mid: 0, hi: 0 } });
    expect(at(0.999)).toEqual(at(0.75));
    expect(at(1)).toEqual({ out: { lo: -1, mid: -1, hi: -1 }, in: { lo: 0, mid: 0, hi: 0 } });
  });

  test("the plan: the bands hand over one after another, highs at 2 bars, mids at 8, lows on the line at 16", () => {
    const plan = planTransition(lane(), lane(), hand("band_by_band"));
    expect(plan.kind).toBe("mix");
    expect(plan.bars).toBe(16);
    const { out, in: inn, n } = plan.curves!;
    const bar = (l: Lane, m: Lane, band: "eqHi" | "eqMid" | "eqLo") => secondsAt(crossing(l[band], m[band]), n, plan.windowAudioS) / 2;
    const hi = bar(out, inn, "eqHi"), mid = bar(out, inn, "eqMid"), lo = bar(out, inn, "eqLo");
    expect(hi).toBeCloseTo(2, 1);
    expect(mid).toBeCloseTo(8, 1);
    expect(lo).toBe(16);
    expect(hi < mid && mid < lo).toBe(true);
    // Both decks stay up through the window; the outgoing one stops at its end.
    expect(out.volume.subarray(0, n - 1).every(v => v === 1) && inn.volume.every(v => v === 1)).toBe(true);
    expect(out.volume[n - 1]).toBe(0);
  });

  test("bass never doubled: the incoming lows stay cut while the outgoing deck still plays its own", () => {
    const plan = planTransition(lane(), lane(), hand("band_by_band"));
    const { out, in: inn, n } = plan.curves!;
    for (let i = 0; i < n; i++) {
      const outBass = out.volume[i] >= 0.5 && out.eqLo[i] > -0.5, inBass = inn.volume[i] >= 0.5 && inn.eqLo[i] > -0.5;
      expect(outBass && inBass).toBe(false);
    }
    const structure = { sections: [{ start_s: 0, beats: 480, bass: true, level: 1 }], quality: 1 };
    const flagLane = { grid: straight(), structure };
    expect(bassClashBars(flagLane, flagLane, hand("band_by_band"), { outStartS: 120, inStartS: 0, bars: 16, rateIn: null })).toBeNull();
  });

  test("timed from the structure: the lows swap on the outgoing phrase line at its bass stop, on the incoming first bass", () => {
    const outStructure = { sections: [{ start_s: 0, beats: 64, bass: false, level: 0 }, { start_s: 32, beats: 336, bass: true, level: 1 }, { start_s: 200, beats: 80, bass: false, level: 0 }] };
    const inStructure = { sections: [{ start_s: 0, beats: 128, bass: false, level: 0 }, { start_s: 64, beats: 352, bass: true, level: 1 }] };
    const lines = Array.from({ length: 16 }, (_, i) => i * 16);
    const plan = planTransition(lane({ grid: straight(lines), structure: outStructure }), lane({ grid: straight(lines), structure: inStructure }), hand("band_by_band"));
    expect([plan.outEndS, plan.inEndS]).toEqual([192, 64]);
  });
});
