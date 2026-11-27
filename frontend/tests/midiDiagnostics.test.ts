import { afterEach, describe, expect, test } from "bun:test";
import { createMidiState, decodeMidi, installMidiBridge, isUnhandled } from "../src/lib/midi";
import {
  DECK_LAYER_WARN_MS, RAW_MAX, UNHANDLED_MAX, UNHANDLED_PUBLISH_MS, clearRawMidi, clearUnhandledMidi, deckLayerWarningDue, describeMidiOutputs,
  formatUnhandled, getRawMidiLog, getUnhandledMidi, isDeckLayerMessage, isLoggable, noteRawMidi, noteUnhandledMidi, rawMidiLogOn, recordRaw,
  recordUnhandled, setRawMidiLog, subscribeUnhandledMidi, type MidiTriple,
} from "../src/lib/midiDiagnostics";
import { getMixer, resetMixer } from "../src/lib/mixer";

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

describe("raw log", () => {
  const decode = (msgs: MidiTriple[], now = 0) => {
    const s = createMidiState();
    return msgs.map(m => { const out = decodeMidi(m, s, { tagRoute: false, now }); return describeMidiOutputs(out, isUnhandled(out), m); });
  };
  afterEach(() => { setRawMidiLog(false); clearRawMidi(); });

  test("says in Greek what each message did", () => {
    expect(decode([
      [0x91, 0x02, 0x7f], [0x90, 0x00, 0x7f], [0xb0, 0x19, 0x40], [0xb1, 0x1c, 0x7f], [0x94, 0x16, 0x7f], [0x95, 0x1e, 0x7f],
      [0xbf, 0x08, 0x40], [0xbe, 0x23, 0x40], [0x98, 0x01, 0x7f], [0x99, 0x05, 0x7f], [0x90, 0x0b, 0x7f], [0x80, 0x0b, 0x00],
      [0x91, 0x01, 0x7f], [0x81, 0x01, 0x00], [0xbf, 0x00, 0x7f], [0x9f, 0x07, 0x7f], [0xb8, 0x04, 0x40], [0xb8, 0x05, 0x01], [0xbf, 0x0c, 0x40],
    ])).toEqual([
      "Deck B · Sync", "Deck A · Play/Pause", "Deck A · EQ LOW", "Deck B · Ένταση", "Deck A · Pad 3", "Deck B · Διαγραφή pad 3",
      "Crossfader", "Master", "Σημείωση μετάβασης (FX 1)", "Σημείωση μετάβασης (FX 2)", "Deck A · Bend +", "Deck A · Bend (άφημα)",
      "Deck B · Cue", "Deck B · Cue (άφημα)", "Περιήγηση -1", "Αναπαραγωγή επιλογής", "FX Wet/Dry", "FX Beats +", "Ένταση ακουστικών",
    ]);
  });

  test("tells a known message that does nothing by itself from one no mapping matches", () => {
    expect(decode([[0xb0, 0x09, 0x40], [0xb0, 0x06, 0x00], [0x9f, 0x02, 0x7f], [0x92, 0x00, 0x7f], [0x90, 0x06, 0x7f], [0x90, 0x02, 0x00], [0x82, 0x00, 0x00]]))
      .toEqual(["χωρίς ενέργεια", "χωρίς ενέργεια", "χωρίς ενέργεια", "χωρίς αντιστοίχιση", "χωρίς αντιστοίχιση", "άφημα, χωρίς ενέργεια", "άφημα, χωρίς ενέργεια"]);
    const s = createMidiState();
    decodeMidi([0x9f, 0x03, 0x7f], s, { tagRoute: false, now: 0 });
    expect(describeMidiOutputs(decodeMidi([0x8f, 0x03, 0x00], s, { tagRoute: false, now: 10 }), false)).toBe("Φόρτωση στο Deck B");
  });

  test("shows no internal key for any message the controller can send", () => {
    const s = createMidiState();
    for (let status = 0x80; status <= 0xbf; status++) {
      for (let d1 = 0; d1 < 0x48; d1++) {
        for (const d2 of [0, 1, 0x40, 0x7f]) {
          const out = decodeMidi([status, d1, d2], s, { tagRoute: false, now: 0 });
          const what = describeMidiOutputs(out, isUnhandled(out));
          expect(what).not.toMatch(/undefined|[a-z]+-[a-z]+|\b(toggle|seek|cue-release|volume|crossfader|cueGain|cueMix|paddle|amount|beats|keylock)\b/);
        }
      }
    }
  });

  test("a turn of one knob is one row; notes, and another control in between, start new rows", () => {
    let log = recordRaw([], [0xb0, 0x1c, 10], "Deck A · Ένταση", 1);
    for (let v = 11; v < 60; v++) log = recordRaw(log, [0xb0, 0x1c, v], "Deck A · Ένταση", v);
    expect(log).toEqual([{ status: 0xb0, d1: 0x1c, d2: 59, count: 50, at: 59, what: "Deck A · Ένταση" }]);
    log = recordRaw(log, [0x90, 0x02, 0x7f], "Deck A · Sync", 70);
    log = recordRaw(log, [0x90, 0x02, 0x00], "άφημα, χωρίς ενέργεια", 71);
    log = recordRaw(log, [0x90, 0x02, 0x7f], "Deck A · Sync", 72);
    log = recordRaw(log, [0xb0, 0x1c, 60], "Deck A · Ένταση", 80);
    expect(log.map(e => [formatUnhandled(e), e.what])).toEqual([
      ["B0 1C 3C", "Deck A · Ένταση"], ["90 02 7F", "Deck A · Sync"], ["90 02 00", "άφημα, χωρίς ενέργεια"], ["90 02 7F", "Deck A · Sync"],
      ["B0 1C 3B ×50", "Deck A · Ένταση"],
    ]);
    for (let i = 0; i < RAW_MAX + 20; i++) log = recordRaw(log, [0x90, 0x02, 0x7f], "Deck A · Sync", 100 + i);
    expect(log.length).toBe(RAW_MAX);
  });

  test("off by default; on records, off stops and keeps the rows, clear empties", async () => {
    expect(rawMidiLogOn()).toBe(false);
    noteRawMidi([0x90, 0x02, 0x7f], "Deck A · Sync", 1);
    await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
    expect(getRawMidiLog()).toEqual({ on: false, entries: [] });
    setRawMidiLog(true);
    noteRawMidi([0x90, 0x02, 0x7f], "Deck A · Sync", 2);
    await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
    setRawMidiLog(false);
    noteRawMidi([0x91, 0x02, 0x7f], "Deck B · Sync", 3);
    await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
    expect(getRawMidiLog()).toEqual({ on: false, entries: [{ status: 0x90, d1: 0x02, d2: 0x7f, count: 1, at: 2, what: "Deck A · Sync" }] });
    clearRawMidi();
    expect(getRawMidiLog().entries).toEqual([]);
  });

  test("the bridge logs every message while on, and the mapping still acts", async () => {
    const savedWindow = globalThis.window;
    globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/" } }) as unknown as Window & typeof globalThis;
    const uninstall = installMidiBridge();
    try {
      resetMixer();
      window.dispatchEvent(new CustomEvent("cratemind:midi", { detail: [[0xb0, 0x1c, 0x00]] }));
      setRawMidiLog(true);
      window.dispatchEvent(new CustomEvent("cratemind:midi", { detail: [[0xb0, 0x1c, 0x40], [0xb0, 0x1c, 0x7f], [0x92, 0x00, 0x7f], [0x80, 0x0b, 0x00], [0x91, 0x02, 0x00]] }));
      await new Promise(r => setTimeout(r, UNHANDLED_PUBLISH_MS + 50));
      expect(getRawMidiLog().entries.map(e => [formatUnhandled(e), e.what])).toEqual([
        ["91 02 00", "άφημα, χωρίς ενέργεια"], ["80 0B 00", "Deck A · Bend (άφημα)"], ["92 00 7F", "χωρίς αντιστοίχιση"],
        ["B0 1C 7F ×2", "Deck A · Ένταση"],
      ]);
      expect(getMixer().volume.A).toBe(1);
    } finally {
      uninstall();
      globalThis.window = savedWindow;
      clearUnhandledMidi();
      resetMixer();
    }
  });
});

test("the raw log names Shift's press and release, which do nothing by themselves", () => {
  expect(describeMidiOutputs([], false, [0x90, 0x20, 0x7f])).toBe("Shift πατημένο");
  expect(describeMidiOutputs([], false, [0x80, 0x20, 0x00])).toBe("Shift αφημένο");
  expect(describeMidiOutputs([], false, [0x91, 0x20, 0x7f])).toBe("Shift πατημένο");
  expect(describeMidiOutputs([], false, [0x90, 0x21, 0x7f])).toBe("χωρίς ενέργεια");
});
