import { describe, expect, test } from "bun:test";
import { BROWSE_SHIFT_MULTIPLIER, GUARDED_DECK_COMMANDS, isDeckCommandBlocked, JOG_SECONDS_PER_TICK, PITCH_TOP_IS_SLOWER, LOAD_HOLD_MS, createDeckBus, createMidiState, decodeMidi, type DeckCommand } from "../src/lib/midi";

const k = (key: string, code: string, shiftKey = false) => ({ kind: "key", key, code, shiftKey });
const tag = { tagRoute: true, now: 0 };
const deck = (d: "A" | "B", cmd: string, value = 0) => ({ kind: "deck", deck: d, cmd, value });

describe("decodeMidi", () => {
  // v1 -> v2 changes: Play is now a deck command (was Space), jog is a seek (was arrow keys),
  // Load is tap = load-deck / hold = add-to-set (was add-to-set), pads are deck pads off /tag.
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

  test("browse turn is a browse action; BF 01 (Shift) scrolls x10", () => {
    const s = createMidiState();
    const browse = (delta: number) => [{ kind: "action", action: { type: "browse", delta } }];
    expect(decodeMidi([0xbf, 0, 1], s)).toEqual(browse(1));
    expect(decodeMidi([0xbf, 0, 0x7f], s)).toEqual(browse(-1));
    expect(decodeMidi([0xbf, 0, 3], s)).toEqual(browse(3));
    expect(decodeMidi([0xbf, 1, 1], s)).toEqual(browse(BROWSE_SHIFT_MULTIPLIER));
    expect(decodeMidi([0xbf, 1, 0x7f], s)).toEqual(browse(-BROWSE_SHIFT_MULTIPLIER));
    expect(decodeMidi([0xbf, 0, 0], s)).toEqual([]);
  });

  test("browse push: 07 (unshifted) plays, 06 (Shift) cycles list focus; releases are ignored", () => {
    const s = createMidiState();
    expect(decodeMidi([0x9f, 0x07, 127], s)).toEqual([{ kind: "action", action: { type: "play" } }]);
    expect(decodeMidi([0x9f, 0x06, 127], s)).toEqual([{ kind: "action", action: { type: "cycle-focus" } }]);
    expect(decodeMidi([0x9f, 0x07, 0], s)).toEqual([]);
    expect(decodeMidi([0x8f, 0x06, 0], s)).toEqual([]);
  });

  test("Shift + Load ejects, decided at press (same notes 02/03)", () => {
    const s = createMidiState();
    const at = (now: number) => ({ tagRoute: false, now });
    const eject = (deck: "A" | "B") => [{ kind: "action", action: { type: "eject", deck } }];
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0x9f, 0x02, 127], s, at(1000))).toEqual(eject("A"));
    expect(decodeMidi([0x8f, 0x02, 0], s, at(1100))).toEqual([]);
    expect(decodeMidi([0x9f, 0x03, 127], s, at(2000))).toEqual(eject("B"));
    // Shift released mid-hold: still only the eject, no load/add-to-set on release
    decodeMidi([0x80, 0x20, 0], s);
    expect(decodeMidi([0x8f, 0x03, 0], s, at(2000 + LOAD_HOLD_MS + 500))).toEqual([]);
  });

  test("Shift pressed after Load press does not turn the tap into an eject", () => {
    const s = createMidiState();
    const at = (now: number) => ({ tagRoute: false, now });
    expect(decodeMidi([0x9f, 0x02, 127], s, at(1000))).toEqual([]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0x8f, 0x02, 0], s, at(1100))).toEqual([{ kind: "action", action: { type: "load-deck", deck: "A" } }]);
    // and a Shift released during the hold still resolves a long hold as add-to-set
    decodeMidi([0x80, 0x20, 0], s);
    expect(decodeMidi([0x9f, 0x02, 127], s, at(3000))).toEqual([]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0x8f, 0x02, 0], s, at(3000 + LOAD_HOLD_MS))).toEqual([{ kind: "action", action: { type: "add-to-set" } }]);
  });

  test("guarded deck commands are blocked only while a surface is open", () => {
    expect(isDeckCommandBlocked("seek", true)).toBe(false);
    expect(GUARDED_DECK_COMMANDS.has("toggle")).toBe(false);
    expect(isDeckCommandBlocked("toggle", false)).toBe(false);
  });

  test("jog seeks the deck, x10 with shift", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 6, 2], s)).toEqual([deck("A", "seek", 2 * JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb1, 6, 0x7f], s)).toEqual([deck("B", "seek", -JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb0, 6, 0], s)).toEqual([]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0xb0, 6, 1], s)).toEqual([deck("A", "seek", 10 * JOG_SECONDS_PER_TICK)]);
  });

  test("load button: tap loads the deck, hold adds to set, press alone emits nothing", () => {
    const s = createMidiState();
    const at = (now: number) => ({ tagRoute: false, now });
    expect(decodeMidi([0x9f, 0x02, 127], s, at(1000))).toEqual([]);
    expect(decodeMidi([0x9f, 0x02, 0], s, at(1100))).toEqual([{ kind: "action", action: { type: "load-deck", deck: "A" } }]);
    expect(decodeMidi([0x9f, 0x03, 127], s, at(2000))).toEqual([]);
    expect(decodeMidi([0x8f, 0x03, 0], s, at(2000 + LOAD_HOLD_MS - 1))).toEqual([{ kind: "action", action: { type: "load-deck", deck: "B" } }]);
    expect(decodeMidi([0x9f, 0x02, 127], s, at(3000))).toEqual([]);
    expect(decodeMidi([0x8f, 0x02, 0], s, at(3000 + LOAD_HOLD_MS))).toEqual([{ kind: "action", action: { type: "add-to-set" } }]);
    expect(decodeMidi([0x8f, 0x02, 0], s, at(9000))).toEqual([]);
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

describe("decodeMidi deck fx", () => {
  const mixer = (o: object) => ({ kind: "mixer", ...o });
  test("EQ and filter CCs per deck, centred at 64", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 0x17, 127], s)).toEqual([mixer({ control: "eq", deck: "A", band: "hi", value: 1 })]);
    expect(decodeMidi([0xb1, 0x18, 0], s)).toEqual([mixer({ control: "eq", deck: "B", band: "mid", value: -1 })]);
    expect(decodeMidi([0xb0, 0x19, 64], s)).toEqual([mixer({ control: "eq", deck: "A", band: "lo", value: 0 })]);
    expect(decodeMidi([0xb1, 0x1a, 64], s)).toEqual([mixer({ control: "filter", deck: "B", value: 0 })]);
  });
  test("pitch: coarse byte emits nothing, fine byte emits the 14-bit value", () => {
    const s = createMidiState();
    const sign = PITCH_TOP_IS_SLOWER ? 1 : -1;
    expect(decodeMidi([0xb0, 0x09, 127], s)).toEqual([]);
    expect(decodeMidi([0xb0, 0x29, 127], s)).toEqual([mixer({ control: "pitch", deck: "A", value: sign })]);
    expect(decodeMidi([0xb0, 0x09, 0], s)).toEqual([]);
    expect(decodeMidi([0xb0, 0x29, 0], s)).toEqual([mixer({ control: "pitch", deck: "A", value: -sign })]);
    decodeMidi([0xb0, 0x09, 64], s);
    const [mid] = decodeMidi([0xb0, 0x29, 0], s) as { value: number }[];
    expect(Math.abs(mid.value)).toBeLessThan(0.001);
  });
  test("an orphan fine byte is ignored, decks interleave, a disconnect-style reset forgets the coarse byte", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 0x29, 50], s)).toEqual([]);
    decodeMidi([0xb0, 0x09, 127], s);
    expect(decodeMidi([0xb1, 0x29, 50], s)).toEqual([]);
    decodeMidi([0xb1, 0x09, 0], s);
    const [b] = decodeMidi([0xb1, 0x29, 0], s) as { deck: string; value: number }[];
    const [a] = decodeMidi([0xb0, 0x29, 127], s) as { deck: string; value: number }[];
    expect([a.deck, b.deck]).toEqual(["A", "B"]);
    expect(a.value).toBe(-b.value);
    s.pitchMsb = { A: null, B: null };
    expect(decodeMidi([0xb0, 0x29, 1], s)).toEqual([]);
  });
  test("bend: press sets the direction, any release clears it", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0x0b, 127], s)).toEqual([mixer({ control: "bend", deck: "A", dir: 1 })]);
    expect(decodeMidi([0x91, 0x0c, 127], s)).toEqual([mixer({ control: "bend", deck: "B", dir: -1 })]);
    for (const [status, note] of [[0x80, 0x0b], [0x81, 0x0c], [0x90, 0x0c], [0x80, 0x2b], [0x81, 0x2c], [0x91, 0x2b]]) {
      expect(decodeMidi([status, note, 0], s)).toEqual([mixer({ control: "bend", deck: status & 1 ? "B" : "A", dir: 0 })]);
    }
  });
  test("shift + bend: 0x2B press toggles key lock, 0x2C press does nothing", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0x2b, 127], s)).toEqual([mixer({ control: "keylock", deck: "A" })]);
    expect(decodeMidi([0x91, 0x2b, 127], s)).toEqual([mixer({ control: "keylock", deck: "B" })]);
    expect(decodeMidi([0x90, 0x2c, 127], s)).toEqual([]);
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
