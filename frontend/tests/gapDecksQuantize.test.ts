// Gaps in the Quantize tests: snapping is idempotent and stays within half a step, unusable times and tracks shorter
// than their first beat, ties, cue jumps keep the playhead's phase everywhere, and the grid Quantize trusts after the
// octave fold of a stored grid.
import { describe, expect, test } from "bun:test";
import { beatPhase, buildBeatGrid, type BeatGrid } from "../src/lib/beatGrid";
import { cueJump, quantizeGrid, snapToBeat } from "../src/lib/quantize";
import type { BeatGridDto } from "../src/lib/types";

const steady = (period: number, anchor = 0): BeatGrid => ({ kind: "straight", anchor, period, estimated: false, overridden: false });
// A CrateMind list: 32 beats at 0.46 s, then 32 at 0.5 s (a tempo change).
const times = [...Array.from({ length: 32 }, (_, n) => 1 + n * 0.46), ...Array.from({ length: 32 }, (_, n) => 1 + 32 * 0.46 + n * 0.5)];
const changing: BeatGrid = { kind: "list", times, downIndex: 0, estimated: false, overridden: false };
const phaseGap = (a: number, b: number) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);

describe("snapToBeat", () => {
  const grids: [string, BeatGrid, number][] = [
    ["steady 174 BPM", steady(60 / 174, 0.137), 60 / 174],
    ["a list with a tempo change", changing, 0.5],
  ];
  test.each(grids)("%s: snapping twice is snapping once, never more than half a step away", (_name, grid, longest) => {
    for (const step of [1, 0.5]) {
      for (let t = 1.01; t < 30; t += 0.173) {
        const s = snapToBeat(grid, t, 60, step);
        expect(s).not.toBeNull();
        expect(Math.abs(s! - t)).toBeLessThanOrEqual(step * longest / 2 + 1e-9);
        expect(snapToBeat(grid, s!, 60, step)!).toBeCloseTo(s!, 9);
        // A whole-beat snap lands on a beat: its phase is 0.
        if (step === 1) expect(phaseGap(beatPhase(grid, s!), 0)).toBeLessThan(1e-9);
      }
    }
  });

  test.each([NaN, Infinity, -Infinity])("an unusable time (%p) snaps nowhere", t => {
    expect(snapToBeat(steady(0.5), t)).toBeNull();
    expect(snapToBeat(changing, t)).toBeNull();
  });

  test("a track that ends before its first beat has no beat to snap to", () => {
    expect(snapToBeat(steady(0.5, 0.4), 0.2, 0.3)).toBeNull();
    expect(snapToBeat(steady(0.5, 0.4), 0.2, 0.4)).toBeCloseTo(0.4, 9); // the beat exactly at the end is inside
  });

  test("a time exactly between two beats goes to the later one, before 0:00's grid start as after it", () => {
    const grid = steady(0.5, 2);
    expect(snapToBeat(grid, 10.25)).toBeCloseTo(10.5, 9);
    expect(snapToBeat(grid, 1.75)).toBeCloseTo(2, 9);  // beat -0.5 from the anchor
    expect(snapToBeat(grid, 1.25)).toBeCloseTo(1.5, 9); // beat -1.5 from the anchor
  });
});

describe("cueJump keeps the playhead's phase and lands within half a beat of the cue", () => {
  const grids: [string, BeatGrid, number][] = [
    ["steady 128 BPM", steady(60 / 128, 0.05), 60 / 128],
    ["a list with a tempo change", changing, 0.5],
  ];
  test.each(grids)("%s", (_name, grid, longest) => {
    for (const from of [2.03, 5.5, 9.876, 17.4, 25.01]) {
      for (const cue of [1.5, 4.6, 8.05, 16.71, 28.2]) {
        const target = cueJump(grid, from, cue);
        expect(Math.abs(target - cue)).toBeLessThanOrEqual(longest / 2 + 1e-9);
        expect(phaseGap(beatPhase(grid, target), beatPhase(grid, from))).toBeLessThan(1e-6);
      }
    }
  });

  test("a playhead already in phase with the cue lands on the cue itself", () => {
    const grid = steady(0.5, 0.1);
    expect(cueJump(grid, 20.35, 4.35)).toBeCloseTo(4.35, 9);
    expect(cueJump(changing, times[40], times[5])).toBeCloseTo(times[5], 9); // both on a beat, across the tempo change
  });
});

describe("the grid Quantize trusts after a stored grid's octave fold", () => {
  const dto = (bpm: number): BeatGridDto => ({ bpm, straight: true, anchor_s: 0.25, source: "cratemind" } as BeatGridDto);

  test.each([
    // stored grid BPM, the deck's resolved BPM, trusted?, beat length snapped to
    [140, 70, true, 60 / 70],
    [140, 280, true, 60 / 280],
    [140, 140.5, true, 60 / 140],
    [140, null, true, 60 / 140],
    [140, 105, false, 0],   // 3:4: not an octave, the grid contradicts the deck
    [140, 150, false, 0],   // 7% off: a manual BPM won
  ] as const)("stored %d on a %p BPM deck", (stored, bpm, trusted, beat) => {
    const grid = quantizeGrid(buildBeatGrid(dto(stored), bpm, null), bpm);
    expect(grid !== null).toBe(trusted);
    if (!grid) return;
    expect(snapToBeat(grid, 0.25 + beat * 7.3)).toBeCloseTo(0.25 + beat * 7, 9);
  });

  test("a BPM estimate is snapped to only once the DJ has marked its downbeat", () => {
    expect(quantizeGrid(buildBeatGrid(null, 128, 0.3), 128)).toBeNull();
    const marked = quantizeGrid(buildBeatGrid(null, 128, 0.3, 1.0), 128);
    expect(marked).not.toBeNull();
    expect(snapToBeat(marked!, 1.0 + (60 / 128) * 4.4)).toBeCloseTo(1.0 + (60 / 128) * 4, 9);
  });

  test("no grid and no BPM: nothing to snap to", () => {
    expect(quantizeGrid(buildBeatGrid(null, null, 0.3), null)).toBeNull();
  });
});
