import { describe, expect, test } from "bun:test";
import { announceKnob, createKnobMoves, KNOB_FLASH_MS, KNOB_ID, knobMove, watchKnobFlash } from "../src/lib/knobFlash";
import { createMidiState, decodeMidi, type MidiOutput } from "../src/lib/midi";
import { setDeckEq, setDeckFilter } from "../src/lib/mixer";

/** A manual clock: `advance` runs the timers that fall due. */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => { pending.set(++next, { at: now + ms, fn }); return next; },
      clear: (h: unknown) => { pending.delete(h as number); },
    },
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { pending.delete(h); t.fn(); }
    },
    get count() { return pending.size; },
  };
}

const decode = (msg: [number, number, number]) => decodeMidi(msg, createMidiState());

describe("which knob a controller message turns", () => {
  test("EQ, TRIM and FILTER name their deck and band", () => {
    expect(knobMove(decode([0xb0, 0x17, 100])[0])?.id).toBe(KNOB_ID.eq("A", "hi"));
    expect(knobMove(decode([0xb1, 0x19, 10])[0])?.id).toBe(KNOB_ID.eq("B", "lo"));
    expect(knobMove(decode([0xb1, 0x18, 10])[0])?.id).toBe("eq:B:mid");
    expect(knobMove(decode([0xb0, 0x16, 90])[0])?.id).toBe(KNOB_ID.trim("A"));
    expect(knobMove(decode([0xb1, 0x1a, 90])[0])?.id).toBe(KNOB_ID.filter("B"));
  });
  test("the headphone knobs and the one Wet/Dry knob", () => {
    expect(knobMove(decode([0xbf, 0x0c, 64])[0])?.id).toBe(KNOB_ID.cueGain);
    expect(knobMove(decode([0xbf, 0x0d, 64])[0])?.id).toBe(KNOB_ID.cueMix);
    expect(knobMove(decode([0xb8, 0x04, 64])[0])).toEqual({ id: KNOB_ID.fxWet, value: 64 / 127 });
  });
  test("faders, the jog, buttons and the Beats encoder turn no knob", () => {
    for (const msg of [[0xb0, 0x1c, 64], [0xbf, 0x08, 64], [0xbe, 0x23, 64], [0xb0, 0x06, 1], [0x90, 0x00, 127], [0xb8, 0x05, 1]] as [number, number, number][]) {
      for (const o of decode(msg)) expect(knobMove(o)).toBeNull();
    }
  });
});

describe("the bridge announces a knob only when the controller moves it", () => {
  const eq = (value: number, deck: "A" | "B" = "A"): MidiOutput => ({ kind: "mixer", control: "eq", deck, band: "hi", value });
  test("the first value after a connect is the baseline; a new value announces; the same value does not", () => {
    const seen: string[] = [];
    const moves = createKnobMoves(id => seen.push(id));
    moves.note(eq(0.1)); // the position dump
    expect(seen).toEqual([]);
    moves.note(eq(0.2));
    moves.note(eq(0.2));
    expect(seen).toEqual(["eq:A:hi"]);
    moves.note(eq(0.5, "B")); // deck B's own baseline
    expect(seen).toEqual(["eq:A:hi"]);
    moves.reset(); // disconnect: the next dump is a baseline again
    moves.note(eq(0.9));
    expect(seen).toEqual(["eq:A:hi"]);
  });
});

describe("a knob's pill on a controller move", () => {
  test(`shows at once and hides ${KNOB_FLASH_MS} ms after the last move`, () => {
    const clock = fakeTimers();
    const shown: boolean[] = [];
    const stop = watchKnobFlash(KNOB_ID.eq("A", "lo"), on => shown.push(on), clock.timers);
    expect(clock.count).toBe(0); // no timer until the controller moves it
    announceKnob(KNOB_ID.eq("A", "lo"));
    expect(shown).toEqual([true]);
    clock.advance(KNOB_FLASH_MS - 100);
    announceKnob(KNOB_ID.eq("A", "lo")); // still turning: the hide moves on
    clock.advance(KNOB_FLASH_MS - 1);
    expect(shown).toEqual([true, true]);
    clock.advance(1);
    expect(shown).toEqual([true, true, false]);
    expect(clock.count).toBe(0);
    stop();
  });
  test("only the knob of that control and deck shows", () => {
    const shown: string[] = [];
    const stops = [KNOB_ID.eq("A", "lo"), KNOB_ID.eq("B", "lo"), KNOB_ID.eq("A", "hi"), KNOB_ID.filter("A")]
      .map(id => watchKnobFlash(id, on => on && shown.push(id), fakeTimers().timers));
    announceKnob(KNOB_ID.eq("B", "lo"));
    expect(shown).toEqual(["eq:B:lo"]);
    stops.forEach(s => s());
  });
  test("a change that does not come from the controller (a transition, deck rescue, a reset) shows nothing", () => {
    const clock = fakeTimers();
    const shown: boolean[] = [];
    const stop = watchKnobFlash(KNOB_ID.eq("A", "lo"), on => shown.push(on), clock.timers);
    setDeckEq("A", "lo", -0.4);
    setDeckFilter("A", 0.3);
    setDeckEq("A", "lo", 0);
    setDeckFilter("A", 0);
    expect(shown).toEqual([]);
    expect(clock.count).toBe(0);
    stop();
  });
  test("unmounting unsubscribes and clears the pending hide", () => {
    const clock = fakeTimers();
    const shown: boolean[] = [];
    const stop = watchKnobFlash(KNOB_ID.trim("B"), on => shown.push(on), clock.timers);
    announceKnob(KNOB_ID.trim("B"));
    stop();
    expect(clock.count).toBe(0);
    announceKnob(KNOB_ID.trim("B"));
    clock.advance(KNOB_FLASH_MS);
    expect(shown).toEqual([true]);
  });
});
