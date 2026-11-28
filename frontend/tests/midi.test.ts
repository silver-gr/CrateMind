import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deckBeatsIndex, getFxRack, resetFxRack } from "../src/lib/fxRack";
import { resetLastPlayingDeck } from "../src/lib/lastPlayingDeck";
import { BROWSE_SHIFT_MULTIPLIER, CUE_GAIN_CC, CUE_MIX_CC, GUARDED_DECK_COMMANDS, isDeckCommandBlocked, JOG_FLUSH_MS, JOG_NUDGE_RELEASE_MS, JOG_SECONDS_PER_TICK, JOG_SHIFT_SECONDS_PER_TICK, PITCH_TOP_IS_SLOWER, LOAD_HOLD_MS, PADDLE_HOLD, PADDLE_LATCH, PADDLE_RELEASE, createDeckBus, createJogNudge, createMidiState, decodeMidi, installMidiBridge, nudgeAllowed, type DeckCommand } from "../src/lib/midi";
import { registerDeckTransport, setTransportOwner, type DeckTransport } from "../src/lib/mix/deckTransport";
import { getMixer, resetMixer } from "../src/lib/mixer";
import { resetPrefs, setPref } from "../src/lib/prefs";

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
    expect(decodeMidi([0x94, 0x1e, 127], s)).toEqual([deck("A", "pad-delete", 2)]);
    expect(decodeMidi([0x95, 0x23, 127], s)).toEqual([deck("B", "pad-delete", 7)]);
    expect(decodeMidi([0x94, 0x24, 127], s)).toEqual([]);
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

  test("with a dialog open, Cue press and pad delete are blocked while Cue release always gets through", () => {
    for (const cmd of ["cue", "pad-delete"] as const) {
      expect(isDeckCommandBlocked(cmd, true)).toBe(true);
      expect(isDeckCommandBlocked(cmd, false)).toBe(false);
    }
    expect(isDeckCommandBlocked("cue-release", true)).toBe(false);
    expect(GUARDED_DECK_COMMANDS.has("cue-release")).toBe(false);
    // End to end through the decoder: the release of either Cue note is the unguarded command.
    const s = createMidiState();
    for (const note of [0x01, 0x05]) {
      const [release] = decodeMidi([0x80, note, 0], s) as { cmd: DeckCommand["cmd"] }[];
      expect(isDeckCommandBlocked(release.cmd, true)).toBe(false);
    }
    expect(isDeckCommandBlocked((decodeMidi([0x90, 0x05, 127], s)[0] as { cmd: DeckCommand["cmd"] }).cmd, true)).toBe(true);
  });

  test("pad mode buttons switch the deck's bank: Cue 00/02, Auto Loop 0D = tag, Sampler 0B/0F = status", () => {
    const s = createMidiState();
    const bank = (d: "A" | "B", b: string) => ({ kind: "bank", deck: d, bank: b });
    expect(decodeMidi([0x94, 0x0d, 127], s)).toEqual([bank("A", "tag")]);
    expect(decodeMidi([0x95, 0x0b, 127], s)).toEqual([bank("B", "status")]);
    expect(s.bank).toEqual({ A: "tag", B: "status" });
    expect(decodeMidi([0x95, 0x0f, 127], s)).toEqual([bank("B", "status")]);
    expect(decodeMidi([0x94, 0x02, 127], s)).toEqual([bank("A", "cue")]);
    expect(decodeMidi([0x94, 0x00, 127], s)).toEqual([bank("A", "cue")]);
    expect(decodeMidi([0x94, 0x0d, 0], s)).toEqual([]); // release
    expect(decodeMidi([0x94, 0x07, 127], s)).toEqual([]); // not a bank we use
  });

  test("tag bank pads: 1-8 = energy 0-7, Shift + pad = darkness 8-15; status bank pads 0-6; the other deck is unaffected", () => {
    const s = createMidiState();
    decodeMidi([0x94, 0x0d, 127], s);
    expect(decodeMidi([0x94, 0x14, 127], s)).toEqual([deck("A", "tag", 0)]);
    expect(decodeMidi([0x94, 0x1b, 127], s)).toEqual([deck("A", "tag", 7)]);
    expect(decodeMidi([0x94, 0x1c, 127], s)).toEqual([deck("A", "tag", 8)]);
    expect(decodeMidi([0x94, 0x23, 127], s)).toEqual([deck("A", "tag", 15)]);
    expect(decodeMidi([0x95, 0x14, 127], s)).toEqual([deck("B", "pad", 0)]); // B is still on Cue
    decodeMidi([0x95, 0x0b, 127], s);
    expect(decodeMidi([0x95, 0x16, 127], s)).toEqual([deck("B", "status", 2)]);
    expect(decodeMidi([0x95, 0x1a, 127], s)).toEqual([deck("B", "status", 6)]);
    expect(decodeMidi([0x95, 0x1b, 127], s)).toEqual([]); // pad 8 has no status key
    expect(decodeMidi([0x95, 0x1e, 127], s)).toEqual([]); // Shift + pad does nothing there
    decodeMidi([0x94, 0x00, 127], s);
    expect(decodeMidi([0x94, 0x1c, 127], s)).toEqual([deck("A", "pad-delete", 0)]); // back on Cue
  });

  test("/tag keeps its keys whatever the bank", () => {
    const s = createMidiState();
    decodeMidi([0x94, 0x0d, 127], s);
    expect(decodeMidi([0x94, 0x16, 127], s, tag)).toEqual([k("3", "Digit3")]);
    decodeMidi([0x95, 0x0b, 127], s);
    expect(decodeMidi([0x95, 0x14, 127], s, tag)).toEqual([k("a", "KeyA")]);
  });

  test("loop row: 40 on/off, 34 half, 35 double, Shift 36 loop in / 37 loop out, 41 unused", () => {
    const s = createMidiState();
    expect(decodeMidi([0x94, 0x40, 127], s)).toEqual([deck("A", "loop-toggle")]);
    expect(decodeMidi([0x95, 0x34, 127], s)).toEqual([deck("B", "loop-half")]);
    expect(decodeMidi([0x95, 0x35, 127], s)).toEqual([deck("B", "loop-double")]);
    expect(decodeMidi([0x94, 0x36, 127], s)).toEqual([deck("A", "loop-in")]);
    expect(decodeMidi([0x94, 0x37, 127], s)).toEqual([deck("A", "loop-out")]);
    expect(decodeMidi([0x94, 0x41, 127], s)).toEqual([]);
    expect(decodeMidi([0x94, 0x40, 0], s)).toEqual([]);
  });

  test("FX select: unit 1 = 98 00-02, unit 2 = 99 03-05, as good / ok / clash", () => {
    const s = createMidiState();
    expect([0, 1, 2].map(n => decodeMidi([0x98, n, 127], s))).toEqual([[deck("A", "note", 0)], [deck("A", "note", 1)], [deck("A", "note", 2)]]);
    expect([3, 4, 5].map(n => decodeMidi([0x99, n, 127], s))).toEqual([[deck("B", "note", 0)], [deck("B", "note", 1)], [deck("B", "note", 2)]]);
    expect(decodeMidi([0x98, 0, 0], s)).toEqual([]);
    expect(decodeMidi([0x98, 3, 127], s)).toEqual([]);
    expect(decodeMidi([0x99, 0, 127], s)).toEqual([]);
  });

  test("with a dialog open, tag/status bank writes and transition notes are blocked; loops and Cue release are not", () => {
    for (const cmd of ["tag", "status", "note"] as const) {
      expect(isDeckCommandBlocked(cmd, true)).toBe(true);
      expect(isDeckCommandBlocked(cmd, false)).toBe(false);
    }
    for (const cmd of ["loop-toggle", "loop-half", "loop-double", "loop-in", "loop-out", "cue-release"] as const) expect(isDeckCommandBlocked(cmd, true)).toBe(false);
    const s = createMidiState();
    decodeMidi([0x94, 0x0d, 127], s);
    expect(isDeckCommandBlocked((decodeMidi([0x94, 0x14, 127], s)[0] as { cmd: DeckCommand["cmd"] }).cmd, true)).toBe(true);
    expect(isDeckCommandBlocked((decodeMidi([0x98, 1, 127], s)[0] as { cmd: DeckCommand["cmd"] }).cmd, true)).toBe(true);
  });

  test("Cue: 01 press, Shift + Cue 05 press, either release", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0x01, 127], s)).toEqual([deck("A", "cue", 0)]);
    expect(decodeMidi([0x91, 0x01, 127], s)).toEqual([deck("B", "cue", 0)]);
    expect(decodeMidi([0x90, 0x05, 127], s)).toEqual([deck("A", "cue", 1)]);
    expect(decodeMidi([0x91, 0x05, 127], s)).toEqual([deck("B", "cue", 1)]);
    for (const [status, note] of [[0x80, 0x01], [0x80, 0x05], [0x81, 0x01], [0x81, 0x05], [0x90, 0x01], [0x91, 0x05]]) {
      expect(decodeMidi([status, note, 0], s)).toEqual([deck(status & 1 ? "B" : "A", "cue-release")]);
    }
  });

  test("Cue decided by the note, not by the software Shift state", () => {
    const s = createMidiState();
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0x90, 0x01, 127], s)).toEqual([deck("A", "cue", 0)]);
  });

  test("Sync: 02 press is one-shot, release and Shift + Sync (03) are ignored", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0x02, 127], s)).toEqual([deck("A", "sync")]);
    expect(decodeMidi([0x91, 0x02, 127], s)).toEqual([deck("B", "sync")]);
    expect(decodeMidi([0x90, 0x02, 0], s)).toEqual([]);
    expect(decodeMidi([0x80, 0x02, 0], s)).toEqual([]);
    expect(decodeMidi([0x90, 0x03, 127], s)).toEqual([]);
  });

  test("Cue and Sync on a deck channel do not collide with Load (9F 02/03)", () => {
    const s = createMidiState();
    expect(decodeMidi([0x9f, 0x02, 127], s)).toEqual([]);
    expect(decodeMidi([0x9f, 0x01, 127], s)).toEqual([]);
  });

  test("Shift + pad deletes (off /tag only)", () => {
    const s = createMidiState();
    expect(decodeMidi([0x94, 0x1c, 127], s)).toEqual([deck("A", "pad-delete", 0)]);
    expect(decodeMidi([0x95, 0x1f, 127], s)).toEqual([deck("B", "pad-delete", 3)]);
    expect(decodeMidi([0x94, 0x1c, 127], s, tag)).toEqual([k("1", "Digit1", true)]);
    expect(decodeMidi([0x95, 0x1c, 127], s, tag)).toEqual([]);
  });

  test("trim (Bn 16) is a bipolar mixer control per deck; master (BE 23) is 0..1", () => {
    const s = createMidiState();
    const mixer = (o: object) => ({ kind: "mixer", ...o });
    expect(decodeMidi([0xb0, 0x16, 127], s)).toEqual([mixer({ control: "trim", deck: "A", value: 1 })]);
    expect(decodeMidi([0xb1, 0x16, 0], s)).toEqual([mixer({ control: "trim", deck: "B", value: -1 })]);
    expect(decodeMidi([0xb0, 0x16, 64], s)).toEqual([mixer({ control: "trim", deck: "A", value: 0 })]);
    expect(decodeMidi([0xbe, 0x23, 127], s)).toEqual([mixer({ control: "master", value: 1 })]);
    expect(decodeMidi([0xbe, 0x23, 0], s)).toEqual([mixer({ control: "master", value: 0 })]);
    expect(decodeMidi([0xbe, 0x24, 64], s)).toEqual([]);
  });

  test("headphone knobs: cue gain (BF 0C) and cue mix (BF 0D) are 0..1", () => {
    const s = createMidiState();
    const mixer = (o: object) => ({ kind: "mixer", ...o });
    expect(decodeMidi([0xbf, CUE_GAIN_CC, 127], s)).toEqual([mixer({ control: "cueGain", value: 1 })]);
    expect(decodeMidi([0xbf, CUE_GAIN_CC, 0], s)).toEqual([mixer({ control: "cueGain", value: 0 })]);
    expect(decodeMidi([0xbf, CUE_MIX_CC, 127], s)).toEqual([mixer({ control: "cueMix", value: 1 })]);
    expect(decodeMidi([0xbf, CUE_MIX_CC, 0], s)).toEqual([mixer({ control: "cueMix", value: 0 })]);
    expect([CUE_GAIN_CC, CUE_MIX_CC]).toEqual([0x0c, 0x0d]);
  });

  test("jog seeks the deck at vinyl speed (1.8 s a turn), fast with shift", () => {
    expect(JOG_SECONDS_PER_TICK * 1024).toBeCloseTo(1.8, 6);
    const s = createMidiState();
    expect(decodeMidi([0xb0, 6, 2], s)).toEqual([deck("A", "seek", 2 * JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb1, 6, 0x7f], s)).toEqual([deck("B", "seek", -JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb0, 6, 0], s)).toEqual([]);
    decodeMidi([0x90, 0x20, 127], s);
    expect(decodeMidi([0xb0, 6, 1], s)).toEqual([deck("A", "seek", JOG_SHIFT_SECONDS_PER_TICK)]);
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
  test("shift + bend: 0x2B press toggles key lock, 0x2C press cycles the pitch range", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0x2b, 127], s)).toEqual([mixer({ control: "keylock", deck: "A" })]);
    expect(decodeMidi([0x91, 0x2b, 127], s)).toEqual([mixer({ control: "keylock", deck: "B" })]);
    expect(decodeMidi([0x90, 0x2c, 127], s)).toEqual([deck("A", "range")]);
    expect(decodeMidi([0x91, 0x2c, 127], s)).toEqual([deck("B", "range")]);
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

describe("decodeMidi FX rack controls (Mixxx's bytes)", () => {
  const fx = (o: object) => ({ kind: "fxrack", ...o });
  const paddle = (d: "A" | "B", value: number) => fx({ control: "paddle", deck: d, value });

  test("paddles: B8 03 = A, B9 03 = B; the first value is only a baseline, then each change acts", () => {
    const s = createMidiState();
    expect([PADDLE_RELEASE, PADDLE_LATCH, PADDLE_HOLD]).toEqual([0, 1, 2]);
    // A paddle left latched at launch: the dump's value is stored, nothing engages.
    expect(decodeMidi([0xb8, 0x03, PADDLE_LATCH], s)).toEqual([]);
    expect(decodeMidi([0xb9, 0x03, PADDLE_RELEASE], s)).toEqual([]);
    expect(s.paddle).toEqual({ A: PADDLE_LATCH, B: PADDLE_RELEASE });
    expect(decodeMidi([0xb8, 0x03, PADDLE_LATCH], s)).toEqual([]); // a repeat is not a change
    expect(decodeMidi([0xb8, 0x03, PADDLE_RELEASE], s)).toEqual([paddle("A", 0)]);
    expect(decodeMidi([0xb8, 0x03, PADDLE_HOLD], s)).toEqual([paddle("A", 2)]);
    expect(decodeMidi([0xb9, 0x03, PADDLE_LATCH], s)).toEqual([paddle("B", 1)]);
    expect(decodeMidi([0xb9, 0x03, PADDLE_HOLD], s)).toEqual([paddle("B", 2)]);
    expect(s.paddle).toEqual({ A: PADDLE_HOLD, B: PADDLE_HOLD });
  });

  test("unknown paddle values are ignored and leave the baseline alone", () => {
    const s = createMidiState();
    for (const v of [3, 64, 127]) expect(decodeMidi([0xb8, 0x03, v], s)).toEqual([]);
    expect(s.paddle.A).toBeNull();
    decodeMidi([0xb8, 0x03, PADDLE_RELEASE], s);
    expect(decodeMidi([0xb8, 0x03, 127], s)).toEqual([]);
    expect(s.paddle.A).toBe(PADDLE_RELEASE);
    expect(decodeMidi([0xb8, 0x03, PADDLE_LATCH], s)).toEqual([paddle("A", 1)]);
  });

  test("Wet/Dry B8 04 is an absolute 0..1 amount; Beats B8 05 steps by the sign of the relative turn", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb8, 0x04, 0], s)).toEqual([fx({ control: "amount", value: 0 })]);
    expect(decodeMidi([0xb8, 0x04, 127], s)).toEqual([fx({ control: "amount", value: 1 })]);
    expect(decodeMidi([0xb8, 0x05, 1], s)).toEqual([fx({ control: "beats", value: 1 })]);
    expect(decodeMidi([0xb8, 0x05, 3], s)).toEqual([fx({ control: "beats", value: 1 })]);
    expect(decodeMidi([0xb8, 0x05, 0x7f], s)).toEqual([fx({ control: "beats", value: -1 })]);
    expect(decodeMidi([0xb8, 0x05, 0x7d], s)).toEqual([fx({ control: "beats", value: -1 })]);
    expect(decodeMidi([0xb8, 0x05, 0], s)).toEqual([]);
  });

  test("the knobs are shared on B8 only; other bytes on the FX channels stay inert", () => {
    const s = createMidiState();
    for (const m of [[0xb9, 0x04, 64], [0xb9, 0x05, 1], [0xb8, 0x06, 64], [0xb8, 0x00, 64], [0xba, 0x03, 1], [0x98, 0x03, 127], [0x88, 0x03, 0]] as const) {
      expect(decodeMidi([...m], s)).toEqual([]);
    }
    expect(s.paddle).toEqual({ A: null, B: null });
  });

  test("the FX channels do not reach the deck CCs, and the deck CCs do not reach the FX rack", () => {
    const s = createMidiState();
    // B0/B1 03-05 have no meaning on the deck channels; B8/B9 1C (a volume CC number) is not a fader.
    for (const status of [0xb0, 0xb1]) for (const cc of [0x03, 0x04, 0x05]) expect(decodeMidi([status, cc, 1], s)).toEqual([]);
    expect(decodeMidi([0xb8, 0x1c, 127], s)).toEqual([]);
    expect(decodeMidi([0xb9, 0x09, 64], s)).toEqual([]);
    expect(s.pitchMsb).toEqual({ A: null, B: null });
  });

  test("FX select 98/99 00-05 stay transition notes", () => {
    const s = createMidiState();
    decodeMidi([0xb8, 0x03, PADDLE_RELEASE], s);
    expect(decodeMidi([0x98, 0x01, 127], s)).toEqual([deck("A", "note", 1)]);
    expect(decodeMidi([0x99, 0x05, 127], s)).toEqual([deck("B", "note", 2)]);
  });
});

describe("installMidiBridge FX rack", () => {
  const savedWindow = globalThis.window;
  let uninstall: () => void = () => {};
  const midi = (...msgs: number[][]) => window.dispatchEvent(new CustomEvent("cratemind:midi", { detail: msgs }));
  const status = (connected: boolean) => window.dispatchEvent(new CustomEvent("cratemind:midi-status", { detail: { connected } }));
  const fxDeck = (d: "A" | "B") => getFxRack().decks[d];

  beforeEach(() => {
    resetPrefs();
    resetFxRack();
    resetLastPlayingDeck(); // another test file may have played a deck: the shared FX controls would follow it
    globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/" } }) as unknown as Window & typeof globalThis;
    uninstall = installMidiBridge();
    status(true);
  });
  afterEach(() => {
    status(false);
    uninstall();
    globalThis.window = savedWindow;
    resetFxRack();
  });

  test("a paddle left latched at connect does not engage; moving it does", () => {
    midi([0xb8, 0x03, PADDLE_LATCH]);
    expect(fxDeck("A").on).toBe(false);
    midi([0xb8, 0x03, PADDLE_RELEASE], [0xb8, 0x03, PADDLE_LATCH]);
    expect(fxDeck("A")).toMatchObject({ on: true, held: false });
    midi([0xb9, 0x03, PADDLE_RELEASE], [0xb9, 0x03, PADDLE_HOLD]);
    expect(fxDeck("B")).toMatchObject({ on: true, held: true });
    midi([0xb9, 0x03, PADDLE_RELEASE]);
    expect(fxDeck("B").on).toBe(false);
  });

  test("a repeated connected: true keeps the baselines; a disconnect ends holds, keeps latches and resets the baselines", () => {
    midi([0xb8, 0x03, PADDLE_RELEASE], [0xb9, 0x03, PADDLE_RELEASE]);
    status(true);
    midi([0xb8, 0x03, PADDLE_LATCH], [0xb9, 0x03, PADDLE_HOLD]);
    expect(fxDeck("A")).toMatchObject({ on: true, held: false });
    expect(fxDeck("B")).toMatchObject({ on: true, held: true });
    status(false);
    expect(fxDeck("A").on).toBe(true);
    expect(fxDeck("B").on).toBe(false);
    // After the reconnect, B's paddle still down is a new baseline, not a new hold.
    status(true);
    midi([0xb9, 0x03, PADDLE_HOLD]);
    expect(fxDeck("B").on).toBe(false);
  });

  test("Wet/Dry and Beats act on ONE deck: nothing before a deck played or an FX was turned on, then that deck alone", () => {
    const amounts = [fxDeck("A").amount, fxDeck("B").amount];
    const index = [deckBeatsIndex(fxDeck("A")), deckBeatsIndex(fxDeck("B"))];
    midi([0xb8, 0x04, 0], [0xb8, 0x05, 1]); // the connect dump and a turn with no deck to act on
    expect([fxDeck("A").amount, fxDeck("B").amount]).toEqual(amounts);
    expect([deckBeatsIndex(fxDeck("A")), deckBeatsIndex(fxDeck("B"))]).toEqual(index);
    midi([0xb9, 0x03, PADDLE_RELEASE], [0xb9, 0x03, PADDLE_LATCH]); // Deck B's paddle latches its FX: Deck B is the controller's FX deck
    midi([0xb8, 0x04, 127]);
    expect([fxDeck("A").amount, fxDeck("B").amount]).toEqual([amounts[0], 1]);
    midi([0xb8, 0x05, 1]);
    expect([deckBeatsIndex(fxDeck("A")), deckBeatsIndex(fxDeck("B"))]).toEqual([index[0], index[1] + 1]);
    midi([0xb8, 0x05, 0x7f]);
    expect([deckBeatsIndex(fxDeck("A")), deckBeatsIndex(fxDeck("B"))]).toEqual(index);
  });

  test("the headphone knobs reach the mixer store", () => {
    resetMixer();
    midi([0xbf, CUE_GAIN_CC, 127], [0xbf, CUE_MIX_CC, 0]);
    expect([getMixer().cueGain, getMixer().cueMix]).toEqual([1, 0]);
    resetMixer();
  });
});

describe("jog nudge decoding", () => {
  const mixer = (o: object) => ({ kind: "mixer", ...o });
  const nudgeA = { tagRoute: false, now: 0, nudge: (d: "A" | "B") => d === "A" };
  test("an unshifted turn on a deck that may nudge is a nudge in the turn's direction; every other turn seeks as before", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb0, 6, 2], s, nudgeA)).toEqual([mixer({ control: "nudge", deck: "A", dir: 1 })]);
    expect(decodeMidi([0xb0, 6, 0x7e], s, nudgeA)).toEqual([mixer({ control: "nudge", deck: "A", dir: -1 })]);
    expect(decodeMidi([0xb1, 6, 2], s, nudgeA)).toEqual([deck("B", "seek", 2 * JOG_SECONDS_PER_TICK)]);
    expect(decodeMidi([0xb0, 6, 0], s, nudgeA)).toEqual([]);
    decodeMidi([0x90, 0x20, 0x7f], s);
    expect(decodeMidi([0xb0, 6, 1], s, nudgeA)).toEqual([deck("A", "seek", JOG_SHIFT_SECONDS_PER_TICK)]);
  });

  test("only a jog turn asks; without the question the jog is untouched", () => {
    let asked = 0;
    const ctx = { tagRoute: false, now: 0, nudge: () => { asked++; return true; } };
    const s = createMidiState();
    for (const m of [[0x90, 0, 127], [0xb0, 0x1c, 10], [0xb0, 0x06, 0], [0x90, 0x0b, 127], [0x80, 0x0b, 0], [0xbf, 0x00, 1]] as [number, number, number][]) decodeMidi(m, s, ctx);
    expect(asked).toBe(0);
    expect(decodeMidi([0xb0, 6, 2], createMidiState(), { tagRoute: false, now: 0 })).toEqual([deck("A", "seek", 2 * JOG_SECONDS_PER_TICK)]);
  });
});

describe("createJogNudge", () => {
  function setup() {
    const bends: [string, number, number][] = [];
    let task: (() => void) | null = null;
    let delay = 0;
    const nudge = createJogNudge((d, dir, now) => bends.push([d, dir, now]), {
      set: (fn, ms) => { task = fn; delay = ms; return 1; },
      clear: () => { task = null; },
    });
    return { nudge, bends, delay: () => delay, fire: () => { const t = task; task = null; t?.(); } };
  }

  test("each tick holds the bend; it lets go once, after the last tick's release time", () => {
    const { nudge, bends, delay, fire } = setup();
    nudge.tick("A", 1, 10);
    nudge.tick("A", 1, 20);
    expect(delay()).toBe(JOG_NUDGE_RELEASE_MS);
    expect(nudge.active("A")).toBe(true);
    expect(nudge.active("B")).toBe(false);
    fire();
    expect(bends).toEqual([["A", 1, 10], ["A", 1, 20], ["A", 0, 0]]);
    expect(nudge.active("A")).toBe(false);
    fire();
    expect(bends).toHaveLength(3);
  });

  test("cancel forgets the nudge and leaves the bend to whoever took it", () => {
    const { nudge, bends, fire } = setup();
    nudge.tick("B", -1, 5);
    nudge.cancel("B");
    fire();
    expect(bends).toEqual([["B", -1, 5]]);
    expect(nudge.active("B")).toBe(false);
  });
});

describe("nudgeAllowed", () => {
  const playing = { playing: true, onEngine: true };
  test("only on a deck playing on the engine, not owned by a transition, with a free or nudge-held bend", () => {
    expect(nudgeAllowed(playing, false, 0, false)).toBe(true);
    expect(nudgeAllowed(playing, false, 1, true)).toBe(true);
    expect(nudgeAllowed(null, false, 0, false)).toBe(false);
    expect(nudgeAllowed({ playing: false, onEngine: true }, false, 0, false)).toBe(false);
    expect(nudgeAllowed({ playing: true, onEngine: false }, false, 0, false)).toBe(false);
    expect(nudgeAllowed(playing, true, 0, false)).toBe(false);
    expect(nudgeAllowed(playing, false, -1, false)).toBe(false);
  });
});

describe("installMidiBridge jog nudge", () => {
  const savedWindow = globalThis.window;
  let uninstall: () => void = () => {};
  let unregister: () => void = () => {};
  let transportA = { playing: true, onEngine: true };
  const seeks: DeckCommand[] = [];
  const midi = (...msgs: number[][]) => window.dispatchEvent(new CustomEvent("cratemind:midi", { detail: msgs }));
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const bendA = () => getMixer().fx.A.bend;

  beforeEach(() => {
    resetPrefs();
    resetMixer();
    seeks.length = 0;
    transportA = { playing: true, onEngine: true };
    globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/" } }) as unknown as Window & typeof globalThis;
    window.addEventListener("cratemind:deck", e => seeks.push((e as CustomEvent<DeckCommand>).detail));
    unregister = registerDeckTransport("A", () => transportA as DeckTransport);
    uninstall = installMidiBridge();
  });
  afterEach(() => {
    uninstall();
    unregister();
    setTransportOwner("A", null);
    globalThis.window = savedWindow;
    resetPrefs();
    resetMixer();
  });

  test("off by default: a turn on a playing deck seeks as before, leaves the bend alone and never reads the deck", async () => {
    let reads = 0;
    unregister();
    unregister = registerDeckTransport("A", () => { reads++; return transportA as DeckTransport; });
    midi([0xb0, 6, 2]);
    expect(reads).toBe(0);
    expect(bendA().dir).toBe(0);
    await wait(JOG_FLUSH_MS + 40);
    expect(seeks).toEqual([{ deck: "A", cmd: "seek", value: 2 * JOG_SECONDS_PER_TICK }]);
  });

  test("on: turning a playing deck bends it, a reverse turn bends the other way, and it lets go after the last tick", async () => {
    setPref("jogNudge", true);
    midi([0xb0, 6, 2]);
    const since = bendA().since;
    expect(bendA().dir).toBe(1);
    midi([0xb0, 6, 1], [0xb0, 6, 3]);
    expect(bendA()).toEqual({ dir: 1, since }); // one turn keeps one bend, so its ramp goes on
    midi([0xb0, 6, 0x7f]);
    expect(bendA().dir).toBe(-1);
    await wait(JOG_NUDGE_RELEASE_MS + 60);
    expect(bendA().dir).toBe(0);
    expect(seeks).toEqual([]);
  });

  test("on: a paused deck, an element deck, Shift, a transition and a held bend button keep the seek", async () => {
    setPref("jogNudge", true);
    transportA = { playing: false, onEngine: true };
    midi([0xb0, 6, 1]);
    transportA = { playing: true, onEngine: false };
    midi([0xb0, 6, 1]);
    transportA = { playing: true, onEngine: true };
    midi([0x90, 0x20, 0x7f], [0xb0, 6, 1], [0x80, 0x20, 0x00]);
    setTransportOwner("A", "mix");
    midi([0xb0, 6, 1]);
    setTransportOwner("A", null);
    midi([0x90, 0x0b, 0x7f], [0xb0, 6, 1]);
    expect(bendA().dir).toBe(1); // the button's bend
    midi([0x80, 0x0b, 0x00]);
    await wait(JOG_FLUSH_MS + 40);
    const total = seeks.reduce((sum, c) => sum + c.value, 0);
    expect(seeks.every(c => c.deck === "A" && c.cmd === "seek")).toBe(true);
    expect(total).toBeCloseTo(4 * JOG_SECONDS_PER_TICK + JOG_SHIFT_SECONDS_PER_TICK);
    expect(bendA().dir).toBe(0);
  });

  test("a bend button pressed during a nudge keeps its bend past the nudge's release time", async () => {
    setPref("jogNudge", true);
    midi([0xb0, 6, 2]);
    midi([0x90, 0x0c, 0x7f]);
    await wait(JOG_NUDGE_RELEASE_MS + 60);
    expect(bendA().dir).toBe(-1);
    midi([0x80, 0x0c, 0x00]);
    expect(bendA().dir).toBe(0);
  });

  test("a disconnect lets go of a nudge at once", () => {
    setPref("jogNudge", true);
    window.dispatchEvent(new CustomEvent("cratemind:midi-status", { detail: { connected: true } }));
    midi([0xb0, 6, 2]);
    expect(bendA().dir).toBe(1);
    window.dispatchEvent(new CustomEvent("cratemind:midi-status", { detail: { connected: false } }));
    expect(bendA().dir).toBe(0);
  });

  test("a disconnect lets go of a nudge even before any connected status (a page reload)", () => {
    setPref("jogNudge", true);
    midi([0xb0, 6, 2]);
    expect(bendA().dir).toBe(1);
    window.dispatchEvent(new CustomEvent("cratemind:midi-status", { detail: { connected: false } }));
    expect(bendA().dir).toBe(0);
  });
});

describe("createJogNudge release", () => {
  test("release lets go only of a bend the nudge holds", () => {
    const bends: [string, number][] = [];
    const nudge = createJogNudge((d, dir) => bends.push([d, dir]), { set: () => 1, clear: () => {} });
    nudge.release("A");
    expect(bends).toEqual([]);
    nudge.tick("A", -1, 5);
    nudge.release("A");
    nudge.release("A");
    expect(bends).toEqual([["A", -1], ["A", 0]]);
    expect(nudge.active("A")).toBe(false);
  });
});
