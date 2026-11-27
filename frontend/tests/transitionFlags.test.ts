import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { flagChips } from "../src/lib/transitions/copy";
import { bassClashBars, keyClashBars, offPhrase, transitionFlags, type FlagLane, type FlagParams, type FlagWindow } from "../src/lib/transitions/flags";

/** 120 BPM: 2 s bars, 16 s phrases. */
const grid = (phrases?: number[]): BeatGrid => ({ kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false, phrases });
const every16 = (to: number) => Array.from({ length: Math.floor(to / 16) + 1 }, (_, i) => i * 16);
/** Sections from [start_s, bass] pairs; quality 0.9 unless given. */
const structure = (parts: [number, boolean][], quality = 0.9) => ({
  quality, sections: parts.map(([start_s, bass]) => ({ start_s, beats: 64, bass, level: bass ? 1 : 0 })),
});
/** Outgoing: bass from the start until its closing at 200 s. Incoming: a 32 s intro, then bass. */
const OUT: FlagLane = { grid: grid(every16(300)), structure: structure([[0, true], [200, false]]) };
const IN: FlagLane = { grid: grid(every16(300)), structure: structure([[0, false], [32, true]]) };
const params = (patch: Partial<FlagParams> = {}): FlagParams =>
  ({ preset: "custom", bars: 16, volume_curve: "overlap", eq_curve: "none", filter_curve: "none", loop_beats: null, ...patch });
const win = (patch: Partial<FlagWindow> = {}): FlagWindow => ({ outStartS: 100, inStartS: 32, bars: 16, rateIn: null, ...patch });

describe("bassClashBars", () => {
  test("both tracks in bass for the whole window with no swap", () => {
    expect(bassClashBars(OUT, IN, params(), win())).toBe(16);
  });
  test("more than 4 bars flags, 4 or fewer does not", () => {
    // The incoming bass comes in 22 s (11 bars) into the 32 s window: 5 bars together.
    expect(bassClashBars(OUT, IN, params(), win({ inStartS: 10 }))).toBe(5);
    expect(bassClashBars(OUT, IN, params(), win({ inStartS: 8 }))).toBeNull();
  });
  test("a bass swap or a long bass cut covers it", () => {
    for (const eq_curve of ["bass_swap_center", "bass_swap_start", "bass_swap_end", "three_band", "fade_out_start", "bass_cut_quick"] as const) {
      expect(bassClashBars(OUT, IN, params({ eq_curve }), win())).toBeNull();
    }
    // A long cut lets the outgoing bass through for the window's first half: 8 bars of two basses.
    expect(bassClashBars(OUT, IN, params({ eq_curve: "bass_cut_long" }), win())).toBe(8);
    // An incoming high-pass lets its bass in over the window's last 30 %: under 3 bars of 8, nearly 5 of 16.
    expect(bassClashBars(OUT, IN, params({ filter_curve: "hpf_in", bars: 8 }), win({ bars: 8 }))).toBeNull();
    expect(bassClashBars(OUT, IN, params({ filter_curve: "hpf_in" }), win())).toBe(4.75);
  });
  test("a build-up counts as bass: its low end is in the track's loud class", () => {
    const building: FlagLane = { grid: grid(every16(300)), structure: { quality: 0.9, sections: [
      { start_s: 0, beats: 64, bass: false, level: 0 }, { start_s: 32, beats: 64, bass: true, level: 0.6, kind: "buildup" }, { start_s: 64, beats: 64, bass: true, level: 1 }] } };
    expect(bassClashBars(OUT, building, params(), win())).toBe(16);
  });
  test("no flag when the outgoing track is already in its closing", () => {
    expect(bassClashBars(OUT, IN, params(), win({ outStartS: 200 }))).toBeNull();
  });
  test("a loop holds the outgoing deck in its bass", () => {
    expect(bassClashBars(OUT, IN, params(), win({ outStartS: 198 }))).toBeNull();
    expect(bassClashBars(OUT, IN, params({ loop_beats: 4 }), win({ outStartS: 198 }))).toBe(16);
  });
  test("missing or unsure data flags nothing", () => {
    expect(bassClashBars({ ...OUT, structure: null }, IN, params(), win())).toBeNull();
    expect(bassClashBars(OUT, { ...IN, structure: undefined }, params(), win())).toBeNull();
    expect(bassClashBars(OUT, { ...IN, structure: structure([[0, false], [32, true]], 0.75) }, params(), win())).toBeNull();
    expect(bassClashBars({ ...OUT, grid: null }, IN, params(), win())).toBeNull();
    expect(bassClashBars(OUT, IN, params({ preset: "none" }), win())).toBeNull();
    expect(bassClashBars(OUT, IN, params(), win({ bars: 0 }))).toBeNull();
  });
});

describe("offPhrase", () => {
  test("phrases that start together are not flagged", () => {
    expect(offPhrase(OUT, IN, params(), win({ outStartS: 160, inStartS: 0 }))).toBe(false);
    expect(offPhrase(OUT, IN, params(), win({ outStartS: 160, inStartS: 32 }))).toBe(false);
  });
  test("phrases 4 bars apart are flagged", () => {
    expect(offPhrase(OUT, IN, params(), win({ outStartS: 160, inStartS: 8 }))).toBe(true);
  });
  test("one beat apart still counts as together, two beats do not", () => {
    expect(offPhrase(OUT, IN, params(), win({ outStartS: 160, inStartS: 0.5 }))).toBe(false);
    expect(offPhrase(OUT, IN, params(), win({ outStartS: 160, inStartS: 1 }))).toBe(true);
  });
  test("the incoming lines are read at the incoming rate", () => {
    // At twice the speed the lines at 20 and 52 s land at 168 and 184 s on the outgoing clock, between its lines;
    // at the track's own speed the one at 20 s lands on the outgoing line at 176 s.
    const lines = { ...IN, grid: grid([20, 52, 84]) };
    expect(offPhrase(OUT, lines, params(), win({ outStartS: 160, inStartS: 4, rateIn: 2 }))).toBe(true);
    expect(offPhrase(OUT, lines, params(), win({ outStartS: 160, inStartS: 4, rateIn: 1 }))).toBe(false);
  });
  test("no flag when no phrase line falls inside the window", () => {
    const sparse = { ...OUT, grid: grid([0, 100]) }, one = { ...IN, grid: grid([0]) };
    expect(offPhrase(sparse, one, params({ bars: 4 }), win({ outStartS: 40, inStartS: 4, bars: 4 }))).toBe(false);
  });
  test("missing or unsure data, a loop or a cut flags nothing", () => {
    const off = win({ outStartS: 160, inStartS: 8 });
    expect(offPhrase({ ...OUT, grid: grid() }, IN, params(), off)).toBe(false);
    expect(offPhrase(OUT, { ...IN, grid: grid([]) }, params(), off)).toBe(false);
    expect(offPhrase(OUT, { ...IN, structure: null }, params(), off)).toBe(false);
    expect(offPhrase({ ...OUT, structure: structure([[0, true]], 0.7) }, IN, params(), off)).toBe(false);
    expect(offPhrase(OUT, IN, params({ loop_beats: 4 }), off)).toBe(false);
    expect(offPhrase(OUT, IN, params({ preset: "none" }), off)).toBe(false);
  });
});

describe("keyClashBars", () => {
  const key = (key_text: string | null, more: object = {}) => ({ key_text, ...more });
  test("clashing keys heard together for more than 8 bars", () => {
    expect(keyClashBars(key("8A"), key("3B"), params())).toBe(16);
    expect(keyClashBars(key("Am"), key("F#"), params({ bars: 12 }))).toBe(12);
  });
  test("compatible keys on the wheel are never flagged", () => {
    for (const to of ["8A", "9A", "7A", "8B"]) expect(keyClashBars(key("8A"), key(to), params({ bars: 32 }))).toBeNull();
    expect(keyClashBars(key("12A"), key("1A"), params({ bars: 32 }))).toBeNull();
  });
  test("a short overlap or curves that keep the two apart are not flagged", () => {
    expect(keyClashBars(key("8A"), key("3B"), params({ bars: 8 }))).toBeNull();
    // A smooth crossfade holds both above half volume for a third of the window.
    expect(keyClashBars(key("8A"), key("3B"), params({ volume_curve: "smooth" }))).toBeNull();
    expect(keyClashBars(key("8A"), key("3B"), params({ volume_curve: "smooth", bars: 32 }))).toBeGreaterThan(8);
    expect(keyClashBars(key("8A"), key("3B"), params({ eq_curve: "three_band", bars: 32 }))).toBeNull();
    expect(keyClashBars(key("8A"), key("3B"), params({ volume_curve: "center_cut", bars: 32 }))).toBeNull();
  });
  test("the window's own bars win over the saved ones", () => {
    expect(keyClashBars(key("8A"), key("3B"), params({ bars: 32 }), 8)).toBeNull();
  });
  test("a djay key stands in for a missing tag", () => {
    expect(keyClashBars(key(null, { key_djay: "3B" }), key("8A"), params())).toBe(16);
  });
  test("missing or unsure keys flag nothing", () => {
    expect(keyClashBars(key(null), key("3B"), params())).toBeNull();
    expect(keyClashBars(key("~8A"), key("3B"), params())).toBeNull();
    expect(keyClashBars(key("8A"), key("??"), params())).toBeNull();
    const unsure = key(null, { key_analyzed: "3B", key_analyzed_confidence: 0.3, key_analyzed_method: "cqt-octave-trained-v2" });
    expect(keyClashBars(key("8A"), unsure, params())).toBeNull();
    expect(keyClashBars(key("8A"), key("3B"), params({ preset: "none" }))).toBeNull();
  });
});

describe("transitionFlags and its chips", () => {
  test("every check at once, as Greek chips", () => {
    const flags = transitionFlags(OUT, IN, { key_text: "8A" }, { key_text: "3B" }, params(), win({ outStartS: 160, inStartS: 40 }));
    expect(flags).toEqual({ bassBars: 16, offPhrase: true, keyBars: 16 });
    const chips = flagChips(flags);
    expect(chips.map(c => c.label)).toEqual(["Δύο μπάσα μαζί", "Εκτός φράσης", "Απότομη αλλαγή τονικότητας"]);
    expect(chips[0].title).toContain("16 bars");
    for (const c of chips) {
      expect(c.tone).toBe("amber");
      expect(c.title).not.toMatch(/[a-z]+_[a-z]+/);   // no internal keys
    }
  });
  test("nothing to flag gives no chips", () => {
    expect(flagChips(transitionFlags(OUT, IN, { key_text: "8A" }, { key_text: "8A" }, params({ eq_curve: "bass_swap_center" }), win({ outStartS: 160, inStartS: 32 })))).toEqual([]);
    expect(flagChips({})).toEqual([]);
  });
});
