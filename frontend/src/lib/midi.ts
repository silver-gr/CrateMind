// MIDI bridge: the Tauri host forwards raw MIDI as window "cratemind:midi" events.
// Pads on /tag become synthetic keydown events so the single keyboard map stays
// the source of truth (every guard in keyboardGuard.ts keeps applying); deck
// transport goes to the MiniPlayers via "cratemind:deck", faders to lib/mixer.ts and the FX paddles/knobs to lib/fxRack.ts.
// Mapping source: Mixxx's "Numark Mixtrack Platinum FX" mapping.
import { controllerPick, controllerStep, controllerStore, stepDeck, type DeckTempo } from "./fxButtons";
import { controllerAmount, controllerBeats, controllerDisconnected, getLastFxDeck, paddle } from "./fxRack";
import { hasOpenSurface } from "./keyboardGuard";
import { createKnobMoves } from "./knobFlash";
import { setFxPickerPeek } from "./fxPickerPeek";
import { deckLayerWarningDue, describeMidiOutputs, noteRawMidi, noteUnhandledMidi, rawMidiLogOn } from "./midiDiagnostics";
import { deckTransportOf, transportOwnerOf } from "./mix/deckTransport";
import { ccToBipolar, getMixer, releaseBends, setCrossfader, setDeckBend, setDeckEq, setDeckFilter, setDeckPitchFromController, setDeckTrim, setCueGain, setCueMix, setMasterGain, setMidiConnected, setMixerVolume, toggleKeylock, type EqBand } from "./mixer";
import { resetPadBanks, setPadBank, type PadBank } from "./padBank";
import { lastPlayingDeck } from "./lastPlayingDeck";
import type { DeckId } from "./player";
import { getPref } from "./prefs";
import { STATUS_PAD_KEYS } from "./tagKeys";
import { toast } from "sonner";

export type MidiAction =
  | { type: "play" | "cycle-focus" | "add-to-set" }
  | { type: "browse"; delta: number }
  | { type: "load-deck" | "eject"; deck: DeckId };
/**
 * `cue`: value 0 = Cue, 1 = Shift + Cue. `cue-release`: either button let go. `pad-delete`: Shift + pad (value = pad).
 * `sync`: one-shot tempo match. `range`: Shift + bend -, cycles the pitch range.
 * `tag`: tag bank pad (0..7 = energy 1..8, 8..15 = darkness 1..8). `status`: status bank pad (0..6 = a w x b p r m).
 * `note`: transition note from FX select 1..3 (value 0..2 = good / ok / clash; the deck is only the unit it came from).
 * `loop-*`: Auto Loop row on/off, 1/2, x2, and Shift + 1/2 / x2 = loop in / out.
 */
export type DeckCommand = {
  deck: DeckId;
  cmd: "toggle" | "seek" | "pad" | "pad-delete" | "cue" | "cue-release" | "sync" | "range" | "tag" | "status" | "note"
    | "loop-toggle" | "loop-half" | "loop-double" | "loop-in" | "loop-out";
  value: number;
};

/**
 * Deck commands that write or start something: dropped while a dialog/menu is open, so the
 * controller can't act behind it. Tag-bank writes and transition notes are listed too. Never `cue-release`: it must always get
 * through, so a preview can't stay stuck behind a dialog. A `pad` press is not listed because it may be
 * a plain jump; MiniPlayer's empty-pad create checks hasOpenSurface() itself.
 */
export const GUARDED_DECK_COMMANDS: ReadonlySet<DeckCommand["cmd"]> = new Set(["cue", "pad-delete", "tag", "status", "note"]);
export const isDeckCommandBlocked = (cmd: DeckCommand["cmd"], surfaceOpen: boolean) => surfaceOpen && GUARDED_DECK_COMMANDS.has(cmd);

/** Seconds of seek per jog tick: vinyl feel, so beats can be lined up by hand. Mixxx scratches this wheel at
 * 1024 ticks a turn at 33⅓ rpm, so one turn moves 1.8 s of audio. */
export const JOG_SECONDS_PER_TICK = 60 / (100 / 3) / 1024;
/** Seconds of seek per jog tick with Shift held: fast seeking through the track. */
export const JOG_SHIFT_SECONDS_PER_TICK = 0.05;
/** Jog seeks are summed across events and flushed at most this often. */
export const JOG_FLUSH_MS = 30;
/** «Jog nudge» lets go of the bend this long (ms) after the wheel's last tick (Open DJ's starting value; tune live). */
export const JOG_NUDGE_RELEASE_MS = 80;

/** Pitch fader polarity: the raw 14-bit value rises towards the bottom, so the top is slower. Flip if the live check disagrees. */
export const PITCH_TOP_IS_SLOWER = true;

export type MidiOutput =
  | { kind: "key"; key: string; code: string; shiftKey: boolean }
  | { kind: "action"; action: MidiAction }
  | ({ kind: "deck" } & DeckCommand)
  | { kind: "bank"; deck: DeckId; bank: PadBank }
  | { kind: "mixer"; control: "volume"; deck: DeckId; value: number }
  | { kind: "mixer"; control: "crossfader"; value: number }
  | { kind: "mixer"; control: "eq"; deck: DeckId; band: EqBand; value: number }
  | { kind: "mixer"; control: "filter" | "pitch" | "trim"; deck: DeckId; value: number }
  | { kind: "mixer"; control: "master"; value: number }
  | { kind: "mixer"; control: "cueGain"; value: number }
  | { kind: "mixer"; control: "cueMix"; value: number }
  | { kind: "mixer"; control: "bend"; deck: DeckId; dir: -1 | 0 | 1 }
  | { kind: "mixer"; control: "nudge"; deck: DeckId; dir: -1 | 1 }
  | { kind: "mixer"; control: "keylock"; deck: DeckId }
  | { kind: "fxrack"; control: "paddle"; deck: DeckId; value: PaddlePosition }
  | { kind: "fxrack"; control: "amount"; value: number }
  | { kind: "fxrack"; control: "beats"; value: -1 | 1 }
  /** Shift + BEATS: the previous or next effect, on one deck (`stepDeck`). */
  | { kind: "fxrack"; control: "step"; value: -1 | 1 }
  /** An FX button (0..5, `FX_SELECT_NOTES`) with «Τα κουμπιά FX διαλέγουν εφέ» on: its effect on one deck (`stepDeck`), or with Shift,
   * the current effect stored on it. */
  | { kind: "fxrack"; control: "pick"; button: number }
  | { kind: "fxrack"; control: "store"; button: number };
/**
 * `loadPressedAt`: press time per Load button, decided on release (tap = load, hold = add to set).
 * `pitchMsb`: last coarse byte of the 14-bit pitch fader per deck; null until seen and after disconnect.
 * `paddle`: last FX paddle position per deck; null until seen and after disconnect (the first value is only a baseline).
 */
export type MidiState = {
  shift: boolean; loadPressedAt: Record<DeckId, number | null>; pitchMsb: Record<DeckId, number | null>; bank: Record<DeckId, PadBank>;
  paddle: Record<DeckId, PaddlePosition | null>;
};
/**
 * `tagRoute`: on /tag the pads keep their v1 meaning (digits / tagging letters). `now`: ms clock.
 * `nudge`: whether an unshifted jog turn on that deck bends its tempo instead of moving the playhead («Jog nudge», off by
 * default); absent means never, so the jog seeks exactly as it always has.
 * `fxPick`: «Τα κουμπιά FX διαλέγουν εφέ» is on, so the six FX buttons pick effects; absent or false, they are transition notes.
 */
export type MidiContext = { tagRoute: boolean; now: number; nudge?: (deck: DeckId) => boolean; fxPick?: boolean };
export const createMidiState = (): MidiState => ({
  shift: false, loadPressedAt: { A: null, B: null }, pitchMsb: { A: null, B: null }, bank: { A: "cue", B: "cue" }, paddle: { A: null, B: null },
});
const EQ_CC: Record<number, EqBand> = { 0x17: "hi", 0x18: "mid", 0x19: "lo" };
/** Load held at least this long (ms) adds to the set instead of loading the deck. */
export const LOAD_HOLD_MS = 800;

/** Browse turns reported as BF 01 (Shift held) move this many rows per tick. */
export const BROWSE_SHIFT_MULTIPLIER = 10;

/**
 * FX paddles (Mixxx's map, unconfirmed on the hardware): B8 03 = deck A, B9 03 = deck B, value 0 = middle (release),
 * 1 = up (latch), 2 = down (hold). Shared FX knobs on B8: 04 Wet/Dry (absolute), 05 Beats (relative); each drives both decks.
 */
export const PADDLE_CC = 0x03;
export const PADDLE_RELEASE = 0;
export const PADDLE_LATCH = 1;
export const PADDLE_HOLD = 2;
export type PaddlePosition = typeof PADDLE_RELEASE | typeof PADDLE_LATCH | typeof PADDLE_HOLD;
export const FX_WET_DRY_CC = 0x04;
/** BEATS sends B8 05 and, beside it on every turn, B9 05 (the owner's raw log, 2026-11-27, with and without Shift: the two
 * always come as a pair). Only B8 05 is read: the beat length, or with the decoder's Shift state (90/91 20) on, the next or
 * previous effect. B9 05 is known and unused, or every turn would act twice. */
export const FX_BEATS_CC = 0x05;
/**
 * The six FX buttons as [status, note], in printed order HPF, LPF, FLANGER, ECHO, REVERB, PHASER (fxButtons.ts labels).
 * The bytes are a hardware capture; which printed name each note is follows Mixxx's map (unconfirmed). Shift + button sends
 * the same note (Mixxx's map has no shifted note for them; unconfirmed). Correct a byte here and nowhere else.
 */
export const FX_SELECT_NOTES: readonly (readonly [number, number])[] = [
  [0x98, 0x00], [0x98, 0x01], [0x98, 0x02], [0x99, 0x03], [0x99, 0x04], [0x99, 0x05],
];
const fxButtonOf = (status: number, d1: number) => FX_SELECT_NOTES.findIndex(([s, n]) => s === status && n === d1);
/** Headphone knobs on BF, 7-bit absolute (hardware capture 2026-11-24). Which is which follows Mixxx's map and is not
 * confirmed on the hardware: swap the two numbers if the knobs turn out the other way round. */
export const CUE_GAIN_CC = 0x0c;
export const CUE_MIX_CC = 0x0d;

const delta7 = (v: number) => (v >= 64 ? v - 128 : v);
const key = (k: string, code: string, shiftKey = false): MidiOutput => ({ kind: "key", key: k, code, shiftKey });
const deckOf = (ch: number): DeckId => (ch === 0 ? "A" : "B");
/** Pad mode buttons (9(4+n)): Cue 00 / Shift 02, Auto Loop 0D (tag bank), Sampler 0B / Shift 0F (status bank). */
const PAD_MODE_NOTES: Record<number, PadBank> = { 0x00: "cue", 0x02: "cue", 0x0d: "tag", 0x0b: "status", 0x0f: "status" };
/** Auto Loop row (9(4+n)) with Shift variants in the comment: 40 on/off (41), 34 half (36 loop in), 35 double (37 loop out). */
const LOOP_NOTES: Record<number, DeckCommand["cmd"]> = { 0x40: "loop-toggle", 0x34: "loop-half", 0x35: "loop-double", 0x36: "loop-in", 0x37: "loop-out" };

/** A pad press off /tag: what it does depends on the deck's pad bank. Shift + pad is d1 >= 0x1C. */
function padOutputs(deck: DeckId, d1: number, bank: PadBank): MidiOutput[] {
  const pad = (d1 - 0x14) % 8;
  const shifted = d1 >= 0x1c;
  if (bank === "tag") return [{ kind: "deck", deck, cmd: "tag", value: pad + (shifted ? 8 : 0) }];
  if (bank === "status") return !shifted && pad < STATUS_PAD_KEYS.length ? [{ kind: "deck", deck, cmd: "status", value: pad }] : [];
  return [{ kind: "deck", deck, cmd: shifted ? "pad-delete" : "pad", value: pad }];
}

/** decodeMidi's result when no mapping matched: compared by identity, so a handled message that yields nothing (a pitch MSB, a jog
 * standstill, a Load press) is never mistaken for an unknown one. Never mutated. */
const UNHANDLED: MidiOutput[] = [];
export const isUnhandled = (outputs: MidiOutput[]) => outputs === UNHANDLED;

/** Pure decoder: one [status, data1, data2] triple -> outputs; mutates `state`. */
export function decodeMidi(
  [status, d1, d2]: [number, number, number],
  state: MidiState,
  ctx: MidiContext = { tagRoute: false, now: 0 },
): MidiOutput[] {
  const type = status & 0xf0;
  const ch = status & 0x0f;
  const press = type === 0x90 && d2 > 0;

  if ((status === 0x90 || status === 0x91 || status === 0x80 || status === 0x81) && d1 === 0x20) {
    state.shift = press;
    return [];
  }
  if (press && (status === 0x90 || status === 0x91) && d1 === 0x00) {
    return [{ kind: "deck", deck: deckOf(ch), cmd: "toggle", value: 0 }];
  }
  if (press && status === 0x94 && d1 >= 0x14 && d1 <= 0x23) {
    if (!ctx.tagRoute) return padOutputs("A", d1, state.bank.A);
    const n = ((d1 - 0x14) % 8) + 1;
    return [key(String(n), `Digit${n}`, d1 >= 0x1c)];
  }
  if (press && status === 0x95 && d1 >= 0x14 && d1 <= (ctx.tagRoute ? 0x1a : 0x23)) {
    if (!ctx.tagRoute) return padOutputs("B", d1, state.bank.B);
    const k = STATUS_PAD_KEYS[d1 - 0x14];
    return [key(k, `Key${k.toUpperCase()}`)];
  }
  if (press && (status === 0x94 || status === 0x95) && PAD_MODE_NOTES[d1]) {
    state.bank[deckOf(ch - 4)] = PAD_MODE_NOTES[d1];
    return [{ kind: "bank", deck: deckOf(ch - 4), bank: PAD_MODE_NOTES[d1] }];
  }
  if (press && (status === 0x94 || status === 0x95) && LOOP_NOTES[d1]) return [{ kind: "deck", deck: deckOf(ch - 4), cmd: LOOP_NOTES[d1], value: 0 }];
  // FX buttons: by default a transition note, unit 1 (the first three) for deck A and unit 2 for deck B: 1 good, 2 ok,
  // 3 clash. With «Τα κουμπιά FX διαλέγουν εφέ» on: the button's effect on both decks, Shift + button stores it.
  const fxButton = press ? fxButtonOf(status, d1) : -1;
  if (fxButton >= 0) {
    if (ctx.fxPick) return [state.shift ? { kind: "fxrack", control: "store", button: fxButton } : { kind: "fxrack", control: "pick", button: fxButton }];
    return [{ kind: "deck", deck: fxButton < 3 ? "A" : "B", cmd: "note", value: fxButton % 3 }];
  }
  // Browse turn: BF 00, or BF 01 with Shift held on the controller (fast scroll, x10).
  if (status === 0xbf && (d1 === 0x00 || d1 === 0x01)) {
    const d = delta7(d2) * (d1 === 0x01 ? BROWSE_SHIFT_MULTIPLIER : 1);
    return d === 0 ? [] : [{ kind: "action", action: { type: "browse", delta: d } }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x06) {
    const d = delta7(d2);
    if (d === 0) return [];
    if (!state.shift && ctx.nudge?.(deckOf(ch))) return [{ kind: "mixer", control: "nudge", deck: deckOf(ch), dir: d > 0 ? 1 : -1 }];
    return [{ kind: "deck", deck: deckOf(ch), cmd: "seek", value: d * (state.shift ? JOG_SHIFT_SECONDS_PER_TICK : JOG_SECONDS_PER_TICK) }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x1c) {
    return [{ kind: "mixer", control: "volume", deck: deckOf(ch), value: d2 / 127 }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && EQ_CC[d1]) {
    return [{ kind: "mixer", control: "eq", deck: deckOf(ch), band: EQ_CC[d1], value: ccToBipolar(d2) }];
  }
  // Trim knob (Bn 16) and master gain (BE 23, 0..1), from the hardware capture.
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x16) {
    return [{ kind: "mixer", control: "trim", deck: deckOf(ch), value: ccToBipolar(d2) }];
  }
  if (status === 0xbe && d1 === 0x23) return [{ kind: "mixer", control: "master", value: d2 / 127 }];
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x1a) {
    return [{ kind: "mixer", control: "filter", deck: deckOf(ch), value: ccToBipolar(d2) }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x09) {
    state.pitchMsb[deckOf(ch)] = d2;
    return [];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x29) {
    const msb = state.pitchMsb[deckOf(ch)];
    if (msb === null) return [];
    const raw = (((msb << 7) | d2) / 16383) * 2 - 1;
    return [{ kind: "mixer", control: "pitch", deck: deckOf(ch), value: PITCH_TOP_IS_SLOWER ? raw : -raw }];
  }
  if ((type === 0x90 || type === 0x80) && (ch === 0 || ch === 1) && (d1 === 0x0b || d1 === 0x0c || d1 === 0x2b || d1 === 0x2c)) {
    // Any release clears the bend, including Shift being pressed mid-hold (the pad then reports 0x2B/0x2C).
    if (!press) return [{ kind: "mixer", control: "bend", deck: deckOf(ch), dir: 0 }];
    if (d1 === 0x2b) return [{ kind: "mixer", control: "keylock", deck: deckOf(ch) }];
    if (d1 === 0x2c) return [{ kind: "deck", deck: deckOf(ch), cmd: "range", value: 0 }];
    if (d1 === 0x0b || d1 === 0x0c) return [{ kind: "mixer", control: "bend", deck: deckOf(ch), dir: d1 === 0x0b ? 1 : -1 }];
    return [];
  }
  if (status === 0xbf && d1 === 0x08) {
    return [{ kind: "mixer", control: "crossfader", value: d2 / 63.5 - 1 }];
  }
  // Cue: 01, or 05 with Shift (hardware capture). Either release ends a preview, so Shift pressed mid-hold can't strand it.
  if ((status === 0x90 || status === 0x91 || status === 0x80 || status === 0x81) && (d1 === 0x01 || d1 === 0x05)) {
    return press ? [{ kind: "deck", deck: deckOf(ch), cmd: "cue", value: d1 === 0x05 ? 1 : 0 }]
      : [{ kind: "deck", deck: deckOf(ch), cmd: "cue-release", value: 0 }];
  }
  // Sync: 02 (one-shot). Shift + Sync (03) is unused.
  if (press && (status === 0x90 || status === 0x91) && d1 === 0x02) return [{ kind: "deck", deck: deckOf(ch), cmd: "sync", value: 0 }];
  // Browse push: 07 unshifted = play the selection, 06 with Shift = cycle list focus (hardware capture; the Mixxx map has them swapped).
  if (press && status === 0x9f && d1 === 0x07) return [{ kind: "action", action: { type: "play" } }];
  if (press && status === 0x9f && d1 === 0x06) return [{ kind: "action", action: { type: "cycle-focus" } }];
  if ((status === 0x9f || status === 0x8f) && (d1 === 0x02 || d1 === 0x03)) {
    const loadDeck = d1 === 0x02 ? "A" : "B";
    if (press) {
      // Shift is decided at press (the notes are the same with Shift); Load tap/hold itself resolves on release.
      if (state.shift) { state.loadPressedAt[loadDeck] = null; return [{ kind: "action", action: { type: "eject", deck: loadDeck } }]; }
      state.loadPressedAt[loadDeck] = ctx.now;
      return [];
    }
    const pressedAt = state.loadPressedAt[loadDeck];
    state.loadPressedAt[loadDeck] = null;
    if (pressedAt === null) return [];
    return [{ kind: "action", action: ctx.now - pressedAt >= LOAD_HOLD_MS ? { type: "add-to-set" } : { type: "load-deck", deck: loadDeck } }];
  }
  // FX paddle: only a change acts; the first value after a connect (the position dump) is the baseline. Other values are ignored.
  if ((status === 0xb8 || status === 0xb9) && d1 === PADDLE_CC) {
    if (d2 !== PADDLE_RELEASE && d2 !== PADDLE_LATCH && d2 !== PADDLE_HOLD) return [];
    const paddleDeck = status === 0xb8 ? "A" : "B";
    const prev = state.paddle[paddleDeck];
    state.paddle[paddleDeck] = d2;
    return prev === null || prev === d2 ? [] : [{ kind: "fxrack", control: "paddle", deck: paddleDeck, value: d2 }];
  }
  if (status === 0xb8 && d1 === FX_WET_DRY_CC) return [{ kind: "fxrack", control: "amount", value: d2 / 127 }];
  if (status === 0xb8 && d1 === FX_BEATS_CC) {
    const d = delta7(d2);
    return d === 0 ? [] : [{ kind: "fxrack", control: state.shift ? "step" : "beats", value: d > 0 ? 1 : -1 }];
  }
  // Headphone knobs, 0..1: shown in the mixer, no sound yet (there is no headphone output).
  if (status === 0xbf && d1 === CUE_GAIN_CC) return [{ kind: "mixer", control: "cueGain", value: d2 / 127 }];
  if (status === 0xbf && d1 === CUE_MIX_CC) return [{ kind: "mixer", control: "cueMix", value: d2 / 127 }];
  // Known and unused on purpose, so not logged: B9 04, which the position dump sends beside the one Wet/Dry knob (B8 04),
  // and B9 05, which every BEATS turn sends beside B8 05.
  if (status === 0xb9 && (d1 === FX_WET_DRY_CC || d1 === FX_BEATS_CC)) return [];
  // Everything else is ignored (the bridge logs it for Settings).
  return UNHANDLED;
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

/**
 * Sums jog seeks per deck across events and emits one seek per deck per interval.
 * Any other deck command flushes pending seeks first, so ordering is preserved.
 */
export function createDeckBus(
  emit: (command: DeckCommand) => void,
  timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
  delay = JOG_FLUSH_MS,
) {
  const pending: Record<DeckId, number> = { A: 0, B: 0 };
  let handle: unknown = null;
  function flush() {
    if (handle !== null) { timers.clear(handle); handle = null; }
    for (const deck of ["A", "B"] as const) {
      const value = pending[deck];
      pending[deck] = 0;
      if (value !== 0) emit({ deck, cmd: "seek", value });
    }
  }
  return {
    flush,
    send(command: DeckCommand) {
      if (command.cmd !== "seek") { flush(); emit(command); return; }
      pending[command.deck] += command.value;
      handle ??= timers.set(() => { handle = null; flush(); }, delay);
    },
  };
}

/**
 * «Jog nudge»: each tick holds the deck's bend in the turn's direction (the bend buttons' own bend, with their ramp and
 * their place in the Sync lock), and the bend lets go `releaseMs` after the last tick. `active`: the deck's bend is the
 * nudge's, so the jog may go on driving it.
 */
export function createJogNudge(
  setBend: (deck: DeckId, dir: -1 | 0 | 1, now: number) => void,
  timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
  releaseMs = JOG_NUDGE_RELEASE_MS,
) {
  const handles: Record<DeckId, unknown> = { A: null, B: null };
  /** Forget the nudge and leave the bend as it is: a bend button took over. */
  function cancel(deck: DeckId) {
    if (handles[deck] !== null) { timers.clear(handles[deck]); handles[deck] = null; }
  }
  return {
    active: (deck: DeckId) => handles[deck] !== null,
    cancel,
    /** Let go of the bend now if the nudge holds it (disconnect, teardown); a bend the nudge does not hold is left alone. */
    release(deck: DeckId) {
      if (handles[deck] === null) return;
      cancel(deck);
      setBend(deck, 0, 0);
    },
    tick(deck: DeckId, dir: -1 | 1, now: number) {
      cancel(deck);
      setBend(deck, dir, now);
      handles[deck] = timers.set(() => { handles[deck] = null; setBend(deck, 0, 0); }, releaseMs);
    },
  };
}

/**
 * With «Jog nudge» on, whether an unshifted jog turn nudges the deck: it plays on the stretch engine (an element deck is
 * pinned at 1x, so a bend would do nothing there), no transition owns it, and its bend is free or already the nudge's
 * (a held bend button keeps the jog as it was). Otherwise the jog moves the playhead, as before.
 */
export function nudgeAllowed(deck: { playing: boolean; onEngine: boolean } | null, owned: boolean, bendDir: number, nudging: boolean): boolean {
  return deck !== null && deck.playing && deck.onEngine && !owned && (bendDir === 0 || nudging);
}

export function installMidiBridge(): () => void {
  const state = createMidiState();
  const bus = createDeckBus(detail => window.dispatchEvent(new CustomEvent<DeckCommand>("cratemind:deck", { detail })));
  const nudge = createJogNudge(setDeckBend);
  const knobs = createKnobMoves();
  // With the switch off a jog turn reads one preference and nothing else.
  const canNudge = (deck: DeckId) => getPref("jogNudge")
    && nudgeAllowed(deckTransportOf(deck), transportOwnerOf(deck) !== null, getMixer().fx[deck].bend.dir, nudge.active(deck));
  let deckLayerWarnedAt: number | null = null;
  // What each deck's FX picker reads: no track (no picker), or whether the track has a BPM.
  const deckTempo = (deck: DeckId): DeckTempo => {
    const t = deckTransportOf(deck);
    return !t || t.trackId === null ? "empty" : t.trackBpm != null ? "bpm" : "none";
  };

  function onMidi(e: Event) {
    const detail = (e as CustomEvent).detail;
    if (!Array.isArray(detail)) return;
    const ctx: MidiContext = { tagRoute: window.location.pathname === "/tag", now: performance.now(), nudge: canNudge, fxPick: getPref("fxButtonsPickEffect") };
    for (const m of detail) {
      if (!Array.isArray(m) || m.length !== 3 || !m.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      const msg = m as [number, number, number];
      const outputs = decodeMidi(msg, state, ctx);
      // The FX pickers a Shift + BEATS step opened close as soon as Shift is up (a no-op while they are closed).
      if (!state.shift) setFxPickerPeek(null);
      if (rawMidiLogOn()) noteRawMidi(msg, describeMidiOutputs(outputs, isUnhandled(outputs), msg));
      if (isUnhandled(outputs)) {
        noteUnhandledMidi(msg);
        if (deckLayerWarningDue(msg, deckLayerWarnedAt, ctx.now)) {
          deckLayerWarnedAt = ctx.now;
          toast.warning("Ο controller είναι στο layer Deck 3/4. Πάτησε το κουμπί deck για να γυρίσεις στο Deck 1/2.");
        }
      }
      for (const o of outputs) {
        if (o.kind === "key") {
          bus.flush();
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: o.key, code: o.code, shiftKey: o.shiftKey, bubbles: true, cancelable: true }));
        } else if (o.kind === "deck") {
          if (!isDeckCommandBlocked(o.cmd, hasOpenSurface())) bus.send(o);
        } else if (o.kind === "mixer") {
          if (o.control === "volume") setMixerVolume(o.deck, o.value);
          else if (o.control === "crossfader") setCrossfader(o.value);
          else if (o.control === "eq") setDeckEq(o.deck, o.band, o.value);
          else if (o.control === "filter") setDeckFilter(o.deck, o.value);
          else if (o.control === "pitch") setDeckPitchFromController(o.deck, o.value);
          else if (o.control === "trim") setDeckTrim(o.deck, o.value);
          else if (o.control === "master") setMasterGain(o.value);
          else if (o.control === "cueGain") setCueGain(o.value);
          else if (o.control === "cueMix") setCueMix(o.value);
          else if (o.control === "bend") { nudge.cancel(o.deck); setDeckBend(o.deck, o.dir, ctx.now); }
          else if (o.control === "nudge") nudge.tick(o.deck, o.dir, ctx.now);
          else toggleKeylock(o.deck);
        } else if (o.kind === "bank") {
          setPadBank(o.deck, o.bank);
        } else if (o.kind === "fxrack") {
          // Not guarded by hasOpenSurface: a held effect must always be able to end.
          if (o.control === "paddle") paddle(o.deck, o.value);
          else if (o.control === "amount") controllerAmount(o.value);
          else if (o.control === "beats") controllerBeats(o.value);
          else if (o.control === "step") { const on = controllerStep(o.value, deckTempo, stepDeck(lastPlayingDeck(), getLastFxDeck())); if (on) setFxPickerPeek(on); }
          else if (o.control === "pick") controllerPick(o.button, deckTempo, stepDeck(lastPlayingDeck(), getLastFxDeck()));
          else controllerStore(o.button, stepDeck(lastPlayingDeck(), getLastFxDeck()));
        } else if (!hasOpenSurface()) {
          bus.flush();
          window.dispatchEvent(new CustomEvent<MidiAction>("cratemind:midi-action", { detail: o.action }));
        }
        knobs.note(o); // after the store has the value: shows the turned knob's pill
      }
    }
  }
  function onStatus(e: Event) {
    const connected = (e as CustomEvent).detail?.connected;
    if (typeof connected !== "boolean") return;
    if (!connected) {
      // A held nudge goes now, even when setMidiConnected(false) below finds the controller already counted as gone.
      nudge.release("A"); nudge.release("B");
      state.pitchMsb = { A: null, B: null }; state.bank = { A: "cue", B: "cue" }; state.paddle = { A: null, B: null };
      resetPadBanks();
      knobs.reset();
      controllerDisconnected();
    }
    setMidiConnected(connected);
  }

  window.addEventListener("cratemind:midi", onMidi);
  window.addEventListener("cratemind:midi-status", onStatus);
  return () => {
    bus.flush();
    nudge.cancel("A"); nudge.cancel("B");
    releaseBends();
    window.removeEventListener("cratemind:midi", onMidi);
    window.removeEventListener("cratemind:midi-status", onStatus);
  };
}
