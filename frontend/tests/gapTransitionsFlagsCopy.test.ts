// Gap tests for the transition checker, its Greek copy and the preset table: key notations, which key source is
// trusted, incoming rate and sections that start late, chip rounding, and presets applied twice or planned as given.
import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import type { KeySources } from "../src/lib/camelot";
import { describeAuto, flagChips, presetLabel, reasonLabel, skippedUnplayable, stretchChip } from "../src/lib/transitions/copy";
import { bassClashBars, keyClashBars, transitionFlags, type FlagLane, type FlagParams, type FlagWindow } from "../src/lib/transitions/flags";
import { planTransition, tempoDeviation, type LaneInput } from "../src/lib/transitions/planner";
import { applyPreset, HAND_PRESETS, PRESETS, presetFor } from "../src/lib/transitions/presets";
import { PRESET_KEYS, type NamedPreset, type TransitionParams } from "../src/lib/transitions/types";
import type { TrackCue } from "../src/lib/types";

/** 120 BPM: 2 s bars, 16 s phrases. */
const grid = (phrases?: number[]): BeatGrid => ({ kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false, phrases });
const every16 = (to: number) => Array.from({ length: Math.floor(to / 16) + 1 }, (_, i) => i * 16);
const structure = (parts: [number, boolean][], quality = 0.9) => ({
  quality, sections: parts.map(([start_s, bass]) => ({ start_s, beats: 64, bass, level: bass ? 1 : 0 })),
});
const OUT: FlagLane = { grid: grid(every16(300)), structure: structure([[0, true], [200, false]]) };
const IN: FlagLane = { grid: grid(every16(300)), structure: structure([[0, false], [32, true]]) };
const flagParams = (patch: Partial<FlagParams> = {}): FlagParams =>
  ({ preset: "custom", bars: 16, volume_curve: "overlap", eq_curve: "none", filter_curve: "none", loop_beats: null, ...patch });
const win = (patch: Partial<FlagWindow> = {}): FlagWindow => ({ outStartS: 100, inStartS: 32, bars: 16, rateIn: null, ...patch });

describe("«Απότομη αλλαγή τονικότητας»: the key's notation never changes the answer", () => {
  const A_MINOR = ["8A", "8a", " 8A ", "Am", "A min", "A minor", "amin", "1m"];
  const D_FLAT = ["3B", "Db", "C#", "C♯", "D♭", "Db major", "C# maj", "8d"];
  test.each(A_MINOR.flatMap(a => D_FLAT.map(b => [a, b])))("%p → %p clashes for 16 bars", (a, b) => {
    expect(keyClashBars({ key_text: a }, { key_text: b }, flagParams())).toBe(16);
  });
  test.each(A_MINOR.flatMap(a => ["C", "Em", "Dm", "A min", "9a", "7A"].map(b => [a, b])))("%p → %p is compatible", (a, b) => {
    expect(keyClashBars({ key_text: a }, { key_text: b }, flagParams({ bars: 32 }))).toBeNull();
  });
});

describe("«Απότομη αλλαγή τονικότητας»: which key the check trusts", () => {
  const trained = "cqt-octave-trained-v2";
  test.each<[string, KeySources, number | null]>([
    ["a blank tag falls back to djay's key", { key_text: "   ", key_djay: "3B" }, 16],
    ["the tag beats djay's key", { key_text: "8A", key_djay: "3B" }, null],
    ["a confident own key beats djay's key", { key_djay: "8A", key_analyzed: "3B", key_analyzed_confidence: 0.9, key_analyzed_method: trained }, 16],
    ["an own key at exactly 0.7 is confident", { key_analyzed: "3B", key_analyzed_confidence: 0.7, key_analyzed_method: trained }, 16],
    ["below 0.7 djay's key wins", { key_djay: "8A", key_analyzed: "3B", key_analyzed_confidence: 0.69, key_analyzed_method: trained }, null],
    ["an uncalibrated own key alone is unsure", { key_analyzed: "3B", key_analyzed_confidence: 0.99, key_analyzed_method: "old-method" }, null],
    ["a guessed djay key is unsure", { key_djay: "~3B" }, null],
    ["nothing at all", {}, null],
  ])("%s", (_name, to, expected) => {
    expect(keyClashBars({ key_text: "8A" }, to, flagParams())).toBe(expected);
  });
});

describe("«Δύο μπάσα μαζί»: the incoming rate and sections that start late", () => {
  test.each([
    [null, null], // the incoming deck stays in its 32 s intro
    [0.5, null],
    [2, 8], // twice as fast: its bass arrives at the window's middle
  ])("incoming from 0:00 at rate %p: %p bars", (rateIn, expected) => {
    expect(bassClashBars(OUT, { ...IN }, flagParams(), win({ inStartS: 0, rateIn }))).toBe(expected);
  });
  test("an outgoing track whose first section starts late has no bass before it", () => {
    const late: FlagLane = { grid: OUT.grid, structure: structure([[110, true], [200, false]]) };
    const allBass: FlagLane = { grid: IN.grid, structure: structure([[0, true]]) };
    // Window 100–132 s: the outgoing bass from 110 s is 44 of its 64 beats.
    expect(bassClashBars(late, allBass, flagParams(), win({ inStartS: 0 }))).toBe(11);
  });
  test("a window of 0 bars flags nothing at all", () => {
    expect(transitionFlags(OUT, IN, { key_text: "8A" }, { key_text: "3B" }, flagParams(), win({ bars: 0, outStartS: 160, inStartS: 40 })))
      .toEqual({ bassBars: null, offPhrase: false, keyBars: null });
  });
});

describe("chips and labels", () => {
  test("chip titles round the bars to whole bars", () => {
    const [bass, key] = flagChips({ bassBars: 4.75, keyBars: 8.25 });
    expect(bass.title).toContain("περίπου 5 bars");
    expect(key.title).toContain("περίπου 8 bars");
    expect(flagChips({ offPhrase: false, bassBars: null, keyBars: null })).toEqual([]);
    expect(flagChips({})).toEqual([]);
  });
  test("every reason the planner gives has a Greek label", () => {
    const g = (bpm: number, estimated = false): BeatGrid => ({ kind: "straight", anchor: 0, period: 60 / bpm, estimated, overridden: false });
    const cue = (kind: TrackCue["kind"], s: number): TrackCue => ({ id: s, track_id: 1, kind, position_ms: s * 1000, label: null, created_at: "", updated_at: "" });
    const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: g(120), duration: 200, cues: [], rate: 1, onEngine: true, ...o });
    const p: TransitionParams = { ...PRESETS.blend, preset: "blend", out_anchor_s: null, in_anchor_s: null, tempo_match: true };
    const phrased = { grid: { ...g(120), phrases: every16(200) }, structure: { sections: [[0, false], [32, true], [160, false]].map(([s, b]) => ({ start_s: s as number, beats: 64, bass: b as boolean, level: 1 })) } };
    const reasons = new Set([
      ...planTransition(lane({ cues: [cue("exit", 170)] }), lane({ cues: [cue("entry", 8)], grid: g(120, true) }), p).reasons,
      ...planTransition(lane({ grid: null }), lane(), p).reasons,
      ...planTransition(lane(), lane({ duration: 1 }), p).reasons,
      ...planTransition(lane(), lane({ grid: g(160) }), p).reasons,
      ...planTransition(lane(phrased), lane(phrased), p).reasons,
    ]);
    expect([...reasons].sort()).toEqual(["bpm_out_of_range", "entry_cue", "exit_cue", "grid_estimated", "no_grid", "no_room", "structure_in", "structure_out"]);
    for (const r of reasons) expect(reasonLabel(r)).toMatch(/[α-ω]/);
    expect(describeAuto([])).toBe("");
    expect(describeAuto(["no_grid", "bogus_code", "structure_in"])).toBe("χωρίς beatgrid · είσοδος από τη δομή");
  });
  test("the preset label names the resolved preset only under Auto", () => {
    expect(presetLabel("auto", null)).toBe("Αυτόματο");
    expect(presetLabel("blend", "fade")).toBe("Ανάμειξη");
    expect(presetLabel("echo_out", null)).toBe("Έξοδος με echo");
  });
  test("the skipped-tracks toast keeps Greek, emoji and quote-mark titles as they are", () => {
    expect(skippedUnplayable(["Ψυχεδέλεια 🌀"])).toBe("Η μίξη παραλείπει το «Ψυχεδέλεια 🌀»: δεν παίζει στα decks (AIFF)");
    expect(skippedUnplayable(["Α", "Β «remix»", "Γ"])).toBe("Η μίξη παραλείπει 3 tracks που δεν παίζουν στα decks (AIFF): «Α», «Β «remix»», «Γ»");
    expect(skippedUnplayable(["Α", "Β", "Γ", "Δ"]).endsWith("«Α», «Β», «Γ» κ.ά.")).toBe(true);
  });
  test.each<[number, number, boolean, string | null]>([
    [70, 140, true, null], // half time is no stretch
    [140, 75, true, null], // 6.7 % after the fold
    [140, 64, true, "Stretch 9 %"], // 9.4 % after the fold
    [150, 128, true, "Χωρίς ταίριασμα tempo"],
    [150, 128, false, "Χωρίς ταίριασμα tempo"],
    [140, 64, false, null],
  ])("stretch chip, %p → %p BPM, tempo match %p: %p", (out, inn, tempo_match, label) => {
    expect(stretchChip(tempoDeviation(out, inn), { preset: "blend", tempo_match })?.label ?? null).toBe(label);
  });
});

describe("presets", () => {
  const base: TransitionParams = { preset: "custom", bars: 6, volume_curve: "linear", eq_curve: "bass_cut_long", filter_curve: "lpf_out", loop_beats: 2, out_anchor_s: 120.5, in_anchor_s: 3.25, tempo_match: false };
  test.each([...PRESET_KEYS])("applying %p twice is the same as once, and the input is not touched", preset => {
    const copy = structuredClone(base);
    const once = applyPreset(preset, base);
    expect(applyPreset(preset, once)).toEqual(once);
    expect(base).toEqual(copy);
    expect(once).toMatchObject({ preset, out_anchor_s: 120.5, in_anchor_s: 3.25, tempo_match: false });
  });
  const lane = (): LaneInput => ({ trackId: 1, grid: { kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false }, duration: 300, cues: [], rate: 1, onEngine: true });
  const fresh = { out_anchor_s: null, in_anchor_s: null, tempo_match: true };
  test.each([...Object.keys(PRESETS), ...Object.keys(HAND_PRESETS)].filter(k => k !== "none"))("%p plays as a mix of its own bars, with its loop", preset => {
    const p = applyPreset(preset as NamedPreset, { ...base, ...fresh });
    const spec = { ...PRESETS, ...HAND_PRESETS }[preset as NamedPreset];
    const plan = planTransition(lane(), lane(), p);
    expect(plan.kind).toBe("mix");
    expect(plan.bars).toBe(spec.bars);
    expect(plan.loop != null).toBe(spec.loop_beats != null);
    expect(presetFor(p)).toBe(preset as NamedPreset);
  });
  test("«Χωρίς μετάβαση» applied over a custom transition is a cut and reads back as none", () => {
    const p = applyPreset("none", { ...base, ...fresh });
    expect(p.bars).toBe(0);
    expect(presetFor(p)).toBe("none");
    expect(planTransition(lane(), lane(), p)).toMatchObject({ kind: "cut", outStartS: 300, bars: 0 });
  });
});
