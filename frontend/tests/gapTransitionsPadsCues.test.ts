// Gap tests for the suggested cues on pads 5–8 (cueSuggestions boundaries, ghostPads), the pad actions around them
// (seek rounding, keep, delete and undo with odd labels and stale pads) and the echo driver with both decks at once.
import { beforeEach, describe, expect, test } from "bun:test";
import { beatPosition, type BeatGrid } from "../src/lib/beatGrid";
import { getFxRack, resetFxRack, selectPreset, setAmount } from "../src/lib/fxRack";
import { ECHO_PRESET, startEcho } from "../src/lib/mix/echoFx";
import { padDelete, padKeep, padPress, type PadIo } from "../src/lib/padActions";
import { resetPrefs } from "../src/lib/prefs";
import { ECHO_AMOUNT } from "../src/lib/transitions/echoOut";
import { cueSuggestions, ghostPads, type CueSuggestion, type StructureSection } from "../src/lib/trackStructure";
import type { TrackCue } from "../src/lib/types";

const sec = (start_s: number, beats: number, bass: boolean): StructureSection => ({ start_s, beats, bass, level: bass ? 1 : 0.3 });
// 150 BPM, bar 1 at 0.2 s (1.6 s bars). Intro 32 bars, bass, a 16-bar break, bass, closing 16 bars.
const grid: BeatGrid = { kind: "straight", anchor: 0.2, period: 0.4, estimated: false, overridden: false, source: "cratemind" };
const track = [sec(0.2, 128, false), sec(51.4, 256, true), sec(153.8, 64, false), sec(179.4, 256, true), sec(281.8, 64, false)];
const common = { quality: 0.9, sections: track, anchors: [51.4, 179.4] };
const DURATION = 307.4;
const points = (s: Parameters<typeof cueSuggestions>[0]) =>
  cueSuggestions(s, grid, DURATION).map(c => [c.slot + 1, c.label, +c.time_s.toFixed(3)] as const);
const COMMON = [[5, "Πρώτο μπάσο", 51.4], [6, "Break", 153.8], [7, "Πριν το drop", 166.6], [8, "Τέλος μπάσου", 281.8]];

describe("suggested cues: the edges of «a common track»", () => {
  test.each<[string, Parameters<typeof cueSuggestions>[0], unknown[]]>([
    ["quality exactly 0.8 is sure", { ...common, quality: 0.8 }, COMMON],
    ["a lead-in of exactly 8 bars", { ...common, sections: [sec(38.6, 32, false), ...track.slice(1)] }, COMMON],
    ["a lead-in one beat short of 8 bars", { ...common, sections: [sec(39, 31, false), ...track.slice(1)] }, []],
    ["a closing of exactly 4 bars", { ...common, sections: [...track.slice(0, 4), sec(281.8, 16, false)] }, COMMON],
    ["a closing one beat short of 4 bars", { ...common, sections: [...track.slice(0, 4), sec(281.8, 15, false)] }, []],
  ])("%s", (_name, structure, expected) => {
    expect(points(structure)).toEqual(expected as never);
  });
  test("exactly three long breaks still get cues; with equal breaks the earliest counts", () => {
    // Three 8-bar breaks: the first one wins, and at 8 bars it gets no «Πριν το drop».
    const three = [sec(0.2, 128, false), sec(51.4, 96, true), sec(89.8, 32, false), sec(102.6, 96, true), sec(141, 32, false),
      sec(153.8, 96, true), sec(192.2, 32, false), sec(205, 192, true), sec(281.8, 64, false)];
    expect(points({ quality: 0.9, sections: three, anchors: [51.4, 102.6, 153.8, 205] }))
      .toEqual([[5, "Πρώτο μπάσο", 51.4], [6, "Break", 89.8], [8, "Τέλος μπάσου", 281.8]]);
    // Two 12-bar breaks: the first one's «Πριν το drop» is 8 bars before its own return.
    const two = [sec(0.2, 128, false), sec(51.4, 96, true), sec(89.8, 48, false), sec(109, 96, true), sec(147.4, 48, false),
      sec(166.6, 288, true), sec(281.8, 64, false)];
    expect(points({ quality: 0.9, sections: two, anchors: [51.4, 109, 166.6] }))
      .toEqual([[5, "Πρώτο μπάσο", 51.4], [6, "Break", 89.8], [7, "Πριν το drop", 96.2], [8, "Τέλος μπάσου", 281.8]]);
  });
  test("every suggestion sits on a bar line, on its own pad 5–8 in time order, with the beat length there", () => {
    const all = cueSuggestions(common, grid, DURATION);
    expect(all.map(s => s.slot)).toEqual([4, 5, 6, 7]);
    for (const s of all) {
      const bars = beatPosition(grid, s.time_s) / 4;
      expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
      expect(s.beat_s).toBeCloseTo(0.4, 9);
    }
    expect(all.map(s => s.time_s)).toEqual([...all.map(s => s.time_s)].sort((a, b) => a - b));
  });
  test("no sections at all, or one section only: nothing", () => {
    expect(cueSuggestions({ quality: 0.9, sections: [], anchors: [] }, grid, DURATION)).toEqual([]);
    expect(cueSuggestions({ quality: 0.9, sections: [sec(0.2, 700, true)], anchors: [0.2] }, grid, DURATION)).toEqual([]);
  });
});

describe("ghost pads", () => {
  const all = cueSuggestions(common, grid, DURATION);
  const empty = Array<number | null>(8).fill(null);
  test.each([
    [51_800, null], // exactly one beat from «Πρώτο μπάσο»: that cue already covers it
    [51_801, "Πρώτο μπάσο"],
    [51_000, null], // exactly one beat before it
    [50_999, "Πρώτο μπάσο"],
  ])("a saved cue at %p ms → pad 5 shows %p", (position_ms, label) => {
    expect(ghostPads(all, empty, [{ id: 9, position_ms }])[4]?.label ?? null).toBe(label);
  });
  test("a deck with fewer pads than the suggestions drops the extra ones", () => {
    expect(ghostPads(all, [null, null, null, null], [])).toEqual([null, null, null, null]);
    expect(ghostPads(all, Array(6).fill(null), []).map(g => g?.slot ?? null)).toEqual([null, null, null, null, 4, 5]);
  });
  test("ghostPads changes neither the suggestions nor the slots", () => {
    const slots = [1, null, null, null, null, null, null, null];
    const before = JSON.stringify([all, slots]);
    ghostPads(all, slots, [{ id: 1, position_ms: 9000 }]);
    expect(JSON.stringify([all, slots])).toBe(before);
  });
});

const cue = (id: number, position_ms: number, kind: TrackCue["kind"] = "cue", label: string | null = null): TrackCue =>
  ({ id, track_id: 1, position_ms, kind, label, created_at: "", updated_at: "" });
const ghost = (slot: number, time_s: number, label = "Break"): CueSuggestion => ({ slot, label, time_s, source_s: time_s, beat_s: 0.4 });

function world(initial: { cues: TrackCue[]; slots?: (number | null)[]; ghosts?: Record<number, CueSuggestion> }) {
  const w = {
    track: 1, cues: [...initial.cues], slots: initial.slots ?? Array<number | null>(8).fill(null), nextId: 100,
    seeks: [] as number[], toasts: [] as string[], errors: [] as string[], undo: null as null | (() => Promise<void> | void),
    ghosts: initial.ghosts ?? {}, created: [] as { position_ms: number; kind: string; label: string | null }[], deleted: [] as number[],
  };
  const io: PadIo = {
    trackId: () => w.track, cues: () => w.cues, slots: () => w.slots, suggestion: slot => w.ghosts[slot] ?? null, surfaceOpen: () => false,
    seek: ms => { w.seeks.push(ms); },
    capturePending: () => false,
    capture: async () => undefined,
    assign: (slot, id) => { w.slots = w.slots.map((s, i) => (i === slot ? id : s === id ? null : s)); },
    deleteCue: async id => { w.deleted.push(id); w.cues = w.cues.filter(c => c.id !== id); w.slots = w.slots.map(s => (s === id ? null : s)); },
    createCue: async input => { const c = cue(w.nextId++, input.position_ms, input.kind, input.label); w.created.push(input); w.cues.push(c); return c; },
    toast: { info: m => { w.toasts.push(m); }, error: m => { w.errors.push(m); }, undo: (_m, fn) => { w.undo = fn; } },
  };
  return { w, io };
}

describe("pad actions around suggested cues", () => {
  test.each([
    [51.4004, 51_400],
    [166.6, 166_600],
    [0.0004, 0],
    [281.8005, 281_801],
  ])("a ghost at %p s seeks to %p ms", async (time_s, ms) => {
    const { w, io } = world({ cues: [], ghosts: { 4: ghost(4, time_s) } });
    await padPress(io, 4);
    expect(w.seeks).toEqual([ms]);
    expect(w.created).toEqual([]);
  });
  test("keeping saves the rounded time and a Greek label as they are", async () => {
    const { w, io } = world({ cues: [], ghosts: { 6: ghost(6, 166.6, "Πριν το drop") } });
    await padKeep(io, 6);
    expect(w.created).toEqual([{ position_ms: 166_600, kind: "cue", label: "Πριν το drop" }]);
    expect(w.slots[6]).toBe(100);
  });
  test("keeping on a pad that already holds a cue does nothing", async () => {
    const { w, io } = world({ cues: [cue(7, 12_000)], slots: [null, null, null, null, 7, null, null, null], ghosts: { 4: ghost(4, 51.4) } });
    await padKeep(io, 4);
    expect(w.created).toEqual([]);
    expect(w.slots[4]).toBe(7);
  });
  test("keeping on a pad that names a deleted cue keeps the ghost there", async () => {
    const { w, io } = world({ cues: [], slots: [null, null, null, null, 55, null, null, null], ghosts: { 4: ghost(4, 51.4) } });
    await padKeep(io, 4);
    expect(w.created.length).toBe(1);
    expect(w.slots[4]).toBe(100);
  });
  test("Shift + a pad that names a deleted cue deletes nothing and says nothing", async () => {
    const { w, io } = world({ cues: [], slots: [55, null, null, null, null, null, null, null] });
    await padDelete(io, 0);
    expect(w.deleted).toEqual([]);
    expect(w.toasts).toEqual([]);
    expect(w.undo).toBeNull();
  });
  test("undo brings back an odd position and an emoji label exactly, into a pad left naming a vanished cue", async () => {
    const label = "Ντροπ 🎧 «A»";
    const { w, io } = world({ cues: [cue(3, 12_345, "cue", label)], slots: [null, 3, null, null, null, null, null, null] });
    await padDelete(io, 1);
    expect(w.slots[1]).toBeNull();
    w.slots = [null, 77, null, null, null, null, null, null]; // the pad now names a cue that is gone
    await w.undo!();
    expect(w.created).toEqual([{ position_ms: 12_345, kind: "cue", label }]);
    expect(w.slots[1]).toBe(100);
  });
});

describe("the echo driver with both decks", () => {
  beforeEach(() => { resetPrefs(); resetFxRack(); });
  test("an echo on each deck: ending one leaves the other alone", () => {
    const a = startEcho("A")!, b = startEcho("B")!;
    a.level(1); b.level(0.5);
    expect(getFxRack().decks.A.amount).toBeCloseTo(ECHO_AMOUNT, 9);
    expect(getFxRack().decks.B.amount).toBeCloseTo(ECHO_AMOUNT / 2, 9);
    a.end();
    expect(getFxRack().decks.A.on).toBe(false);
    expect(getFxRack().decks.B).toMatchObject({ on: true, preset: ECHO_PRESET });
    expect(startEcho("B")).toBeNull(); // B's effect is on: a second run keeps out
    b.end();
    expect(getFxRack().decks.B.on).toBe(false);
  });
  test("a deck whose own preset is the echo gets its own amount back", () => {
    selectPreset("A", ECHO_PRESET);
    setAmount("A", 0.25);
    const run = startEcho("A")!;
    expect(getFxRack().decks.A.amount).toBe(0);
    run.level(0.8);
    run.end();
    expect(getFxRack().decks.A).toMatchObject({ preset: ECHO_PRESET, amount: 0.25, on: false });
  });
});
