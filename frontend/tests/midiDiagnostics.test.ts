import { afterEach, describe, expect, test } from "bun:test";
import { createMidiState, decodeMidi, installMidiBridge, isUnhandled } from "../src/lib/midi";
import {
  DECK_LAYER_WARN_MS, UNHANDLED_MAX, UNHANDLED_PUBLISH_MS, clearUnhandledMidi, deckLayerWarningDue, formatUnhandled, getUnhandledMidi,
  isDeckLayerMessage, isLoggable, noteUnhandledMidi, recordUnhandled, subscribeUnhandledMidi, type MidiTriple,
} from "../src/lib/midiDiagnostics";

describe("isUnhandled", () => {
  test("handled messages, including ones that yield nothing, never reach the log", () => {
    const s = createMidiState();
    const handled: MidiTriple[] = [
      [0xb0, 0x06, 0x01], [0xb1, 0x06, 0x7f], [0xb0, 0x06, 0x00], // jog ticks and a standstill
      [0x90, 0x20, 0x7f], [0x80, 0x20, 0x00], // Shift
      [0xb0, 0x09, 0x40], [0xb0, 0x29, 0x00], // 14-bit pitch
      [0x9f, 0x02, 0x7f], [0x8f, 0x02, 0x00], // Load press and release
      [0xb8, 0x03, 0x00], [0xb8, 0x03, 0x05], // paddle baseline and an unknown paddle value
      [0xbf, 0x00, 0x00], [0xbf, 0x08, 0x40], [0xbe, 0x23, 0x40], [0xb0, 0x1c, 0x7f], [0xb0, 0x17, 0x40],
      [0xbf, 0x0c, 0x40], [0xbf, 0x0d, 0x00], // headphone knobs (cue gain, cue mix)
      [0xb9, 0x04, 0x00], // the dump's second Wet/Dry: known, unused
      [0x90, 0x00, 0x7f], [0x90, 0x00, 0x00], [0x90, 0x01, 0x7f], // Play press, and its release (unmatched, but a note-off) [0x80, 0x01, 0x00], [0x94, 0x14, 0x7f],
    ];
    // What the bridge logs: unmatched by decodeMidi and not a note-off.
    for (const m of handled) expect(isUnhandled(decodeMidi(m, s, { tagRoute: false, now: 0 })) && isLoggable(m)).toBe(false);
  });

  test("messages no mapping matches are unhandled and decode to nothing", () => {
    const s = createMidiState();
    for (const m of [[0x90, 0x06, 0x7f], [0x92, 0x00, 0x7f], [0xb2, 0x06, 0x01], [0xbf, 0x0e, 0x40], [0x98, 0x09, 0x7f]] as MidiTriple[]) {
      const out = decodeMidi(m, s);
      expect(isUnhandled(out)).toBe(true);
      expect(out).toEqual([]);
    }
  });
});

describe("unhandled log", () => {
  afterEach(() => clearUnhandledMidi());

  test("note-offs are not logged; presses and CCs are", () => {
    expect(isLoggable([0x80, 0x06, 0x00])).toBe(false);
    expect(isLoggable([0x90, 0x06, 0x00])).toBe(false);
    expect(isLoggable([0x90, 0x06, 0x7f])).toBe(true);
    expect(isLoggable([0xbf, 0x0c, 0x00])).toBe(true);
  });

  test("a repeat of status + data1 collapses into one row with a count, newest first", () => {
    let ring = recordUnhandled([], [0x90, 0x06, 0x7f], 1);
    ring = recordUnhandled(ring, [0xbf, 0x0c, 0x10], 2);
    for (let v = 0; v < 100; v++) ring = recordUnhandled(ring, [0xbf, 0x0c, v], 3 + v);
    ring = recordUnhandled(ring, [0x90, 0x06, 0x7f], 200);
    expect(ring).toEqual([
      { status: 0x90, d1: 0x06, d2: 0x7f, count: 2, at: 200 },
      { status: 0xbf, d1: 0x0c, d2: 99, count: 101, at: 102 },
    ]);
    expect(formatUnhandled(ring[0])).toBe("90 06 7F ×2");
    expect(formatUnhandled({ status: 0xb2, d1: 0x06, d2: 0x01, count: 1, at: 0 })).toBe("B2 06 01");
  });

  test("keeps the last 30 distinct messages", () => {
    let ring = recordUnhandled([], [0x90, 0, 1], 0);
    for (let d1 = 1; d1 < 40; d1++) ring = recordUnhandled(ring, [0x90, d1, 1], d1);
    expect(ring.length).toBe(UNHANDLED_MAX);
    expect(ring[0].d1).toBe(39);
    expect(ring[UNHANDLED_MAX - 1].d1).toBe(10);
  });

  test("a flood publishes once per interval, and clear empties it", async () => {
    let calls = 0;
    const off = subscribeUnhandledMidi(() => { calls++; });
    for (let v = 0; v < 200; v++) noteUnhandledMidi([0xbf, 0x0c, v % 128], 1000 + v);
    noteUnhandledMidi([0x80, 0x06, 0], 2000); // note-off: ignored
    expect(calls).toBe(0);
    expect(getUnhandledMidi()).toEqual([]);
    await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
    expect(calls).toBe(1);
    expect(getUnhandledMidi()).toEqual([{ status: 0xbf, d1: 0x0c, d2: 199 % 128, count: 200, at: 1199 }]);
    clearUnhandledMidi();
    expect(calls).toBe(2);
    expect(getUnhandledMidi()).toEqual([]);
    off();
  });
});

describe("bridge", () => {
  test("logs only messages no mapping uses", async () => {
    const savedWindow = globalThis.window;
    globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/" } }) as unknown as Window & typeof globalThis;
    const uninstall = installMidiBridge();
    try {
      const detail = [[0xb0, 0x06, 0x01], [0xb0, 0x09, 0x40], [0x90, 0x06, 0x7f], [0x80, 0x06, 0x00], [0x92, 0x00, 0x7f], [0x90, 0x06, 0x7f]];
      window.dispatchEvent(new CustomEvent("cratemind:midi", { detail }));
      await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
      expect(getUnhandledMidi().map(formatUnhandled)).toEqual(["90 06 7F ×2", "92 00 7F"]);
    } finally {
      uninstall();
      globalThis.window = savedWindow;
      clearUnhandledMidi();
    }
  });
});

describe("Deck 3/4 layer", () => {
  test("presses on channels 3/4 and 7/8 and jog turns on 3/4 mean the Deck 3/4 layer", () => {
    for (const m of [[0x92, 0x00, 0x7f], [0x93, 0x01, 0x7f], [0x92, 0x20, 0x7f], [0x96, 0x14, 0x7f], [0x97, 0x0d, 0x7f], [0xb2, 0x06, 0x01], [0xb3, 0x06, 0x7f]] as MidiTriple[]) {
      expect(isDeckLayerMessage(m)).toBe(true);
    }
  });

  test("shared controls, releases, knob positions and note 08 never warn", () => {
    const quiet: MidiTriple[] = [
      [0x90, 0x00, 0x7f], [0x91, 0x00, 0x7f], [0x94, 0x14, 0x7f], [0x95, 0x14, 0x7f], // decks 1/2
      [0x98, 0x00, 0x7f], [0x99, 0x03, 0x7f], [0xb8, 0x04, 0x40], [0xb9, 0x03, 0x01], // effects (9/10)
      [0xbe, 0x23, 0x40], [0x9f, 0x04, 0x7f], [0x9f, 0x05, 0x7f], [0xbf, 0x00, 0x01], // master (15), browse/load (16)
      [0x82, 0x00, 0x00], [0x92, 0x00, 0x00], [0x86, 0x14, 0x00], // releases
      [0xb2, 0x1c, 0x40], [0xb3, 0x17, 0x40], [0xb2, 0x06, 0x00], // a position dump, a jog standstill
      [0x92, 0x08, 0x7f], [0x93, 0x08, 0x7f], // note 08: maybe the deck switch itself
    ];
    for (const m of quiet) expect(isDeckLayerMessage(m)).toBe(false);
  });

  test("warns at most once per 30 seconds", () => {
    const m: MidiTriple = [0x92, 0x00, 0x7f];
    expect(deckLayerWarningDue(m, null, 5)).toBe(true);
    expect(deckLayerWarningDue(m, 5, 5 + DECK_LAYER_WARN_MS - 1)).toBe(false);
    expect(deckLayerWarningDue(m, 5, 5 + DECK_LAYER_WARN_MS)).toBe(true);
    expect(deckLayerWarningDue([0x90, 0x00, 0x7f], null, 5)).toBe(false);
  });
});
