import { describe, expect, test } from "bun:test";
import { JOG_SECONDS_PER_TICK, createDeckBus, createMidiState, decodeMidi, type DeckCommand } from "../src/lib/midi";

const k = (key: string, code: string, shiftKey = false) => ({ kind: "key", key, code, shiftKey });
const tag = { tagRoute: true };
const deck = (d: "A" | "B", cmd: string, value = 0) => ({ kind: "deck", deck: d, cmd, value });

describe("decodeMidi", () => {
  // v1 -> v2 changes: Play is now a deck command (was Space), jog is a seek (was arrow keys),
  // Load is load-deck (was add-to-set), pads are deck pads off /tag.
  test("play toggles the matching deck", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0, 127], s)).toEqual([deck("A", "toggle")]);
    expect(decodeMidi([0x91, 0, 127], s)).toEqual([deck("B", "toggle")]);
    expect(decodeMidi([0x90, 0, 0], s)).toEqual([]);
  });

  test("pads are deck cue pads, but keep v1 keys on /tag", () => {
    const s = createMidiState();
    expect(decodeMidi([0x94, 0x16, 127], s)).toEqual([deck("A", "pad", 2)]);
    expect(decodeMidi([0x95, 0x1b, 127], s)).toEqual([deck("B", "pad", 7)]);
    expect(decodeMidi([0x94, 0x1e, 127], s)).toEqual([]);
    expect(decodeMidi([0x94, 0x16, 127], s, tag)).toEqual([k("3", "Digit3")]);
    expect(decodeMidi([0x94, 0x1e, 127], s, tag)).toEqual([k("3", "Digit3", true)]);
    expect(decodeMidi([0x95, 0x14, 127], s, tag)).toEqual([k("a", "KeyA")]);
  });

  test("browse turn and push (note 0x06 or 0x07)", () => {
    const s = createMidiState();
    expect(decodeMidi([0xbf, 0, 1], s)).toEqual([k("j", "KeyJ")]);
    expect(decodeMidi([0xbf, 0, 0x7f], s)).toEqual([k("k", "KeyK")]);
    for (const note of [0x06, 0x07]) expect(decodeMidi([0x9f, note, 127], s)).toEqual([{ kind: "action", action: { type: "load" } }]);
  });

  test("jog seeks the deck, x10 with shift", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 6, 2], s)).toEqual([deck("A", "seek", 2 * JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb1, 6, 0x7f], s)).toEqual([deck("B", "seek", -JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb0, 6, 0], s)).toEqual([]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0xb0, 6, 1], s)).toEqual([deck("A", "seek", 10 * JOG_SECONDS_PER_TICK)]);
  });

  test("load button: deck load, shift adds to set", () => {
    const s = createMidiState();
    expect(decodeMidi([0x9f, 0x02, 127], s)).toEqual([{ kind: "action", action: { type: "load-deck", deck: "A" } }]);
    expect(decodeMidi([0x9f, 0x03, 127], s)).toEqual([{ kind: "action", action: { type: "load-deck", deck: "B" } }]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0x9f, 0x02, 127], s)).toEqual([{ kind: "action", action: { type: "add-to-set" } }]);
    decodeMidi([0x90, 0x20, 0], s);
    expect(decodeMidi([0x9f, 0x02, 0], s)).toEqual([]);
  });

  test("faders and crossfader are mixer outputs", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 0x1c, 127], s)).toEqual([{ kind: "mixer", control: "volume", deck: "A", value: 1 }]);
    expect(decodeMidi([0xb1, 0x1c, 0], s)).toEqual([{ kind: "mixer", control: "volume", deck: "B", value: 0 }]);
    expect(decodeMidi([0xbf, 0x08, 0], s)).toEqual([{ kind: "mixer", control: "crossfader", value: -1 }]);
    expect(decodeMidi([0xbf, 0x08, 127], s)).toEqual([{ kind: "mixer", control: "crossfader", value: 1 }]);
    expect(decodeMidi([0xbf, 0x09, 64], s)).toEqual([]);
  });
});

describe("createDeckBus", () => {
  function setup() {
    const emitted: DeckCommand[] = [];
    let task: (() => void) | null = null;
    const bus = createDeckBus(c => emitted.push(c), {
      set: fn => { task = fn; return 1; },
      clear: () => { task = null; },
    });
    return { bus, emitted, tick: () => { const t = task; task = null; t?.(); } };
  }

  test("separate single-message jog batches within one interval produce one seek per deck", () => {
    const { bus, emitted, tick } = setup();
    for (let i = 0; i < 5; i++) bus.send({ deck: "A", cmd: "seek", value: 0.1 });
    bus.send({ deck: "B", cmd: "seek", value: -0.2 });
    expect(emitted).toEqual([]);
    tick();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ deck: "A", cmd: "seek" });
    expect(emitted[0].value).toBeCloseTo(0.5);
    expect(emitted[1]).toEqual({ deck: "B", cmd: "seek", value: -0.2 });
    tick();
    expect(emitted).toHaveLength(2);
  });

  test("a pad flushes pending seeks first, preserving order", () => {
    const { bus, emitted } = setup();
    bus.send({ deck: "A", cmd: "seek", value: 1 });
    bus.send({ deck: "A", cmd: "pad", value: 2 });
    expect(emitted).toEqual([{ deck: "A", cmd: "seek", value: 1 }, { deck: "A", cmd: "pad", value: 2 }]);
  });
});
