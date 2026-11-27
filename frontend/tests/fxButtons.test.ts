import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_FX_BUTTON_PRESETS, FX_BUTTON_LABELS, canTake, controllerEffect, fxButtonPresets, pickEffect, resetFxButtons,
  stepDeck, stepEffect, storeOnButton, type DeckTempo,
} from "../src/lib/fxButtons";
import { engage, getFxRack, resetFxRack, selectPreset, setAvailable } from "../src/lib/fxRack";
import { FX_PRESETS, presetById } from "../src/lib/fxRack/presets";
import { FX_SELECT_NOTES, createMidiState, decodeMidi, installMidiBridge, type DeckCommand } from "../src/lib/midi";
import { fxPickerPeek } from "../src/lib/fxPickerPeek";
import { lastPlayingDeck, noteDeckPlaying, resetLastPlayingDeck } from "../src/lib/lastPlayingDeck";
import { describeMidiOutput } from "../src/lib/midiDiagnostics";
import { registerDeckTransport, type DeckTransport } from "../src/lib/mix/deckTransport";
import { getPref, resetPrefs, setPref } from "../src/lib/prefs";

const SHIFT_ON = [0x90, 0x20, 0x7f] as [number, number, number];
const SHIFT_OFF = [0x80, 0x20, 0x00] as [number, number, number];
const preset = (d: "A" | "B") => getFxRack().decks[d].preset;
const both = (id: string) => { selectPreset("A", id); selectPreset("B", id); };
const tempo = (A: DeckTempo, B: DeckTempo = A) => (deck: "A" | "B") => (deck === "A" ? A : B);

beforeEach(() => {
  resetPrefs();
  resetFxRack();
  resetFxButtons();
});
afterEach(() => {
  resetFxRack();
  resetFxButtons();
  resetPrefs();
});

describe("decode", () => {
  const on = { tagRoute: false, now: 0, fxPick: true };

  test("the six buttons in printed order are 98 00-02 and 99 03-05; the defaults match the printed names", () => {
    expect(FX_SELECT_NOTES).toEqual([[0x98, 0], [0x98, 1], [0x98, 2], [0x99, 3], [0x99, 4], [0x99, 5]]);
    expect([...FX_BUTTON_LABELS]).toEqual(["HPF", "LPF", "FLANGER", "ECHO", "REVERB", "PHASER"]);
    expect(DEFAULT_FX_BUTTON_PRESETS.map(id => presetById(id)?.name)).toEqual(["Highpass", "Lowpass", "Flanger", "Echo", "Reverb", "Phaser"]);
  });

  test("switch off (or no context): every button is still the transition note it was", () => {
    const s = createMidiState();
    const notes = FX_SELECT_NOTES.map(([st, n]) => decodeMidi([st, n, 0x7f], s));
    expect(notes).toEqual([0, 1, 2, 0, 1, 2].map((value, i) => [{ kind: "deck", deck: i < 3 ? "A" : "B", cmd: "note", value }]));
    expect(FX_SELECT_NOTES.map(([st, n]) => decodeMidi([st, n, 0x7f], s, { tagRoute: false, now: 0, fxPick: false }))).toEqual(notes);
  });

  test("switch on: a press picks its button, Shift + press stores on it, a release does nothing", () => {
    const s = createMidiState();
    expect(FX_SELECT_NOTES.map(([st, n]) => decodeMidi([st, n, 0x7f], s, on)))
      .toEqual([0, 1, 2, 3, 4, 5].map(button => [{ kind: "fxrack", control: "pick", button }]));
    decodeMidi(SHIFT_ON, s);
    expect(FX_SELECT_NOTES.map(([st, n]) => decodeMidi([st, n, 0x7f], s, on)))
      .toEqual([0, 1, 2, 3, 4, 5].map(button => [{ kind: "fxrack", control: "store", button }]));
    decodeMidi(SHIFT_OFF, s);
    expect(decodeMidi([0x98, 0x00, 0x00], s, on)).toEqual([]);
    expect(decodeMidi([0x98, 0x03, 0x7f], s, on)).toEqual([]); // not a button: unit 1 has only 00-02
  });

  test("BEATS: a plain turn is the beat length, with Shift held it steps the effect, and plain again after Shift", () => {
    const s = createMidiState();
    expect(decodeMidi([0xb8, 0x05, 0x01], s)).toEqual([{ kind: "fxrack", control: "beats", value: 1 }]);
    decodeMidi(SHIFT_ON, s);
    expect(decodeMidi([0xb8, 0x05, 0x01], s)).toEqual([{ kind: "fxrack", control: "step", value: 1 }]);
    expect(decodeMidi([0xb8, 0x05, 0x7f], s)).toEqual([{ kind: "fxrack", control: "step", value: -1 }]);
    // Every BEATS turn also sends B9 05 beside B8 05 (the owner's raw log, 2026-11-27): it does nothing, with or
    // without Shift, so one click is one step.
    expect(decodeMidi([0xb9, 0x05, 0x01], s)).toEqual([]);
    expect(decodeMidi([0xb9, 0x05, 0x7f], createMidiState())).toEqual([]);
    expect(decodeMidi([0xb8, 0x05, 0x00], s)).toEqual([]);
    decodeMidi(SHIFT_OFF, s);
    expect(decodeMidi([0xb8, 0x05, 0x7f], s)).toEqual([{ kind: "fxrack", control: "beats", value: -1 }]);
    // Shift + Browse is untouched: still BF 01, ten rows.
    decodeMidi(SHIFT_ON, s);
    expect(decodeMidi([0xbf, 0x01, 0x01], s)).toEqual([{ kind: "action", action: { type: "browse", delta: 10 } }]);
  });

  test("the raw log names them in Greek", () => {
    expect(describeMidiOutput({ kind: "fxrack", control: "pick", button: 3 })).toBe("Κουμπί FX ECHO · επιλογή εφέ");
    expect(describeMidiOutput({ kind: "fxrack", control: "store", button: 0 })).toBe("Shift + κουμπί FX HPF · αποθήκευση εφέ");
    expect(describeMidiOutput({ kind: "fxrack", control: "step", value: -1 })).toBe("Shift + FX Beats · προηγούμενο εφέ");
  });
});

describe("picking", () => {
  test("a pick sets the same effect on both decks", () => {
    expect(pickEffect("echo", tempo("bpm"))).toEqual({ id: "echo", took: ["A", "B"], refused: [] });
    expect([preset("A"), preset("B")]).toEqual(["echo", "echo"]);
  });

  test("the picker's rules: a BPM effect skips a deck whose track has no BPM; an empty deck and a no-BPM effect take it", () => {
    both("reverb");
    expect(pickEffect("echo", tempo("bpm", "none"))).toEqual({ id: "echo", took: ["A"], refused: ["B"] });
    expect([preset("A"), preset("B")]).toEqual(["echo", "reverb"]);
    expect(pickEffect("highpass", tempo("bpm", "none"))!.took).toEqual(["A", "B"]);
    expect(pickEffect("flanger", tempo("empty"))!.took).toEqual(["A", "B"]);
    expect(canTake("none", "highpass")).toBe(true);
    expect(canTake("none", "echo")).toBe(false);
    expect(canTake("bpm", "nope")).toBe(false);
  });

  test("while the rack is unavailable nothing is picked (the picker is disabled)", () => {
    setAvailable(false);
    expect(pickEffect("echo", tempo("bpm"))).toBeNull();
    expect(stepEffect(1, tempo("bpm"))).toBeNull();
    expect(preset("A")).not.toBe("echo");
  });

  test("an effect that is on, or releasing, switches live as in the picker", () => {
    both("reverb");
    engage("A", "latch");
    pickEffect("echo", tempo("bpm"));
    expect(getFxRack().decks.A).toMatchObject({ preset: "echo", on: true });
  });

  test("Shift + button stores the current effect on that button, and it persists", () => {
    pickEffect("roll", tempo("bpm"));
    expect(storeOnButton(2)).toBe("roll");
    expect(fxButtonPresets()[2]).toBe("roll");
    expect(getPref("fxButtonPresets")).toEqual(["highpass", "lowpass", "roll", "echo", "reverb", "phaser"]);
    expect(storeOnButton(6)).toBeNull();
  });

  test("saved assignments are sanitised", () => {
    expect(fxButtonPresets(["roll", "nope", 3])).toEqual(["roll", "lowpass", "flanger", "echo", "reverb", "phaser"]);
    expect(fxButtonPresets("x")).toEqual([...DEFAULT_FX_BUTTON_PRESETS]);
  });
});

describe("stepping", () => {
  test("a step acts on one deck: the last playing deck, else the deck whose FX was last turned on, else none", () => {
    expect(stepDeck("B", "A")).toBe("B");
    expect(stepDeck(null, "A")).toBe("A");
    expect(stepDeck(null, null)).toBe(null);
    both("echo");
    expect(stepEffect(1, tempo("bpm"), null)).toBe(null); // no deck to act on: nothing changes
    expect([preset("A"), preset("B")]).toEqual(["echo", "echo"]);
  });

  test("steps one deck through the whole list in the picker's order, stops at both ends, and never touches the other deck", () => {
    both(FX_PRESETS[0].id);
    expect(stepEffect(-1, tempo("bpm"), "B")).toBe("start");
    expect(preset("B")).toBe(FX_PRESETS[0].id);
    for (let i = 1; i < FX_PRESETS.length; i++) {
      stepEffect(1, tempo("bpm"), "B");
      expect([preset("A"), preset("B")]).toEqual([FX_PRESETS[0].id, FX_PRESETS[i].id]);
    }
    expect(stepEffect(1, tempo("bpm"), "B")).toBe("end");
    expect(preset("B")).toBe(FX_PRESETS.at(-1)!.id);
    stepEffect(-1, tempo("bpm"), "B");
    expect(preset("B")).toBe(FX_PRESETS.at(-2)!.id);
    expect(preset("A")).toBe(FX_PRESETS[0].id);
  });

  test("an effect the deck cannot take is still a step: the next one goes on from it", () => {
    const i = FX_PRESETS.findIndex(p => p.id === "bit-crusher"); // ∅, between two BPM presets
    both(FX_PRESETS[i - 1].id);
    stepEffect(1, tempo("none"), "A"); // bit-crusher needs no BPM
    expect(preset("A")).toBe("bit-crusher");
    expect(stepEffect(1, tempo("none"), "A")).toEqual({ id: FX_PRESETS[i + 1].id, took: [], refused: ["A"] });
    expect(preset("A")).toBe("bit-crusher");
    expect(controllerEffect()).toBe(FX_PRESETS[i + 1].id);
    stepEffect(1, tempo("bpm"), "A");
    expect(preset("A")).toBe(FX_PRESETS[i + 2].id);
    expect(preset("B")).toBe(FX_PRESETS[i - 1].id);
  });

  test("each deck steps from its own effect, and from the effect picked on screen since its last step", () => {
    selectPreset("A", "echo");
    selectPreset("B", "roll");
    const after = (id: string) => FX_PRESETS[FX_PRESETS.findIndex(p => p.id === id) + 1].id;
    stepEffect(1, tempo("bpm"), "B");
    expect([preset("A"), preset("B")]).toEqual(["echo", after("roll")]);
    selectPreset("B", "echo");
    stepEffect(1, tempo("bpm"), "B");
    expect(preset("B")).toBe(after("echo"));
    stepEffect(1, tempo("bpm"), "A");
    expect(preset("A")).toBe(after("echo"));
  });
});

describe("bridge", () => {
  const savedWindow = globalThis.window;
  let uninstall: () => void = () => {};
  let unregister: () => void = () => {};
  const notes: DeckCommand[] = [];
  const midi = (...msgs: number[][]) => window.dispatchEvent(new CustomEvent("cratemind:midi", { detail: msgs }));

  beforeEach(() => {
    notes.length = 0;
    globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/" } }) as unknown as Window & typeof globalThis;
    window.addEventListener("cratemind:deck", e => notes.push((e as CustomEvent<DeckCommand>).detail));
    // Deck A has a track without a BPM; Deck B is empty (no transport).
    unregister = registerDeckTransport("A", () => ({ trackId: 1, trackBpm: null }) as DeckTransport);
    uninstall = installMidiBridge();
  });
  afterEach(() => {
    uninstall();
    unregister();
    resetLastPlayingDeck();
    globalThis.window = savedWindow;
  });

  test("switch off: a button sends its transition note and leaves the effects alone", () => {
    both("reverb");
    midi([0x99, 0x04, 0x7f]);
    expect(notes).toEqual([{ kind: "deck", deck: "B", cmd: "note", value: 1 }]);
    expect(preset("A")).toBe("reverb");
  });

  test("switch on: ECHO sets the decks that can take it, Shift + HPF stores it, Shift + BEATS steps", () => {
    setPref("fxButtonsPickEffect", true);
    both("reverb");
    midi([0x98, 0x00, 0x7f]); // HPF: no BPM needed, both decks
    expect([preset("A"), preset("B")]).toEqual(["highpass", "highpass"]);
    midi([0x99, 0x03, 0x7f]); // ECHO: Deck A's track has no BPM, so only the empty Deck B takes it
    expect([preset("A"), preset("B")]).toEqual(["highpass", "echo"]);
    midi(SHIFT_ON, [0x98, 0x02, 0x7f], SHIFT_OFF); // the controller's current effect is Echo
    expect(fxButtonPresets()[2]).toBe("echo");
    expect(notes).toEqual([]);
    both("reverb");
    midi(SHIFT_ON);
    expect(fxPickerPeek()).toBe(null); // Shift alone shows nothing
    midi([0xb8, 0x05, 0x01]); // no deck has played and no FX was turned on: the step does nothing at all
    expect([preset("A"), preset("B")]).toEqual(["reverb", "reverb"]);
    expect(fxPickerPeek()).toBe(null);
    midi(SHIFT_OFF);
    engage("B", "latch"); // Deck B's FX was the last one turned on: the step is Deck B's alone
    midi(SHIFT_ON, [0xb8, 0x05, 0x01]);
    expect([preset("A"), preset("B")]).toEqual(["reverb", "flanger"]);
    expect(fxPickerPeek()).toBe("B"); // and Deck B's picker shows its list while Shift stays down
    midi(SHIFT_OFF);
    expect(fxPickerPeek()).toBe(null); // letting Shift go hides it
    midi([0xb8, 0x05, 0x01]); // a plain turn is the beat length again
    expect(preset("B")).toBe("flanger");
    expect(fxPickerPeek()).toBe(null);
    noteDeckPlaying("A", true); // a playing deck comes before the FX deck; Deck A's track has no BPM, so Flanger is refused
    midi(SHIFT_ON, [0xb8, 0x05, 0x01]);
    expect([preset("A"), preset("B")]).toEqual(["reverb", "flanger"]);
    expect(fxPickerPeek()).toBe("A");
    midi(SHIFT_OFF);
  });

  test("the last playing deck: the latest to start while it plays, else the other playing one, else the latest to start", () => {
    expect(lastPlayingDeck()).toBe(null);
    noteDeckPlaying("A", true);
    noteDeckPlaying("B", true);
    expect(lastPlayingDeck()).toBe("B");
    noteDeckPlaying("B", false);
    expect(lastPlayingDeck()).toBe("A"); // B stopped, A still plays
    noteDeckPlaying("A", false);
    expect(lastPlayingDeck()).toBe("B"); // neither plays: the one that started last
  });
});
