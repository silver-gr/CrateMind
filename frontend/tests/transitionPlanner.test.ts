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

describe("planTransition: timed from the structure", () => {
  /** Sections from [start_s, bass] pairs. */
  const sections = (...parts: [number, boolean][]) => ({ sections: parts.map(([start_s, bass]) => ({ start_s, beats: 64, bass, level: bass ? 1 : 0 })) });
  /** A straight grid with a phrase line every 8 bars from its anchor up to `to`. */
  const phrased = (bpm = 120, to = 200): BeatGrid => ({ ...straight(bpm), phrases: Array.from({ length: Math.floor(to / (1920 / bpm)) + 1 }, (_, i) => i * (1920 / bpm)) });
  /** Outgoing: bass stops at 160 s of 200. Incoming: 16 bars of intro, first bass at 32 s. */
  const outS = (o: Partial<LaneInput> = {}) => lane({ grid: phrased(), structure: sections([0, false], [32, true], [160, false]), ...o });
  const inS = (o: Partial<LaneInput> = {}) => lane({ grid: phrased(), structure: sections([0, false], [32, true], [160, false]), ...o });
  const curves = (eq_curve: TransitionParams["eq_curve"], filter_curve: TransitionParams["filter_curve"] = "none", o: Partial<TransitionParams> = {}) =>
    params({ preset: "custom", eq_curve, filter_curve, ...o });
  /** Seconds of window audio until the incoming deck reaches `bassInS`. */
  const bassAt = (p: { inStartS: number; rateIn: number | null }, bassInS: number) => (bassInS - p.inStartS) / (p.rateIn ?? 1);

  test("both sides: the swap on the phrase line where the bass stops, the first bass on the swap", () => {
    const p = planTransition(outS(), inS(), params());
    expect(p).toMatchObject({ kind: "mix", bars: 8, outStartS: 152, outEndS: 168, inStartS: 24, rateIn: 1 });
    expect(p.reasons).toEqual(["structure_out", "structure_in"]);
  });
  test("no structure on a side (or still loading): that side keeps today's rule", () => {
    const today = planTransition(lane(), lane(), params());
    expect(planTransition(outS({ structure: null }), inS({ structure: null }), params())).toEqual(today);
    expect(planTransition(outS(), inS({ structure: undefined }), params())).toMatchObject({ outStartS: 152, inStartS: 0, reasons: ["structure_out"] });
    expect(planTransition(outS({ structure: null }), inS(), params())).toMatchObject({ outStartS: 182, inStartS: 24, reasons: ["structure_in"] });
  });
  test("a grid without phrase lines (estimated, djay) gives today's plan", () => {
    const bare = { grid: straight() };
    expect(planTransition(outS(bare), inS(bare), params())).toEqual(planTransition(lane(), lane(), params()));
    const est = { grid: straight(120, 0, true) };
    expect(planTransition(outS(est), inS(est), params())).toEqual(planTransition(lane(est), lane(est), params()));
  });
  test("incoming bass from the first beat, past the half or closer than the lead-in: today's start", () => {
    for (const structure of [sections([0, true], [160, false]), sections([0, false], [102, true]), sections([0, false], [6, true])]) {
      const p = planTransition(outS(), inS({ structure }), params());
      expect(p.inStartS).toBe(0);
      expect(p.reasons).toEqual(["structure_out"]);
    }
  });
  test("an intro longer than the lead-in starts k bars before its bass", () => {
    const p = planTransition(outS(), inS({ structure: sections([0, false], [64, true]) }), curves("bass_swap_end"));
    expect(p.inStartS).toBe(48);
  });
  test("outgoing bass that never stops, or stops too close to the end: the latest phrase line that qualifies", () => {
    // Swap on the line at 192 (the window ends with the track); one second shorter and it is the line at 176.
    expect(planTransition(outS({ structure: sections([0, false], [32, true]) }), inS(), params()).outStartS).toBe(184);
    expect(planTransition(outS({ duration: 199, structure: sections([0, false], [32, true]) }), inS(), params()).outStartS).toBe(168);
    expect(planTransition(outS({ duration: 199, structure: sections([0, false], [32, true], [192, false]) }), inS(), params()).outStartS).toBe(168);
  });
  test("no qualifying line (none in the second half): today's default", () => {
    const p = planTransition(outS({ structure: sections([0, false], [32, true], [96, false]) }), inS(), params());
    expect(p.outStartS).toBe(182);
    expect(p.reasons).toEqual(["structure_in"]);
  });
  test("a window start behind the playhead: today's default", () => {
    expect(planTransition(outS({ notBeforeS: 152 }), inS(), params()).outStartS).toBe(152);
    const p = planTransition(outS({ notBeforeS: 153 }), inS(), params());
    expect(p.outStartS).toBe(182);
    expect(p.reasons).toEqual(["structure_in"]);
  });
  test("incoming too short from the structure start: today's in-start at the same bars", () => {
    // Swap at the start: the window would run 14 → 30 of a 28 s track; from 0 it fits.
    const p = planTransition(outS(), inS({ duration: 28, structure: sections([0, false], [14, true]) }), curves("bass_swap_start"));
    expect(p).toMatchObject({ bars: 8, outStartS: 160, inStartS: 0 });
    expect(p.reasons).toEqual(["structure_out"]);
  });
  test("halving recomputes the swap bar and both starts", () => {
    // 8 bars: the lead (4 bars) is longer than the intro and 16 s do not fit in 14. 4 bars: swap 2 bars in.
    const p = planTransition(outS(), inS({ duration: 14, structure: sections([0, false], [6, true]) }), params());
    expect(p).toMatchObject({ bars: 4, outStartS: 156, inStartS: 2 });
    expect(p.reasons).toEqual(["structure_out", "structure_in"]);
  });
  test("no_room and every cut keep today's in-start", () => {
    const short = inS({ duration: 1.5, grid: { ...phrased(), anchor: 0.25 }, structure: sections([0, false], [0.25, true]) });
    const none = planTransition(outS(), short, params());
    expect(none).toEqual(planTransition(lane(), lane({ duration: 1.5, grid: straight(120, 0.25) }), params()));
    expect(none.reasons).toEqual(["no_room"]);
    for (const p of [params({ preset: "none", bars: 0 }), params()]) {
      const o = p.preset === "none" ? {} : { onEngine: false };
      expect(planTransition(outS(o), inS(), p)).toEqual(planTransition(lane(o), lane(), p));
    }
    expect(planTransition(outS({ grid: null }), inS(), params())).toEqual(planTransition(lane({ grid: null }), lane(), params()));
  });
  test("per preset family the incoming bass lands on the swap bar", () => {
    const cases: [TransitionParams, number][] = [
      [curves("bass_swap_center", "lpf_in_lpf_out"), 4], [curves("bass_swap_center"), 4], [curves("three_band"), 4],   // «Κύμα», «Απόηχος», «Ανάμειξη»
      [curves("bass_swap_end", "lpf_in_hpf_out"), 8], [curves("bass_swap_end", "hpf_half_out"), 8],                    // «Άνοδος», «Διάλυση»
      [curves("bass_swap_start", "hpf_in", { bars: 4 }), 4], [curves("bass_swap_center", "hpf_in_hpf_out"), 8],         // «Έκρηξη», «Λιώσιμο»: the window end
      [curves("none", "none", { bars: 4 }), 4], [curves("bass_cut_quick", "none", { bars: 1 }), 1],                    // «Ξεθώριασμα», «Κόψιμο»
      [curves("bass_swap_start"), 0], [curves("fade_out_start"), 0],
    ];
    for (const [p, k] of cases) {
      const plan = planTransition(outS(), inS(), p);
      expect(plan.outStartS).toBe(160 - 2 * k);
      expect(bassAt(plan, 32)).toBeCloseTo((k / plan.bars) * plan.windowAudioS, 9);
      expect(plan.reasons).toEqual(["structure_out", "structure_in"]);
    }
  });
  test("a saved anchor or a cue beats the structure, each side on its own", () => {
    const saved = planTransition(outS(), inS(), params({ out_anchor_s: 150, in_anchor_s: 12.25 }));
    expect(saved).toEqual(planTransition(lane(), lane(), params({ out_anchor_s: 150, in_anchor_s: 12.25 })));
    expect(planTransition(outS(), inS(), params({ out_anchor_s: 150 }))).toMatchObject({ outStartS: 150, inStartS: 24, reasons: ["structure_in"] });
    expect(planTransition(outS(), inS(), params({ in_anchor_s: 12.25 }))).toMatchObject({ outStartS: 152, inStartS: 12.25, reasons: ["structure_out"] });
    const cued = planTransition(outS({ cues: [cue("exit", 170)] }), inS({ cues: [cue("entry", 8)] }), params());
    expect(cued).toMatchObject({ outStartS: 170, inStartS: 8, reasons: ["entry_cue", "exit_cue"] });
  });
  test("tempo match on: the lead is exactly k incoming bars", () => {
    const inn = inS({ grid: phrased(126), structure: sections([0, false], [(16 * 240) / 126, true]) });
    const p = planTransition(outS(), inn, params());
    expect(p.inStartS).toBeCloseTo((12 * 240) / 126, 9);
    expect(bassAt(p, (16 * 240) / 126)).toBeCloseTo(8, 9);
  });
  test("tempo match off or out of range: the bass lands within half an incoming bar of the swap", () => {
    for (const [bpm, o] of [[126, { tempo_match: false }], [160, {}]] as [number, Partial<TransitionParams>][]) {
      const bass = (16 * 240) / bpm;
      const p = planTransition(outS(), inS({ grid: phrased(bpm), structure: sections([0, false], [bass, true]) }), params(o));
      expect(p.rateIn).toBeNull();
      expect(p.reasons).toContain("structure_in");
      expect(Math.abs(bassAt(p, bass) - 8)).toBeLessThanOrEqual(120 / bpm + 1e-9);
    }
  });
  test("a folded 75 → 150 pair", () => {
    const out = lane({ duration: 300, grid: phrased(75, 300), structure: sections([0, false], [51.2, true], [256, false]) });
    const p = planTransition(out, inS({ grid: phrased(150), structure: sections([0, false], [51.2, true]) }), params());
    expect(p.outStartS).toBeCloseTo(243.2, 9);
    expect(p.windowAudioS).toBeCloseTo(25.6, 9);
    expect(p.inStartS).toBeCloseTo(38.4, 9);
    expect(p.rateIn).toBe(1);
  });
  test("list grids, and the round trip: a structure plan's two starts as saved anchors give the same window and rate", () => {
    const times = Array.from({ length: 520 }, (_, i) => i * 0.5 + (i % 3 === 0 ? 0.02 : 0) + (i > 200 ? (i - 200) * 0.004 : 0));
    const grid: BeatGrid = { kind: "list", times, downIndex: 2, estimated: false, overridden: false, phrases: Array.from({ length: 16 }, (_, j) => times[2 + 32 * j]) };
    const out = lane({ grid, duration: 262, rate: 1.03, structure: sections([0, false], [times[66], true], [times[450] + 0.3, false]) });
    const inn = lane({ grid, duration: 262, structure: sections([0, false], [times[162] - 0.2, true]) });
    for (const p of [params(), curves("bass_swap_end"), curves("bass_swap_start")]) {
      const plan = planTransition(out, inn, p);
      const k = p.eq_curve === "three_band" ? 4 : p.eq_curve === "bass_swap_end" ? 8 : 0;
      expect(plan.reasons).toEqual(["structure_out", "structure_in"]);
      expect(plan.outStartS).toBeCloseTo(times[450 - 4 * k], 9);
      expect(plan.inStartS).toBeCloseTo(times[162 - 4 * k], 9);
      const again = planTransition(out, inn, { ...p, out_anchor_s: plan.outStartS, in_anchor_s: plan.inStartS });
      expect({ ...again, reasons: plan.reasons }).toEqual(plan);
      expect(resolveAnchors(out, inn, p)).toEqual({ outStartS: plan.outStartS, inStartS: plan.inStartS, bars: 8, reasons: plan.reasons });
    }
  });
});
