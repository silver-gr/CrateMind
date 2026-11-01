import { describe, expect, test } from "bun:test";
import { LOOP_DEFAULT_BEATS, LOOP_MAX_BEATS, LOOP_MIN_BEATS, beatSeconds, planLoop } from "../src/lib/loops";

const base = { position: 10, duration: 300, bpm: 120, loop: null, beats: LOOP_DEFAULT_BEATS };

describe("planLoop", () => {
  test("on/off: 4 beats from the playhead at the track's own BPM, off when a loop exists", () => {
    expect(beatSeconds(120)).toBe(0.5);
    expect(planLoop("toggle", base)).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 12 }, beats: 4 });
    expect(planLoop("toggle", { ...base, loop: { start: 10, end: 12 } })).toEqual({ ok: true, kind: "clear" });
    expect(planLoop("toggle", { ...base, bpm: null })).toEqual({ ok: false, reason: "no-bpm" });
    expect(planLoop("toggle", { ...base, bpm: 0 })).toEqual({ ok: false, reason: "no-bpm" });
    expect(planLoop("toggle", { ...base, position: 299 })).toEqual({ ok: false, reason: "range" });
  });

  test("half / double resize an active loop from its start and stay within 1/8..32 beats", () => {
    const loop = { start: 10, end: 12 };
    expect(planLoop("half", { ...base, loop })).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 11 }, beats: 2 });
    expect(planLoop("double", { ...base, loop })).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 14 }, beats: 8 });
    let beats = 4;
    for (let i = 0; i < 5; i++) { const p = planLoop("half", { ...base, beats }); if (p.ok && p.kind === "beats") beats = p.beats; }
    expect(beats).toBe(LOOP_MIN_BEATS);
    expect(planLoop("half", { ...base, beats: LOOP_MIN_BEATS })).toEqual({ ok: false, reason: "limit" });
    expect(planLoop("double", { ...base, beats: LOOP_MAX_BEATS })).toEqual({ ok: false, reason: "limit" });
    expect(planLoop("double", { ...base, beats: 16 })).toEqual({ ok: true, kind: "beats", beats: 32 });
  });

  test("with no loop, half / double only change the length of the next one (no BPM needed)", () => {
    expect(planLoop("double", { ...base, bpm: null })).toEqual({ ok: true, kind: "beats", beats: 8 });
    expect(planLoop("half", { ...base, loop: { start: 10, end: 12 }, bpm: null })).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 11 }, beats: 2 });
  });

  test("a doubled loop that would run past the end of the track is refused", () => {
    expect(planLoop("double", { ...base, position: 298.5, loop: { start: 298.5, end: 299.5 } })).toEqual({ ok: false, reason: "range" });
  });

  test("loop in moves the start to the playhead and keeps the end; without a loop it starts a default one", () => {
    expect(planLoop("in", { ...base, position: 11, loop: { start: 10, end: 14 } })).toEqual({ ok: true, kind: "set", loop: { start: 11, end: 14 }, beats: 4 });
    expect(planLoop("in", base)).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 12 }, beats: 4 });
    expect(planLoop("in", { ...base, position: 15, loop: { start: 10, end: 14 } })).toEqual({ ok: true, kind: "set", loop: { start: 15, end: 17 }, beats: 4 });
  });

  test("loop out moves the end to the playhead and keeps the start; without a loop it looks back one default length", () => {
    expect(planLoop("out", { ...base, position: 13, loop: { start: 10, end: 14 } })).toEqual({ ok: true, kind: "set", loop: { start: 10, end: 13 }, beats: 4 });
    expect(planLoop("out", base)).toEqual({ ok: true, kind: "set", loop: { start: 8, end: 10 }, beats: 4 });
    expect(planLoop("out", { ...base, position: 1 })).toEqual({ ok: false, reason: "range" });
    expect(planLoop("out", { ...base, bpm: null })).toEqual({ ok: false, reason: "no-bpm" });
  });
});
