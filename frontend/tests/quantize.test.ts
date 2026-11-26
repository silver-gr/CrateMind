import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BeatGrid } from "../src/lib/beatGrid";
import { lockStep, newLock } from "../src/lib/deckSync";
import { LOOP_DEFAULT_BEATS, planLoop } from "../src/lib/loops";
import { DEFAULT_PREFS } from "../src/lib/prefs";
import { cueJump, loopOnBeats, quantizeGrid, snapToBeat } from "../src/lib/quantize";

const steady = (period: number, anchor = 0): BeatGrid => ({ kind: "straight", anchor, period, estimated: false, overridden: false });
const list = (times: number[]): BeatGrid => ({ kind: "list", times, downIndex: 0, estimated: false, overridden: false });
/** 120 BPM with the first beat at 0.1 s. */
const G = steady(0.5, 0.1);
/** Beats from 10 s: eight at 120 BPM, then eight at 100 BPM (the last beat is at 18.8 s). */
const SECTIONS = list([...Array.from({ length: 9 }, (_, i) => 10 + i * 0.5), ...Array.from({ length: 8 }, (_, i) => 14 + (i + 1) * 0.6)]);

describe("quantizeGrid", () => {
  test("only a grid Sync would hold the beats with", () => {
    expect(quantizeGrid(G, 120)).toBe(G);
    expect(quantizeGrid(SECTIONS, null)).toBe(SECTIONS);
    expect(quantizeGrid(null, 120)).toBeNull();
    expect(quantizeGrid(G, 140)).toBeNull(); // a manual BPM that contradicts the stored grid
    expect(quantizeGrid({ ...G, estimated: true }, 120)).toBeNull(); // BPM + entry cue only
    const marked: BeatGrid = { ...G, estimated: true, overridden: true };
    expect(quantizeGrid(marked, 120)).toBe(marked); // the user gave the estimate a downbeat
  });
});

describe("snapToBeat", () => {
  test("a steady grid: the nearest beat, or the nearest half beat", () => {
    expect(snapToBeat(G, 10.3)).toBeCloseTo(10.1);
    expect(snapToBeat(G, 10.4)).toBeCloseTo(10.6);
    expect(snapToBeat(G, 10.3, Infinity, 0.5)).toBeCloseTo(10.35);
    expect(snapToBeat(G, 10.5, Infinity, 0.5)).toBeCloseTo(10.6);
    expect(snapToBeat(G, NaN)).toBeNull();
  });
  test("a steady grid stays inside the track: never before 0:00 or after the end", () => {
    expect(snapToBeat(steady(0.5, 0.3), 0.02)).toBeCloseTo(0.3); // the nearest beat (-0.2 s) is before the start
    expect(snapToBeat(G, 0.2, 300)).toBeCloseTo(0.1);
    expect(snapToBeat(G, 299.95, 300)).toBeCloseTo(299.6); // 300.1 is past the end
  });
  test("a beat list follows its tempo sections", () => {
    expect(snapToBeat(SECTIONS, 12.2)).toBeCloseTo(12);
    expect(snapToBeat(SECTIONS, 15.0)).toBeCloseTo(15.2);
    expect(snapToBeat(SECTIONS, 14.8)).toBeCloseTo(14.6);
    expect(snapToBeat(SECTIONS, 14.3, Infinity, 0.5)).toBeCloseTo(14.3); // half a 100 BPM beat after 14 s
  });
  test("outside a beat list only the edge beats' own neighbourhood snaps", () => {
    expect(snapToBeat(SECTIONS, 9.8)).toBeCloseTo(10);
    expect(snapToBeat(SECTIONS, 9.7)).toBeNull();
    expect(snapToBeat(SECTIONS, 3)).toBeNull();
    expect(snapToBeat(SECTIONS, 19.0)).toBeCloseTo(18.8);
    expect(snapToBeat(SECTIONS, 19.2)).toBeNull();
    expect(snapToBeat(SECTIONS, 18.7, 18.5)).toBeCloseTo(18.2); // the last beat is past the end of the audio
  });
});

describe("cueJump", () => {
  test("lands as far from the cue's beat as the playhead is from its own, by less than half a beat", () => {
    expect(cueJump(G, 20.25, 60.1)).toBeCloseTo(60.25);
    expect(cueJump(G, 20.25, 60.3)).toBeCloseTo(60.25); // a cue off the grid keeps its own place, moved into phase
    expect(cueJump(G, 20.1, 60.1)).toBeCloseTo(60.1);
    expect(cueJump(G, 20.55, 60.1)).toBeCloseTo(60.05); // late in a beat (phase 0.9): 0.1 beat before the cue
  });
  test("the phase is counted in beats, so it carries across tempo sections", () => {
    expect(cueJump(SECTIONS, 11.125, 15.2)).toBeCloseTo(15.35); // a quarter of a 120 BPM beat -> of a 100 BPM beat
    expect(cueJump(SECTIONS, 14.75, 10.5)).toBeCloseTo(10.625);
  });
  test("with no beat at the playhead or at the cue, the cue is used as it is", () => {
    expect(cueJump(SECTIONS, 5, 12.03)).toBe(12.03);
    expect(cueJump(SECTIONS, 11.25, 4)).toBe(4);
    expect(cueJump(SECTIONS, 11.25, 25)).toBe(25);
  });
  test("stays inside the track", () => {
    expect(cueJump(G, 20.25, 299.6, 299.7)).toBeCloseTo(299.7); // the landing would be past the end
    expect(cueJump(steady(0.5, 0.02), 19.97, 0.02)).toBe(0); // 0.1 beat before a cue at 0.02 s is before 0:00
  });
});

describe("loopOnBeats", () => {
  test("whole beats only, wherever the loop starts", () => {
    expect(loopOnBeats(G, { start: 10.1, end: 12.1 })).toBe(true);
    expect(loopOnBeats(G, { start: 10.27, end: 12.27 })).toBe(true);
    expect(loopOnBeats(G, { start: 10.1, end: 10.35 })).toBe(false);
    expect(loopOnBeats(G, { start: 10.1, end: 11.3 })).toBe(false);
    expect(loopOnBeats(SECTIONS, { start: 13, end: 15.2 })).toBe(true); // 2 + 2 beats across the tempo change
    expect(loopOnBeats(SECTIONS, { start: 13, end: 15 })).toBe(false);
  });
});

describe("Sync lock through a whole-beat loop on the other deck", () => {
  test("the wrap moves the other deck by whole beats, so the locked deck is neither moved nor re-offset", () => {
    const g = steady(0.5);
    const st = { ...newLock(), holding: true, at: 0, ownPos: 29.95, refPos: 11.95, ownRate: 1, refRate: 1 };
    // 100 ms later the other deck has wrapped from 12 s back to 10 s (a 4-beat loop) and is at 10.05 s.
    const step = lockStep(st, { at: 0.1, own: { grid: g, position: 30.05, rate: 1 }, ref: { grid: g, position: 10.05, rate: 1 }, expected: 1, canHold: true, snap: false, hand: false });
    expect(step.snap).toBe(false);
    expect(step.state.offset).toBe(0);
    expect(step.rate).toBeCloseTo(1, 2);
  });
});

describe("planLoop with Quantize", () => {
  const base = { position: 10.3, duration: 300, bpm: 120, loop: null, beats: LOOP_DEFAULT_BEATS, grid: G };
  test("an auto-loop starts on the nearest beat and runs the chosen beats", () => {
    expect(planLoop("toggle", base)).toEqual({ ok: true, kind: "set", loop: { start: 10.1, end: 12.1 }, beats: 4 });
    const half = planLoop("toggle", { ...base, position: 10.5, beats: 0.5 });
    expect(half).toMatchObject({ ok: true, kind: "set", beats: 0.5 });
    if (half.ok && half.kind === "set") { expect(half.loop.start).toBeCloseTo(10.6); expect(half.loop.end).toBeCloseTo(10.85); }
    expect(planLoop("toggle", { ...base, loop: { start: 10.1, end: 12.1 } })).toEqual({ ok: true, kind: "clear" });
  });
  test("the length comes from the grid, not the BPM: a loop over a tempo change is still 4 beats", () => {
    const plan = planLoop("toggle", { ...base, grid: SECTIONS, position: 13.1, bpm: null });
    expect(plan).toMatchObject({ ok: true, kind: "set" });
    if (plan.ok && plan.kind === "set") { expect(plan.loop.start).toBeCloseTo(13); expect(plan.loop.end).toBeCloseTo(15.2); }
  });
  test("manual in / out land on beats and leave a whole number of beats", () => {
    const loop = { start: 10.1, end: 14.1 };
    expect(planLoop("in", { ...base, position: 11.2, loop })).toEqual({ ok: true, kind: "set", loop: { start: 11.1, end: 14.1 }, beats: 4 });
    expect(planLoop("out", { ...base, position: 12.7, loop })).toEqual({ ok: true, kind: "set", loop: { start: 10.1, end: 12.6 }, beats: 4 });
    // Out on the start's own beat still leaves one beat; an end set before Quantize is rounded to whole beats.
    expect(planLoop("out", { ...base, position: 10.3, loop })).toEqual({ ok: true, kind: "set", loop: { start: 10.1, end: 10.6 }, beats: 4 });
    expect(planLoop("in", { ...base, position: 11.2, loop: { start: 10.1, end: 13.9 } })).toEqual({ ok: true, kind: "set", loop: { start: 11.1, end: 14.1 }, beats: 4 });
    expect(planLoop("in", base)).toEqual({ ok: true, kind: "set", loop: { start: 10.1, end: 12.1 }, beats: 4 });
    expect(planLoop("out", base)).toEqual({ ok: true, kind: "set", loop: { start: 8.1, end: 10.1 }, beats: 4 });
  });
  test("half / double resize in beats", () => {
    const plan = planLoop("double", { ...base, grid: SECTIONS, loop: { start: 13, end: 14 }, beats: 2 });
    expect(plan).toMatchObject({ ok: true, kind: "set", beats: 4 });
    if (plan.ok && plan.kind === "set") expect(plan.loop.end).toBeCloseTo(15.2);
    expect(planLoop("half", { ...base, loop: { start: 10.1, end: 12.1 } })).toEqual({ ok: true, kind: "set", loop: { start: 10.1, end: 11.1 }, beats: 2 });
  });
  test("where the grid has no beat, the loop is planned as without Quantize", () => {
    const off = { ...base, grid: SECTIONS, position: 30.3 };
    expect(planLoop("toggle", off)).toEqual(planLoop("toggle", { ...off, grid: null }));
    expect(planLoop("toggle", { ...off, bpm: null })).toEqual({ ok: false, reason: "no-bpm" });
    expect(planLoop("toggle", { ...base, grid: null })).toEqual({ ok: true, kind: "set", loop: { start: 10.3, end: 12.3 }, beats: 4 });
  });
});

describe("wiring (source contract)", () => {
  const mini = readFileSync(new URL("../src/components/MiniPlayer.tsx", import.meta.url), "utf8");
  test("Quantize is off by default", () => {
    expect(DEFAULT_PREFS.quantize).toBe(false);
  });
  test("pads, keys, the controller and the cue markers all jump through jumpToCue; loops and new cues read the same grid", () => {
    expect(mini).not.toMatch(/seekTo\((cue\.)?position(_ms|Ms) \/ 1000\)/);
    expect(mini.match(/jumpToCue\((cue\.)?position(_ms|Ms) \/ 1000\)/g)?.length).toBe(4);
    expect(mini).toContain("onCueSeek={jumpToCue}");
    expect(mini).toContain("beats: loopBeatsRef.current, grid: quantGrid() }");
    expect(mini).toContain("snapToBeat(g, a.currentTime, a.duration)");
    expect(mini).toContain('twoDeckRef.current && getPref("quantize") ? quantizeGrid(gridRef.current, deckBpmRef.current) : null');
  });
});
