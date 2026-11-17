import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  SAVE_IDLE_MS, controllerAmount, controllerBeats, controllerDisconnected, controllerTargets, deckBeatsIndex, engage,
  fxRackFromPrefs, getFxRack, latchHeld, paddle, release, releaseHeld, resetFxRack, saveFxRackNow, selectPreset,
  setAmount, setAvailable, setBeats, setNodeState, setPhraseRelease, stepBeats, subscribe, toggleFavourite,
} from "../src/lib/fxRack";
import { DEFAULT_FAVOURITES } from "../src/lib/fxRack/presets";
import { getPref, resetPrefs, setPref, type FxRackPrefs } from "../src/lib/prefs";

const deck = (d: "A" | "B") => getFxRack().decks[d];

beforeEach(() => {
  resetPrefs();
  resetFxRack();
});
afterEach(() => {
  jest.useRealTimers();
  resetFxRack();
});

describe("state and prefs", () => {
  test("first run: Polyrhythmic Delay on both decks at 0.7, default favourites, phrase release on", () => {
    const s = getFxRack();
    for (const d of ["A", "B"] as const) {
      expect(s.decks[d]).toEqual({ preset: "polyrhythmic-delay", amount: 0.7, beats: {}, on: false, held: false, releasing: false, tail: false });
    }
    expect(s.favourites).toEqual([...DEFAULT_FAVOURITES]);
    expect(s.phraseRelease).toEqual({ A: true, B: true });
    expect(s.available).toBe(true);
    expect(s.lastEngaged).toBeNull();
  });

  test("saved prefs are sanitised on read", () => {
    const saved = {
      A: { preset: "nope", amount: 3, beats: { echo: 0, reverb: 1, "tape-echo": 7, gone: 2, "bit-crusher": 0, gate: 1.5 } },
      B: { preset: "roll", amount: Number.NaN, beats: "x" },
      favourites: ["roll", "nope", "roll", 4, "echo"],
      phraseRelease: { A: false, B: "yes" },
    } as unknown as FxRackPrefs;
    const s = fxRackFromPrefs(saved);
    // echo 0 is a non-default choice; reverb 1 is its default; the rest are out of range, unknown or BEATS-less.
    expect(s.decks.A).toMatchObject({ preset: "polyrhythmic-delay", amount: 1, beats: { echo: 0 } });
    expect(s.decks.B).toMatchObject({ preset: "roll", amount: 0.7, beats: {} });
    expect(s.favourites).toEqual(["roll", "echo"]);
    expect(s.phraseRelease).toEqual({ A: false, B: true });
    expect(fxRackFromPrefs({ junk: 1 } as unknown as FxRackPrefs).favourites).toEqual([...DEFAULT_FAVOURITES]);
  });

  test("the store starts from the saved prefs", () => {
    setPref("fxRack", { A: { preset: "echo", amount: 0.4, beats: { echo: 5 } }, B: { preset: "roll", amount: 1, beats: {} },
      favourites: ["echo"], phraseRelease: { A: true, B: false } });
    resetFxRack();
    expect(deck("A")).toMatchObject({ preset: "echo", amount: 0.4, beats: { echo: 5 } });
    expect(deckBeatsIndex(deck("A"))).toBe(5);
    expect(getFxRack().phraseRelease.B).toBe(false);
  });

  test("writes after 500 ms idle, only the persisted fields, with sparse beats", () => {
    jest.useFakeTimers();
    selectPreset("A", "echo");
    setBeats("A", 1);
    setAmount("A", 0.5);
    engage("A", "latch");
    jest.advanceTimersByTime(SAVE_IDLE_MS - 1);
    expect(getPref("fxRack")).toBeNull();
    setAmount("A", 0.6); // restarts the idle wait
    jest.advanceTimersByTime(SAVE_IDLE_MS - 1);
    expect(getPref("fxRack")).toBeNull();
    jest.advanceTimersByTime(1);
    expect(getPref("fxRack")).toEqual({
      A: { preset: "echo", amount: 0.6, beats: { echo: 1 } },
      B: { preset: "polyrhythmic-delay", amount: 0.7, beats: {} },
      favourites: [...DEFAULT_FAVOURITES],
      phraseRelease: { A: true, B: true },
    });
    setBeats("A", 3); // back to the default: the entry disappears
    jest.advanceTimersByTime(SAVE_IDLE_MS);
    expect(getPref("fxRack")?.A.beats).toEqual({});
  });

  test("knob release saves a pending change at once; nothing pending writes nothing", () => {
    jest.useFakeTimers();
    saveFxRackNow();
    expect(getPref("fxRack")).toBeNull();
    setAmount("B", 0.25);
    saveFxRackNow();
    expect(getPref("fxRack")?.B.amount).toBe(0.25);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("live flags never trigger a write", () => {
    jest.useFakeTimers();
    engage("A", "hold");
    latchHeld("A");
    release("A");
    setNodeState("A", { engaged: false, tail: true });
    setAvailable(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("amount and BEATS are clamped; presets without BEATS ignore them", () => {
    setAmount("A", 2);
    expect(deck("A").amount).toBe(1);
    setAmount("A", Number.NaN);
    expect(deck("A").amount).toBe(1);
    selectPreset("A", "echo");
    stepBeats("A", 1);
    stepBeats("A", 1);
    stepBeats("A", 1);
    stepBeats("A", 1);
    expect(deckBeatsIndex(deck("A"))).toBe(6);
    setBeats("A", -4);
    expect(deckBeatsIndex(deck("A"))).toBe(0);
    selectPreset("A", "bit-crusher");
    setBeats("A", 2);
    expect(deck("A").beats).toEqual({ echo: 0 });
    selectPreset("A", "nope");
    expect(deck("A").preset).toBe("bit-crusher");
  });

  test("favourites toggle; unknown ids are ignored", () => {
    toggleFavourite("echo");
    expect(getFxRack().favourites).not.toContain("echo");
    toggleFavourite("echo");
    expect(getFxRack().favourites.at(-1)).toBe("echo");
    toggleFavourite("nope");
    expect(getFxRack().favourites).toHaveLength(DEFAULT_FAVOURITES.length);
  });

  test("subscribers hear changes and slices keep their identity", () => {
    let calls = 0;
    const off = subscribe(() => { calls++; });
    const b = deck("B");
    setAmount("A", 0.1);
    setAmount("A", 0.1);
    expect(calls).toBe(1);
    expect(deck("B")).toBe(b);
    off();
  });
});

describe("hold, latch and phrase release", () => {
  test("a hold becomes a latch on a short press, and a latch releases on the next press", () => {
    selectPreset("A", "echo");
    engage("A", "hold");
    expect(deck("A")).toMatchObject({ on: true, held: true });
    expect(getFxRack().lastEngaged).toBe("A");
    latchHeld("A");
    expect(deck("A")).toMatchObject({ on: true, held: false });
    release("A");
    expect(deck("A")).toMatchObject({ on: false, held: false, releasing: false });
  });

  test("a hold releases at once, even on a phrase preset", () => {
    selectPreset("A", "gate");
    engage("A", "hold");
    release("A");
    expect(deck("A").on).toBe(false);
  });

  test("a latched P preset waits for the phrase beat; a second press releases now", () => {
    selectPreset("A", "gate");
    engage("A", "latch");
    release("A");
    expect(deck("A")).toMatchObject({ on: true, releasing: true });
    release("A");
    expect(deck("A")).toMatchObject({ on: false, releasing: false });
  });

  test("the node ending the effect completes a pending phrase release", () => {
    selectPreset("B", "lift");
    engage("B", "latch");
    release("B");
    setNodeState("B", { engaged: true, tail: true });
    expect(deck("B")).toMatchObject({ on: true, releasing: true, tail: true });
    setNodeState("B", { engaged: false, tail: true });
    expect(deck("B")).toMatchObject({ on: false, releasing: false, tail: true });
    setNodeState("B", { engaged: false, tail: false });
    expect(deck("B").tail).toBe(false);
  });

  test("a stale engaged:false does not turn off a latch that is not releasing", () => {
    engage("A", "latch");
    setNodeState("A", { engaged: false, tail: false });
    expect(deck("A").on).toBe(true);
  });

  test("a latch the node ended by itself (a Φ line, Reverse's cap) turns off, and the next press engages again", () => {
    selectPreset("A", "lift");
    engage("A", "latch");
    setNodeState("A", { engaged: true, tail: false });
    setNodeState("A", { engaged: false, tail: true });
    expect(deck("A")).toMatchObject({ on: false, held: false, releasing: false, tail: true });
    engage("A", "latch");
    expect(deck("A")).toMatchObject({ on: true, releasing: false });
    // A stale engaged:false from the old voice, before the node acknowledges this engage, leaves it on.
    setNodeState("A", { engaged: false, tail: true });
    expect(deck("A").on).toBe(true);
    // A hold stays on while it is held.
    setNodeState("A", { engaged: true, tail: false });
    engage("A", "hold");
    setNodeState("A", { engaged: false, tail: true });
    expect(deck("A")).toMatchObject({ on: true, held: true });
  });

  test("phrase release off, `now`, or a non-P preset release at once; re-engage cancels the wait", () => {
    selectPreset("A", "gate");
    setPhraseRelease("A", false);
    engage("A", "latch");
    release("A");
    expect(deck("A").on).toBe(false);
    setPhraseRelease("A", true);
    engage("A", "latch");
    release("A");
    engage("A", "latch");
    expect(deck("A")).toMatchObject({ on: true, releasing: false });
    release("A", true);
    expect(deck("A").on).toBe(false);
    selectPreset("A", "echo");
    engage("A", "latch");
    release("A");
    expect(deck("A").on).toBe(false);
  });

  test("a preset change while on switches live", () => {
    engage("A", "latch");
    selectPreset("A", "roll");
    expect(deck("A")).toMatchObject({ preset: "roll", on: true });
  });

  test("releaseHeld ends holds and leaves latches", () => {
    engage("A", "hold");
    engage("B", "latch");
    releaseHeld();
    expect(deck("A").on).toBe(false);
    expect(deck("B").on).toBe(true);
  });

  test("unavailable: engage is ignored and both decks turn off", () => {
    engage("A", "latch");
    setNodeState("A", { engaged: true, tail: true });
    setAvailable(false);
    expect(deck("A")).toMatchObject({ on: false, tail: false });
    engage("B", "hold");
    expect(deck("B").on).toBe(false);
    setAvailable(true);
    engage("B", "hold");
    expect(deck("B").on).toBe(true);
  });
});

describe("controller", () => {
  test("target: decks whose effect is on, else the last engaged, else A", () => {
    expect(controllerTargets()).toEqual(["A"]);
    engage("B", "latch");
    expect(controllerTargets()).toEqual(["B"]);
    engage("A", "latch");
    expect(controllerTargets()).toEqual(["A", "B"]);
    release("A");
    release("B");
    expect(controllerTargets()).toEqual(["A"]);
  });

  test("paddles: 1 latches, 2 holds, 0 releases (a hold at once)", () => {
    selectPreset("A", "gate");
    paddle("A", 1);
    expect(deck("A")).toMatchObject({ on: true, held: false });
    paddle("A", 0);
    expect(deck("A")).toMatchObject({ on: true, releasing: true });
    paddle("A", 0);
    expect(deck("A").on).toBe(false);
    paddle("A", 2);
    expect(deck("A")).toMatchObject({ on: true, held: true });
    paddle("A", 0);
    expect(deck("A").on).toBe(false);
  });

  test("a dump value does not overwrite the amount; a near value or a crossing picks up", () => {
    controllerAmount(0.1); // the connect dump, far from 0.7
    expect(deck("A").amount).toBe(0.7);
    controllerAmount(0.4);
    expect(deck("A").amount).toBe(0.7);
    controllerAmount(0.72); // within 0.03
    expect(deck("A").amount).toBe(0.72);
    controllerAmount(0.9); // follows once picked up
    expect(deck("A").amount).toBe(0.9);
    setAmount("A", 0.5); // the on-screen knob moved it
    controllerAmount(0.95);
    expect(deck("A").amount).toBe(0.5);
    controllerAmount(0.3); // crossed 0.5 between two reports
    expect(deck("A").amount).toBe(0.3);
  });

  test("each target deck picks up on its own, also after a target change", () => {
    setAmount("A", 0.2);
    setAmount("B", 0.8);
    engage("A", "latch");
    engage("B", "latch");
    controllerAmount(0.21);
    expect([deck("A").amount, deck("B").amount]).toEqual([0.21, 0.8]);
    controllerAmount(0.5);
    expect([deck("A").amount, deck("B").amount]).toEqual([0.5, 0.8]);
    release("A");
    controllerAmount(0.6); // B is the only target now and 0.6 has not reached 0.8
    expect([deck("A").amount, deck("B").amount]).toEqual([0.5, 0.8]);
    controllerAmount(0.85);
    expect(deck("B").amount).toBe(0.85);
  });

  test("a disconnect forgets the knob, so the next dump cannot cross", () => {
    controllerAmount(0.1);
    controllerDisconnected();
    controllerAmount(0.9); // would cross 0.7 from 0.1 without the disconnect
    expect(deck("A").amount).toBe(0.7);
  });

  test("a disconnect ends holds only", () => {
    engage("A", "hold");
    engage("B", "latch");
    controllerDisconnected();
    expect([deck("A").on, deck("B").on]).toEqual([false, true]);
  });

  test("Beats steps every target by the sign of the delta", () => {
    selectPreset("A", "echo");
    selectPreset("B", "echo");
    engage("A", "latch");
    engage("B", "latch");
    controllerBeats(-3);
    expect([deckBeatsIndex(deck("A")), deckBeatsIndex(deck("B"))]).toEqual([2, 2]);
    controllerBeats(0);
    expect(deckBeatsIndex(deck("A"))).toBe(2);
  });
});
