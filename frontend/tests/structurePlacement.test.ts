import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { eqAt } from "../src/lib/transitions/curves";
import { bassEntryS, bassStopS, phraseBars, structureInStart, structureOutStart, swapBar, type LaneStructure } from "../src/lib/transitions/structurePlacement";
import { EQ_CURVES, type EqCurve } from "../src/lib/transitions/types";

/** 120 BPM: 2 s bars, 16 s phrases. */
const grid = (phrases?: number[]): BeatGrid => ({ kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false, phrases });
/** Sections from [start_s, bass] pairs. */
const structure = (...parts: [number, boolean][]): LaneStructure => ({
  sections: parts.map(([start_s, bass]) => ({ start_s, beats: 64, bass, level: bass ? 1 : 0 })),
});
const every16 = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / 16) + 1 }, (_, i) => from + i * 16);

describe("swapBar", () => {
  const HALF: EqCurve[] = ["bass_swap_center", "bass_swap_staged", "three_band"], START: EqCurve[] = ["bass_swap_start", "fade_out_start"];
  test("every EQ curve at 8, 4, 2 and 1 bars", () => {
    for (const bars of [8, 4, 2, 1]) for (const eq of EQ_CURVES) {
      expect(swapBar(eq, "none", bars)).toBe(START.includes(eq) ? 0 : HALF.includes(eq) ? Math.floor(bars / 2) : bars);
    }
    expect(swapBar("bass_swap_center", "lpf_in_lpf_out", 8)).toBe(4);
    expect(swapBar("bass_swap_center", "none", 1)).toBe(0);
  });
  test("an incoming high-pass puts the bass at the window end, whatever the EQ", () => {
    for (const filter of ["hpf_in", "hpf_in_hpf_out", "hpf_in_lpf_out"] as const) for (const eq of EQ_CURVES) {
      expect(swapBar(eq, filter, 8)).toBe(8);
    }
  });
  test("the swap curves agree with eqAt: the incoming lows pass the outgoing's near k / bars", () => {
    for (const eq of ["bass_swap_start", "fade_out_start", "bass_swap_center", "bass_swap_staged", "three_band", "bass_swap_end"] as const) {
      let cross = 1;
      for (let i = 0; i <= 1000; i++) {
        const e = eqAt(eq, i / 1000, 1 / 32);
        if (e.in.lo >= e.out.lo) { cross = i / 1000; break; }
      }
      expect(Math.abs(cross - swapBar(eq, "none", 8) / 8)).toBeLessThanOrEqual(0.1);
    }
  });
});

describe("bass entry and stop", () => {
  test("the first bass after an intro, on its bar", () => {
    expect(bassEntryS(structure([0, false], [32.4, true], [150, false]), grid(), 200)).toBe(32);
  });
  test("bass from the first beat, or past the track's half: none", () => {
    expect(bassEntryS(structure([0, true], [150, false]), grid(), 200)).toBeNull();
    expect(bassEntryS(structure([0, false], [102, true]), grid(), 200)).toBeNull();
    expect(bassEntryS(structure([0, false]), grid(), 200)).toBeNull();
  });
  test("the bass stop is the outro's start; none when the track ends with bass", () => {
    expect(bassStopS(structure([0, false], [32, true], [64, false], [96, true], [160.5, false]))).toBe(160.5);
    expect(bassStopS(structure([0, false], [32, true]))).toBeNull();
  });
});

describe("phraseBars", () => {
  test("each line on its nearest bar (an exact half rounds up), duplicates dropped", () => {
    expect(phraseBars(grid([16, 32.5, 33, 47, 48.4, 63.9]))).toEqual([16, 32, 34, 48, 64]);
    expect(phraseBars(grid())).toEqual([]);
  });
});

describe("structureOutStart", () => {
  const s = structure([0, false], [32, true], [160, false]);
  test("the swap sits on the phrase line where the bass stops", () => {
    expect(structureOutStart(grid(every16(0, 192)), 200, s, 8, 8)).toBe(144);
    expect(structureOutStart(grid(every16(0, 192)), 200, s, 8, 4)).toBe(152);
    expect(structureOutStart(grid(every16(0, 192)), 200, s, 4, 0)).toBe(160);
  });
  test("a bass stop one beat after a bar line counts as that bar", () => {
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true], [160.5, false]), 8, 8)).toBe(144);
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true], [159.5, false]), 8, 8)).toBe(144);
  });
  test("an off-bar phrase line moves to its bar", () => {
    expect(structureOutStart(grid([128.5, 144.5, 160.5]), 200, s, 8, 8)).toBe(144);
  });
  test("bass that never stops: the latest line whose window fits", () => {
    // Swap at the end: 192 + 0 ≤ 200. Swap at the start of 8 bars: 192 + 16 > 200, so 176.
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true]), 8, 8)).toBe(176);
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true]), 8, 0)).toBe(176);
  });
  test("no line fits, or only lines in the first half: none", () => {
    expect(structureOutStart(grid(), 200, s, 8, 8)).toBeNull();
    expect(structureOutStart(grid(every16(0, 96)), 200, s, 8, 8)).toBeNull();
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true], [90, false]), 8, 8)).toBeNull();
    // Half is 100: the line at 112 is the first that counts.
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true], [112, false]), 8, 8)).toBe(96);
  });
  test("the window never starts before the first bar line or `notBeforeS`", () => {
    expect(structureOutStart(grid([8]), 12, structure([0, true], [8, false]), 8, 8)).toBeNull();
    expect(structureOutStart(grid(every16(0, 192)), 200, s, 8, 8, 144)).toBe(144);
    expect(structureOutStart(grid(every16(0, 192)), 200, s, 8, 8, 144.5)).toBeNull();
    // Bass never stops: a later line is still ahead of the playhead.
    expect(structureOutStart(grid(every16(0, 192)), 200, structure([0, false], [32, true]), 8, 8, 150)).toBe(176);
  });
});

describe("structureInStart", () => {
  const s = structure([0, false], [32, true]);
  test("the lead before the first bass, on a bar line", () => {
    expect(structureInStart(grid(), 200, s, 16, 0)).toBe(16);
    expect(structureInStart(grid(), 200, s, 8.7, 0)).toBe(24);
    expect(structureInStart(grid(), 200, s, 0, 0)).toBe(32);
  });
  test("none when the bass is closer than the lead, or there is no entry", () => {
    expect(structureInStart(grid(), 200, s, 40, 0)).toBeNull();
    expect(structureInStart(grid(), 200, s, 16, 18)).toBeNull();
    expect(structureInStart(grid(), 200, structure([0, true]), 16, 0)).toBeNull();
  });
});
