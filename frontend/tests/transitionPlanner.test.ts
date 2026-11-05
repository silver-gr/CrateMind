import { describe, expect, test } from "bun:test";
import { timeAfterBars, type BeatGrid } from "../src/lib/beatGrid";
import { planTransition, resolveAnchors, tempoMatchRate, type LaneInput } from "../src/lib/transitions/planner";
import type { TransitionParams } from "../src/lib/transitions/types";
import type { TrackCue } from "../src/lib/types";

/** Straight grid, bar = 4 beats; 120 BPM → 2 s bars. */
const straight = (bpm = 120, anchor = 0, estimated = false): BeatGrid => ({ kind: "straight", anchor, period: 60 / bpm, estimated, overridden: false });
const cue = (kind: TrackCue["kind"], s: number, id = Math.round(s * 1000)) => ({ id, track_id: 1, kind, position_ms: s * 1000, label: null, created_at: "", updated_at: "" }) as TrackCue;
const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: straight(), duration: 200, cues: [], rate: 1, onEngine: true, ...o });
const params = (o: Partial<TransitionParams> = {}): TransitionParams => ({
  preset: "blend", bars: 8, volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none", loop_beats: null,
  out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o,
});

describe("tempoMatchRate: the incoming deck's rate, octave-folded", () => {
  test("values", () => {
    expect(tempoMatchRate(140, 1, 147)!).toBeCloseTo(0.9524, 4);
    expect(tempoMatchRate(80, 1, 160)).toBe(1);
    expect(tempoMatchRate(98, 1, 160)).toBeNull();
    expect(tempoMatchRate(140, 1.05, 140)!).toBeCloseTo(1.05, 9);
    expect(tempoMatchRate(140, 1, 120)).toBeNull();
    expect(tempoMatchRate(120, 1, 140)!).toBeCloseTo(0.8571, 4);
  });
  test("upper and lower boundaries", () => {
    expect(tempoMatchRate(140, 1, 121)).not.toBeNull();
    expect(tempoMatchRate(140, 1, 120.5)).toBeNull();
    expect(tempoMatchRate(117.7, 1, 140)).not.toBeNull();
    expect(tempoMatchRate(117.5, 1, 140)).toBeNull();
  });
  test("bad input is null", () => {
    expect(tempoMatchRate(0, 1, 120)).toBeNull();
    expect(tempoMatchRate(120, 1, Number.NaN)).toBeNull();
  });
});

describe("resolveAnchors", () => {
  test("the last exit cue after the midpoint wins; an early one is ignored", () => {
    const out = lane({ cues: [cue("exit", 60), cue("exit", 150.2), cue("exit", 170.1), cue("entry", 5)] });
    const r = resolveAnchors(out, lane(), params());
    expect(r.outStartS).toBe(170);
    expect(r.reasons).toContain("exit_cue");
  });
  test("only an early exit cue → the default anchor (duration − window − 1 bar, snapped down)", () => {
    const r = resolveAnchors(lane({ cues: [cue("exit", 60)] }), lane(), params());
    expect(r.outStartS).toBe(182);
    expect(r.bars).toBe(8);
    expect(r.reasons).not.toContain("exit_cue");
  });
  test("the default anchor snaps down to a bar line and the window fits", () => {
    // 199.3 s: 199.3 − 18 = 181.3 → 180; 180 + 16 = 196 ≤ 199.3.
    const r = resolveAnchors(lane({ duration: 199.3 }), lane(), params());
    expect(r.outStartS).toBe(180);
    expect(timeAfterBars(straight(), r.outStartS, r.bars)).toBeLessThanOrEqual(199.3);
  });
  test("first entry cue, snapped to the incoming grid", () => {
    const r = resolveAnchors(lane(), lane({ cues: [cue("entry", 30), cue("entry", 8.1), cue("exit", 2)] }), params());
    expect(r.inStartS).toBe(8);
    expect(r.reasons).toContain("entry_cue");
  });
  test("no entry cue → the first downbeat at or after 0", () => {
    const r = resolveAnchors(lane(), lane({ grid: straight(120, 1.3) }), params());
    expect(r.inStartS).toBeCloseTo(1.3, 9);
    expect(r.reasons).not.toContain("entry_cue");
  });
  test("grid_estimated when either grid is an estimate", () => {
    expect(resolveAnchors(lane(), lane({ grid: straight(120, 0, true) }), params()).reasons).toContain("grid_estimated");
    expect(resolveAnchors(lane(), lane(), params()).reasons).not.toContain("grid_estimated");
  });
  test("the user's saved anchors are kept as they are", () => {
    const r = resolveAnchors(lane({ cues: [cue("exit", 170)] }), lane({ cues: [cue("entry", 8)] }), params({ out_anchor_s: 150, in_anchor_s: 12.25 }));
    expect(r.outStartS).toBe(150);
    expect(r.inStartS).toBe(12.25);
    expect(r.reasons).not.toContain("exit_cue");
  });
});

describe("planTransition: bounds in source time", () => {
  test("a fast outgoing deck: the window is 8 source bars, the audio window is shorter", () => {
    const p = planTransition(lane({ duration: 100, rate: 1.16 }), lane(), params({ tempo_match: false }));
    expect(p.kind).toBe("mix");
    expect(p.bars).toBe(8);
    expect(p.outEndS - p.outStartS).toBeCloseTo(16, 9);
    expect(p.outEndS).toBeLessThanOrEqual(100);
    expect(p.windowAudioS).toBeCloseTo(16 / 1.16, 9);
    expect(p.inEndS).toBeCloseTo(p.inStartS + p.windowAudioS, 9);
  });
  test("an exit cue too close to the end halves the bars instead of running past the end", () => {
    const p = planTransition(lane({ duration: 100, cues: [cue("exit", 90)] }), lane(), params());
    expect(p.outStartS).toBe(90);
    expect(p.bars).toBe(4);
    expect(p.outEndS).toBeLessThanOrEqual(100);
  });
  test("the incoming bound halves 8 → 4, and a track too short for 1 bar is a cut", () => {
    const four = planTransition(lane(), lane({ duration: 10 }), params());
    expect(four.kind).toBe("mix");
    expect(four.bars).toBe(4);
    expect(four.inEndS).toBeLessThanOrEqual(10);
    const none = planTransition(lane(), lane({ duration: 1 }), params());
    expect(none.kind).toBe("cut");
    expect(none.reasons).toContain("no_room");
  });
  test("the incoming bound uses rateIn: a faster incoming deck consumes more source", () => {
    // 140 → 147: rateIn 0.9524 < 1, so 16 s of audio consume 15.24 s of source.
    const p = planTransition(lane({ grid: straight(140) }), lane({ grid: straight(147), duration: 300 }), params());
    expect(p.rateIn!).toBeCloseTo(0.9524, 4);
    expect(p.inEndS - p.inStartS).toBeCloseTo(p.windowAudioS * p.rateIn!, 9);
  });
  test("tempo match off near the incoming end never consumes past it", () => {
    const p = planTransition(lane(), lane({ duration: 100 }), params({ tempo_match: false, in_anchor_s: 99 }));
    // 16 → 115, 8 → 107, 4 → 103, 2 → 101: nothing fits.
    expect(p.kind).toBe("cut");
    expect(p.reasons).toContain("no_room");
  });
  test("an irregular list grid counts bars with timeAfterBars", () => {
    const times = Array.from({ length: 400 }, (_, i) => i * 0.5 + (i % 3 === 0 ? 0.02 : 0) + (i > 200 ? (i - 200) * 0.004 : 0));
    const grid: BeatGrid = { kind: "list", times, downIndex: 2, estimated: false, overridden: false };
    const p = planTransition(lane({ grid, duration: 260 }), lane(), params({ tempo_match: false }));
    expect(p.kind).toBe("mix");
    expect(p.outEndS).toBeCloseTo(timeAfterBars(grid, p.outStartS, p.bars), 9);
    expect(p.outEndS).toBeLessThanOrEqual(260);
  });
});

describe("planTransition: cut plans", () => {
  test("missing grid → cut at the end, entry cue or 0", () => {
    const withEntry = planTransition(lane({ grid: null }), lane({ cues: [cue("entry", 7.3)] }), params());
    expect(withEntry).toMatchObject({ kind: "cut", outStartS: 200, outEndS: 200, inStartS: 7.3, windowAudioS: 0, rateIn: null, curves: null, loop: null });
    expect(withEntry.reasons).toContain("no_grid");
    expect(planTransition(lane(), lane({ grid: null }), params()).inStartS).toBe(0);
  });
  test("preset none is a cut", () => {
    const p = planTransition(lane(), lane(), params({ preset: "none", bars: 0 }));
    expect(p.kind).toBe("cut");
    expect(p.outStartS).toBe(p.outEndS);
    expect(p.windowAudioS).toBe(0);
  });
  test("an element deck on either side is a cut", () => {
    expect(planTransition(lane({ onEngine: false }), lane(), params()).kind).toBe("cut");
    expect(planTransition(lane(), lane({ onEngine: false }), params()).kind).toBe("cut");
  });
});

describe("planTransition: mix details", () => {
  test("loop region at the window start, loop_beats long", () => {
    const p = planTransition(lane(), lane(), params({ loop_beats: 4 }));
    expect(p.loop).toEqual({ start: p.outStartS, end: p.outStartS + 2 });
    expect(planTransition(lane(), lane(), params()).loop).toBeNull();
  });
  test("curves: n = max(64, round(windowAudioS·30))", () => {
    expect(planTransition(lane(), lane(), params()).curves!.n).toBe(480);
    const one = planTransition(lane(), lane(), params({ bars: 1 }));
    expect(one.curves!.n).toBe(64);
    expect(one.curves!.out.volume).toBeInstanceOf(Float32Array);
    expect(one.rampBackBars).toBe(8);
  });
  test("rateIn comes from the grid periods at the anchors, times the outgoing rate", () => {
    const p = planTransition(lane({ grid: straight(140), rate: 1.02 }), lane({ grid: straight(147), duration: 300 }), params());
    expect(p.rateIn!).toBeCloseTo((140 * 1.02) / 147, 9);
    expect(planTransition(lane({ grid: straight(140) }), lane({ grid: straight(147) }), params({ tempo_match: false })).rateIn).toBeNull();
  });
  test("near-octave pairs: 80 → 160 matches at 1.0; 98 → 160 (backend: slam, 1 bar, tempo off) has no rateIn", () => {
    expect(planTransition(lane({ grid: straight(80) }), lane({ grid: straight(160) }), params()).rateIn).toBe(1);
    const slam = planTransition(lane({ grid: straight(98) }), lane({ grid: straight(160) }), params({ preset: "slam", bars: 1, volume_curve: "center_cut", eq_curve: "bass_cut_quick", tempo_match: false }));
    expect(slam).toMatchObject({ kind: "mix", bars: 1, rateIn: null });
  });
  test("tempo match on but out of range → no rateIn, bpm_out_of_range", () => {
    const p = planTransition(lane({ grid: straight(98) }), lane({ grid: straight(160) }), params());
    expect(p.rateIn).toBeNull();
    expect(p.reasons).toContain("bpm_out_of_range");
  });
});
