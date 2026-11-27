// Gap tests for the transition planner: bar clamping and halving, anchor boundaries, odd and huge inputs, half/double
// tempo, input order and the editor (resolveAnchors) agreeing with the plan the runner plays (planTransition).
import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { planTransition, resolveAnchors, tempoMatchRate, type LaneInput } from "../src/lib/transitions/planner";
import { phraseBars, structureOutStart, swapBar } from "../src/lib/transitions/structurePlacement";
import type { TransitionParams } from "../src/lib/transitions/types";
import type { TrackCue } from "../src/lib/types";

/** Straight grid, 4 beats a bar; 120 BPM → 2 s bars. */
const straight = (bpm = 120, anchor = 0, phrases?: number[]): BeatGrid =>
  ({ kind: "straight", anchor, period: 60 / bpm, estimated: false, overridden: false, ...(phrases && { phrases }) });
const cue = (kind: TrackCue["kind"], s: number, id = Math.round(s * 1000) + 1): TrackCue =>
  ({ id, track_id: 1, kind, position_ms: s * 1000, label: null, created_at: "", updated_at: "" });
const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: straight(), duration: 200, cues: [], rate: 1, onEngine: true, ...o });
const params = (o: Partial<TransitionParams> = {}): TransitionParams => ({
  preset: "blend", bars: 8, volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none", loop_beats: null,
  out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o,
});
const sections = (...parts: [number, boolean][]) => ({ sections: parts.map(([start_s, bass]) => ({ start_s, beats: 64, bass, level: bass ? 1 : 0 })) });
const every16 = (to: number) => Array.from({ length: Math.floor(to / 16) + 1 }, (_, i) => i * 16);

describe("bars: rounded, clamped to 1..32, then halved (floor) until both tracks hold the window", () => {
  // Incoming starts at 0:00 at rate 1, so it holds `inDuration / 2` bars of a 120 BPM window.
  test.each([
    [100, 300, 32],
    [33, 300, 32],
    [7.6, 300, 8],
    [0.4, 300, 1],
    [0, 300, 1],
    [-5, 300, 1],
    [32, 40, 16],
    [24, 13, 6], // 24 → 12 → 6: halving is not powers of two only
    [5, 3, 1], // 5 → 2 → 1
    [3, 5, 1], // 3 → 1 (floor), never 1.5
  ])("bars %p with a %p s incoming track plays %p bars", (bars, inDuration, expected) => {
    const r = resolveAnchors(lane(), lane({ duration: inDuration }), params({ bars }));
    expect(r.bars).toBe(expected);
    expect(r.reasons).not.toContain("no_room");
    const p = planTransition(lane(), lane({ duration: inDuration }), params({ bars }));
    expect(p.kind).toBe("mix");
    expect(p.bars).toBe(expected);
    expect(p.inEndS).toBeLessThanOrEqual(inDuration + 1e-6);
  });
});

describe("saved anchors at and past the track edges", () => {
  test("a negative saved out anchor starts the window at 0:00", () => {
    const p = planTransition(lane(), lane(), params({ out_anchor_s: -5 }));
    expect(p).toMatchObject({ kind: "mix", outStartS: 0, outEndS: 16, bars: 8 });
  });
  test("a saved out anchor at or past the end has no room: a cut at the end, bars 0", () => {
    for (const out_anchor_s of [200, 250]) {
      const r = resolveAnchors(lane(), lane(), params({ out_anchor_s }));
      expect(r).toMatchObject({ outStartS: 200, bars: 0 });
      expect(r.reasons).toContain("no_room");
      expect(planTransition(lane(), lane(), params({ out_anchor_s }))).toMatchObject({ kind: "cut", outStartS: 200, outEndS: 200, bars: 0, curves: null });
    }
  });
  test("a saved in anchor past the incoming end is clamped to the end, then no room: a cut there", () => {
    const p = planTransition(lane(), lane({ duration: 120 }), params({ in_anchor_s: 500 }));
    expect(p).toMatchObject({ kind: "cut", inStartS: 120, inEndS: 120 });
    expect(p.reasons).toContain("no_room");
  });
  test("a negative saved in anchor starts the incoming deck at 0:00", () => {
    expect(planTransition(lane(), lane(), params({ in_anchor_s: -3 }))).toMatchObject({ kind: "mix", inStartS: 0 });
  });
});

describe("cues at the boundaries", () => {
  test("an exit cue exactly at the midpoint is ignored; one past it is used", () => {
    expect(resolveAnchors(lane({ cues: [cue("exit", 100)] }), lane(), params()).reasons).not.toContain("exit_cue");
    const r = resolveAnchors(lane({ cues: [cue("exit", 150)] }), lane(), params());
    expect(r.outStartS).toBe(150);
    expect(r.reasons).toContain("exit_cue");
  });
  test("cues with a non-finite position count as missing", () => {
    const bad = [cue("exit", Number.NaN, 1), cue("entry", Number.NaN, 2), cue("exit", Number.POSITIVE_INFINITY, 3)];
    const r = resolveAnchors(lane({ cues: bad }), lane({ cues: bad }), params());
    expect(r).toEqual(resolveAnchors(lane(), lane(), params()));
    expect(r.reasons).not.toContain("exit_cue");
    expect(r.reasons).not.toContain("entry_cue");
  });
  test("an entry cue before the first downbeat starts on that downbeat, never before 0:00", () => {
    // Bar 1 at 1.5 s: 0.2 s rounds to the bar line at −0.5 s, which is before the track starts.
    const r = resolveAnchors(lane(), lane({ grid: straight(120, 1.5), cues: [cue("entry", 0.2)] }), params());
    expect(r.inStartS).toBe(1.5);
    expect(r.reasons).toContain("entry_cue");
  });
  test("no entry cue and a grid that starts before 0:00: the first downbeat at or after 0:00", () => {
    expect(resolveAnchors(lane(), lane({ grid: straight(120, -0.3) }), params()).inStartS).toBeCloseTo(1.7, 9);
  });
  test("the order cues and phrase lines arrive in does not change the plan", () => {
    const cues = [cue("exit", 150.2), cue("exit", 170.1), cue("entry", 30), cue("entry", 8.1)];
    const a = planTransition(lane({ cues }), lane({ cues }), params());
    const b = planTransition(lane({ cues: [...cues].reverse() }), lane({ cues: [...cues].reverse() }), params());
    expect(b).toEqual(a);
    expect(a).toMatchObject({ outStartS: 170, inStartS: 8 });
    const lines = every16(200);
    const outSorted = lane({ grid: straight(120, 0, lines), structure: sections([0, false], [32, true], [160, false]) });
    const outShuffled = lane({ grid: straight(120, 0, [...lines].reverse()), structure: sections([0, false], [32, true], [160, false]) });
    expect(planTransition(outShuffled, lane(), params())).toEqual(planTransition(outSorted, lane(), params()));
    expect(phraseBars(straight(120, 0, [32, 0.4, 16, 31.9]))).toEqual([0, 16, 32]);
  });
});

describe("odd and huge inputs", () => {
  test.each([
    ["an empty outgoing track", { duration: 0 }],
    ["an outgoing deck with rate 0", { rate: 0 }],
    ["an outgoing deck with a negative rate", { rate: -1 }],
    ["an outgoing deck with rate NaN", { rate: Number.NaN }],
  ])("%s: a cut with no_room, no throw", (_name, o) => {
    const p = planTransition(lane(o), lane(), params());
    expect(p.kind).toBe("cut");
    expect(p.bars).toBe(0);
    expect(p.reasons).toContain("no_room");
  });
  test("a three-hour outgoing track: the default window ends a bar before the end", () => {
    const p = planTransition(lane({ duration: 10_800 }), lane(), params({ bars: 32 }));
    expect(p).toMatchObject({ kind: "mix", bars: 32, outStartS: 10_734, outEndS: 10_798 });
    expect(p.curves!.n).toBe(Math.round(64 * 30));
  });
  test("a loop longer than the window is cut at the window's end", () => {
    const p = planTransition(lane(), lane({ duration: 3 }), params({ loop_beats: 16 }));
    expect(p.bars).toBe(1);
    expect(p.loop).toEqual({ start: p.outStartS, end: p.outEndS });
  });
  test("planning is pure: same input, same plan, and the inputs are not touched", () => {
    const cues = [cue("exit", 170.1), cue("exit", 150.2)];
    const out = lane({ cues, grid: straight(120, 0, [160, 0, 144]), structure: sections([0, false], [32, true], [160, false]) });
    const inn = lane({ cues: [cue("entry", 9)] });
    const p = params();
    const snapshot = JSON.stringify([out, inn, p]);
    const first = planTransition(out, inn, p);
    expect(planTransition(out, inn, p)).toEqual(first);
    expect(JSON.stringify([out, inn, p])).toBe(snapshot);
  });
});

describe("half and double tempo", () => {
  test.each([
    [70, 140, 1],
    [140, 70, 1],
    [174, 87, 1],
    [35, 140, 1], // two octaves
    [128, 66, 128 / 132],
  ])("out %p BPM, in %p BPM: rate %p", (outBpm, inBpm, rate) => {
    expect(tempoMatchRate(outBpm, 1, inBpm)!).toBeCloseTo(rate, 9);
  });
  test.each([
    [120, 160],
    [160, 120],
    [90, 120],
  ])("a 3:4 jump %p → %p is never folded: no rate", (outBpm, inBpm) => {
    expect(tempoMatchRate(outBpm, 1, inBpm)).toBeNull();
  });
  test("a 70 → 140 BPM plan runs the incoming deck at rate 1 and reads 8 outgoing bars of its source", () => {
    const p = planTransition(lane({ grid: straight(70) , duration: 400 }), lane({ grid: straight(140) }), params());
    expect(p.kind).toBe("mix");
    expect(p.rateIn).toBeCloseTo(1, 9);
    expect(p.windowAudioS).toBeCloseTo(8 * 4 * (60 / 70), 9);
    expect(p.inEndS - p.inStartS).toBeCloseTo(p.windowAudioS, 9);
    expect(p.reasons).not.toContain("bpm_out_of_range");
  });
  test("a 3:4 pair with tempo match on mixes at the incoming deck's own speed and says why", () => {
    const p = planTransition(lane({ grid: straight(120) }), lane({ grid: straight(160) }), params());
    expect(p.kind).toBe("mix");
    expect(p.rateIn).toBeNull();
    expect(p.reasons).toContain("bpm_out_of_range");
    expect(p.inEndS - p.inStartS).toBeCloseTo(p.windowAudioS, 9);
  });
});

describe("the editor and the runner see the same window", () => {
  const structured = (o: Partial<LaneInput> = {}) =>
    lane({ grid: straight(120, 0, every16(200)), structure: sections([0, false], [32, true], [160, false]), ...o });
  test.each([
    ["default", lane(), lane(), params()],
    ["exit and entry cues", lane({ cues: [cue("exit", 170.1)] }), lane({ cues: [cue("entry", 8.1)] }), params()],
    ["halved by the incoming end", lane(), lane({ duration: 9 }), params({ bars: 16 })],
    ["from the structure", structured(), structured(), params()],
    ["saved anchors", lane(), lane(), params({ out_anchor_s: 120, in_anchor_s: 4 })],
    ["a faster outgoing deck", lane({ rate: 1.08 }), lane(), params()],
  ])("%s", (_name, out, inn, p) => {
    const r = resolveAnchors(out, inn, p);
    const plan = planTransition(out, inn, p);
    expect(plan.kind).toBe("mix");
    expect({ outStartS: plan.outStartS, inStartS: plan.inStartS, bars: plan.bars, reasons: plan.reasons }).toEqual(r);
  });
  test("the structure's swap bar for odd bar counts is the floor of the half", () => {
    expect([1, 3, 5, 7, 32].map(b => swapBar("bass_swap_center", "none", b))).toEqual([0, 1, 2, 3, 16]);
    // The outgoing start then puts that swap on the phrase line at 160 s.
    const grid = straight(120, 0, every16(200));
    expect(structureOutStart(grid, 200, sections([0, true], [160, false]), 5, 2)).toBe(156);
  });
});
