// Golden: the planner's whole output over a fixed matrix, so a change that should not move a plan is proven not to.
// Update only on purpose: `bun test --update-snapshots tests/transitionPlannerGolden.test.ts`.
import { expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import type { Lane } from "../src/lib/transitions/curves";
import { planTransition, resolveAnchors, type LaneInput, type TransitionPlan } from "../src/lib/transitions/planner";
import { PRESETS } from "../src/lib/transitions/presets";
import type { NamedPreset, TransitionParams } from "../src/lib/transitions/types";
import type { TrackCue } from "../src/lib/types";

const straight = (bpm = 120, anchor = 0, estimated = false): BeatGrid => ({ kind: "straight", anchor, period: 60 / bpm, estimated, overridden: false });
/** An uneven list grid: every third beat late, and a slower second half. */
const list = (): BeatGrid => ({
  kind: "list", downIndex: 2, estimated: false, overridden: false,
  times: Array.from({ length: 520 }, (_, i) => i * 0.5 + (i % 3 === 0 ? 0.02 : 0) + (i > 200 ? (i - 200) * 0.004 : 0)),
});
const cue = (kind: TrackCue["kind"], s: number) => ({ id: Math.round(s * 1000), track_id: 1, kind, position_ms: s * 1000, label: null, created_at: "", updated_at: "" }) as TrackCue;
const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: straight(), duration: 240, cues: [], rate: 1, onEngine: true, ...o });
const params = (preset: NamedPreset, o: Partial<TransitionParams> = {}): TransitionParams => ({
  ...PRESETS[preset], preset, out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o,
});

export interface GoldenCase { name: string; out: LaneInput; inn: LaneInput; params: TransitionParams; saved?: boolean }

const NAMED = Object.keys(PRESETS) as NamedPreset[];
export const GOLDEN_CASES: GoldenCase[] = [
  ...NAMED.flatMap((preset): GoldenCase[] => [
    { name: `${preset} · straight`, out: lane(), inn: lane({ grid: straight(124, 0.31) }), params: params(preset) },
    { name: `${preset} · list`, out: lane({ grid: list(), duration: 300 }), inn: lane({ grid: list(), duration: 300 }), params: params(preset) },
    { name: `${preset} · saved anchors`, out: lane(), inn: lane({ grid: list(), duration: 300 }), params: params(preset, { out_anchor_s: 150, in_anchor_s: 12.25 }), saved: true },
  ]),
  { name: "estimated grid", out: lane(), inn: lane({ grid: straight(120, 0.4, true) }), params: params("wave") },
  { name: "outgoing rate 1.04", out: lane({ rate: 1.04 }), inn: lane({ grid: straight(126) }), params: params("rise") },
  { name: "entry and exit cues", out: lane({ cues: [cue("exit", 60), cue("exit", 200.3)] }), inn: lane({ cues: [cue("entry", 30), cue("entry", 8.1)] }), params: params("afterglow") },
  { name: "exit cue near the end", out: lane({ cues: [cue("exit", 232)] }), inn: lane(), params: params("blend") },
  { name: "short incoming", out: lane(), inn: lane({ duration: 10 }), params: params("blend") },
  { name: "incoming too short for a bar", out: lane(), inn: lane({ duration: 1 }), params: params("blend") },
  { name: "tempo off", out: lane({ grid: straight(140) }), inn: lane({ grid: straight(147) }), params: params("melt", { tempo_match: false }) },
  { name: "out of range", out: lane({ grid: straight(98) }), inn: lane({ grid: straight(160) }), params: params("dissolve") },
  { name: "folded 75 → 150", out: lane({ grid: straight(75) }), inn: lane({ grid: straight(150) }), params: params("wave") },
  { name: "saved out anchor only", out: lane(), inn: lane(), params: params("rise", { out_anchor_s: 180 }) },
  { name: "saved in anchor only", out: lane(), inn: lane(), params: params("rise", { in_anchor_s: 16 }) },
  { name: "loop", out: lane({ grid: list(), duration: 300 }), inn: lane(), params: params("surge", { bars: 16, loop_beats: 8 }) },
  { name: "no grid", out: lane({ grid: null }), inn: lane({ cues: [cue("entry", 7.3)] }), params: params("blend") },
  { name: "element deck", out: lane(), inn: lane({ onEngine: false }), params: params("blend") },
];

const laneSums = (l: Lane) => Object.fromEntries(Object.entries(l).map(([k, a]) => [k, { n: a.length, sum: a.reduce((s: number, x: number) => s + x, 0) }]));
/** The plan with each curve array as its length and sum (an 8-bar plan holds about 4,000 samples). */
export const summarise = (p: TransitionPlan) => ({ ...p, curves: p.curves && { n: p.curves.n, out: laneSums(p.curves.out), in: laneSums(p.curves.in) } });

test("planTransition and resolveAnchors over the fixed matrix", () => {
  for (const c of GOLDEN_CASES) {
    expect({ plan: summarise(planTransition(c.out, c.inn, c.params)), anchors: resolveAnchors(c.out, c.inn, c.params) }).toMatchSnapshot(c.name);
  }
});

test("saved anchors: structures on both lanes change nothing", () => {
  const withStructure = (l: LaneInput): LaneInput => ({
    ...l, grid: l.grid && { ...l.grid, phrases: Array.from({ length: 12 }, (_, i) => 8 + i * 16) },
    structure: { sections: [[0, false], [32, true], [176, false]].map(([start_s, bass]) => ({ start_s: start_s as number, beats: 64, bass: bass as boolean, level: 1 })) },
  });
  const saved = GOLDEN_CASES.filter(c => c.saved);
  expect(saved.length).toBe(NAMED.length);
  for (const c of saved) {
    expect(planTransition(withStructure(c.out), withStructure(c.inn), c.params)).toEqual(planTransition(c.out, c.inn, c.params));
    expect(resolveAnchors(withStructure(c.out), withStructure(c.inn), c.params)).toEqual(resolveAnchors(c.out, c.inn, c.params));
  }
  // The same structures do move an unsaved pair, so the equality above is not vacuous.
  const free = GOLDEN_CASES[0];
  expect(resolveAnchors(withStructure(free.out), withStructure(free.inn), free.params)).not.toEqual(resolveAnchors(free.out, free.inn, free.params));
});
