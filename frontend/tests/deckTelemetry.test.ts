import { describe, expect, test } from "bun:test";
import { DB_FLOOR, SYNC_FLASH_MS, flashSync, barPhase, deckLevel, deckLevelNow, padsHaveCues, registerDeck, snapshot, type DeckTelemetryInput } from "../src/lib/deckTelemetry";

const deck = (over: Partial<DeckTelemetryInput> = {}): DeckTelemetryInput => ({ playing: true, bpm: 128, positionMs: 1000, durationMs: 5000, pads: Array(8).fill(false), level: 0.5, barPhase: 0.5, rate: 1, keylock: false, cueSet: false, rangePct: 8, ...over });
const base = { playing: true, stalled: false, positionSec: 10, durationSec: 100, envelope: { rms: [0.1, 0.2, 0.3, 0.4], duration: 100 }, gain: 1 };

describe("snapshot", () => {
  test("null decks and tagRoute", () => {
    expect(snapshot()).toEqual({ tagRoute: false, A: null, B: null });
    (globalThis as any).location = { pathname: "/tag" };
    expect(snapshot().tagRoute).toBe(true);
    delete (globalThis as any).location;
  });
  test("exact keys, sanitised values, unregister, throwing getter", () => {
    const off = registerDeck("A", () => deck({ level: 7, bpm: NaN }));
    const s = snapshot();
    expect(Object.keys(s).sort()).toEqual(["A", "B", "tagRoute"]);
    expect(Object.keys(s.A!).sort()).toEqual(["barPhase", "bpm", "cueSet", "durationMs", "keylock", "level", "pads", "playing", "positionMs", "rangePct", "rate", "syncFlash"]);
    expect(s.A!.level).toBe(1);
    expect(s.A!.bpm).toBe(0);
    off();
    expect(snapshot().A).toBeNull();
    const offB = registerDeck("B", () => { throw new Error("x"); });
    expect(snapshot().B).toBeNull();
    offB();
  });
  test("rate defaults to 1 when missing or unusable, keylock is strictly boolean", () => {
    for (const rate of [undefined, NaN, Infinity, 0, -1, "1.1"]) {
      const off = registerDeck("A", () => deck({ rate: rate as number }));
      expect(snapshot().A!.rate).toBe(1);
      off();
    }
    const off = registerDeck("A", () => deck({ rate: 1.08, keylock: "yes" as unknown as boolean }));
    expect(snapshot().A!.rate).toBe(1.08);
    expect(snapshot().A!.keylock).toBe(false);
    off();
    const on = registerDeck("A", () => deck({ keylock: true }));
    expect(snapshot().A!.keylock).toBe(true);
    on();
  });
  test("stale unregister does not remove a newer getter", () => {
    const off1 = registerDeck("A", () => deck());
    const off2 = registerDeck("A", () => deck({ bpm: 90 }));
    off1();
    expect(snapshot().A!.bpm).toBe(90);
    off2();
  });
});

describe("padsHaveCues", () => {
  test("maps slot ids to existing cues", () => {
    expect(padsHaveCues([5, null, 9, 7], [5, 7])).toEqual([true, false, false, true, false, false, false, false]);
  });
});

describe("deckLevel", () => {
  test("indexes into rms on a dB meter", () => {
    expect(DB_FLOOR).toBe(-40);
    expect(deckLevel(base)).toBeCloseTo(0.5);
    expect(deckLevel({ ...base, envelope: { rms: [0.25], duration: 100 } })).toBeCloseTo(0.699, 3);
    expect(deckLevel({ ...base, envelope: { rms: [0.01], duration: 100 } })).toBe(0);
  });
  test("zero when paused, stalled, or no waveform", () => {
    expect(deckLevel({ ...base, playing: false })).toBe(0);
    expect(deckLevel({ ...base, stalled: true })).toBe(0);
    expect(deckLevel({ ...base, envelope: undefined })).toBe(0);
    expect(deckLevel({ ...base, envelope: { duration: 100 } })).toBe(0);
  });
  test("scales with deck gain and clamps", () => {
    expect(deckLevel({ ...base, positionSec: 60, gain: 0.5 })).toBeCloseTo(0.588, 3);
    expect(deckLevel({ ...base, positionSec: 60, gain: 0.5 })).toBeLessThan(deckLevel({ ...base, positionSec: 60, gain: 1 }));
    expect(deckLevel({ ...base, positionSec: 60, gain: 0 })).toBe(0);
    expect(deckLevel({ ...base, envelope: { rms: [3], duration: 100 } })).toBe(1);
  });
  test("long track uses envelope duration, clamps to last bin", () => {
    const rms = Array.from({ length: 32768 }, (_, i) => i / 32768);
    const env = { rms, duration: 3600 };
    expect(deckLevel({ ...base, durationSec: 3600, positionSec: 1800, envelope: env })).toBeCloseTo(0.8495, 3);
    expect(deckLevel({ ...base, durationSec: 3600, positionSec: 9999, envelope: env })).toBeCloseTo(1, 3);
    expect(deckLevel({ ...base, positionSec: NaN, envelope: env })).toBe(0);
  });
});

describe("barPhase", () => {
  test("128 BPM bar is 1.875 s", () => {
    expect(barPhase(3, 3, 128)).toBe(0);
    expect(barPhase(3.46875, 3, 128)).toBeCloseTo(0.25, 9);
    expect(barPhase(3 + 1.875, 3, 128)).toBeCloseTo(0, 9);
  });
  test("before the anchor wraps positively", () => {
    expect(barPhase(2.53125, 3, 128)).toBeCloseTo(0.75, 9);
  });
  test("unusable tempo is -1", () => {
    expect(barPhase(1, 0, 0)).toBe(-1);
    expect(barPhase(1, 0, NaN)).toBe(-1);
    expect(barPhase(1, 0, -5)).toBe(-1);
  });
});

describe("deckLevelNow", () => {
  test("0 when unregistered, else the getter's level", () => {
    expect(deckLevelNow("B")).toBe(0);
    const off = registerDeck("B", () => deck({ level: 0.4 }));
    expect(deckLevelNow("B")).toBe(0.4);
    off();
    expect(deckLevelNow("B")).toBe(0);
  });
});

describe("Lane T snapshot fields", () => {
  test("cueSet, rangePct and the expiring syncFlash", () => {
    const off = registerDeck("A", () => deck({ cueSet: true, rangePct: 50 }));
    expect(snapshot().A).toMatchObject({ cueSet: true, rangePct: 50, syncFlash: false });
    flashSync("A");
    expect(snapshot().A!.syncFlash).toBe(true);
    expect(snapshot().A!.cueSet).toBe(true);
    flashSync("A", performance.now() - SYNC_FLASH_MS - 1);
    expect(snapshot().A!.syncFlash).toBe(false);
    off();
  });
  test("sanitised: non-boolean cueSet is false, junk or out-of-range rangePct is clamped or defaulted", () => {
    const get = (over: object) => {
      const off = registerDeck("B", () => deck(over as Partial<DeckTelemetryInput>));
      const s = snapshot().B!;
      off();
      return s;
    };
    expect(get({ cueSet: "yes" }).cueSet).toBe(false);
    expect(get({ rangePct: NaN }).rangePct).toBe(8);
    expect(get({ rangePct: "16" }).rangePct).toBe(8);
    expect(get({ rangePct: 0 }).rangePct).toBe(1);
    expect(get({ rangePct: 9999 }).rangePct).toBe(100);
    expect(get({ rangePct: 15.6 }).rangePct).toBe(16);
  });
  test("the flash belongs to its deck", () => {
    const a = registerDeck("A", () => deck());
    const b = registerDeck("B", () => deck());
    flashSync("B");
    expect([snapshot().A!.syncFlash, snapshot().B!.syncFlash]).toEqual([false, true]);
    a(); b();
    flashSync("B", 0);
  });
});
