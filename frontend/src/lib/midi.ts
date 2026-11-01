// MIDI bridge: the Tauri host forwards raw MIDI as window "cratemind:midi" events.
// Pads on /tag become synthetic keydown events so the single keyboard map stays
// the source of truth (every guard in keyboardGuard.ts keeps applying); deck
// transport goes to the MiniPlayers via "cratemind:deck" and faders to lib/mixer.ts.
// Mapping source: Mixxx's "Numark Mixtrack Platinum FX" mapping.
import { hasOpenSurface } from "./keyboardGuard";
import { ccToBipolar, releaseBends, setCrossfader, setDeckBend, setDeckEq, setDeckFilter, setDeckPitchFromController, setDeckTrim, setMasterGain, setMidiConnected, setMixerVolume, toggleKeylock, type EqBand } from "./mixer";
import { resetPadBanks, setPadBank, type PadBank } from "./padBank";
import type { DeckId } from "./player";
import { STATUS_PAD_KEYS } from "./tagKeys";

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

/** Seconds of seek per jog tick (x10 with Shift); to be tuned live. */
export const JOG_SECONDS_PER_TICK = 0.05;
/** Jog seeks are summed across events and flushed at most this often. */
export const JOG_FLUSH_MS = 30;

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
  | { kind: "mixer"; control: "bend"; deck: DeckId; dir: -1 | 0 | 1 }
  | { kind: "mixer"; control: "keylock"; deck: DeckId };
/**
 * `loadPressedAt`: press time per Load button, decided on release (tap = load, hold = add to set).
 * `pitchMsb`: last coarse byte of the 14-bit pitch fader per deck; null until seen and after disconnect.
 */
export type MidiState = { shift: boolean; loadPressedAt: Record<DeckId, number | null>; pitchMsb: Record<DeckId, number | null>; bank: Record<DeckId, PadBank> };
/** `tagRoute`: on /tag the pads keep their v1 meaning (digits / tagging letters). `now`: ms clock. */
export type MidiContext = { tagRoute: boolean; now: number };
export const createMidiState = (): MidiState => ({ shift: false, loadPressedAt: { A: null, B: null }, pitchMsb: { A: null, B: null }, bank: { A: "cue", B: "cue" } });
const EQ_CC: Record<number, EqBand> = { 0x17: "hi", 0x18: "mid", 0x19: "lo" };
/** Load held at least this long (ms) adds to the set instead of loading the deck. */
export const LOAD_HOLD_MS = 800;

/** Browse turns reported as BF 01 (Shift held) move this many rows per tick. */
export const BROWSE_SHIFT_MULTIPLIER = 10;

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
  // Transition note: FX unit 1 select is 98 00-02, unit 2 is 99 03-05 (hardware capture): 1 good, 2 ok, 3 clash.
  if (press && ((status === 0x98 && d1 <= 0x02) || (status === 0x99 && d1 >= 0x03 && d1 <= 0x05))) {
    return [{ kind: "deck", deck: status === 0x98 ? "A" : "B", cmd: "note", value: d1 % 3 }];
  }
  // Browse turn: BF 00, or BF 01 with Shift held on the controller (fast scroll, x10).
  if (status === 0xbf && (d1 === 0x00 || d1 === 0x01)) {
    const d = delta7(d2) * (d1 === 0x01 ? BROWSE_SHIFT_MULTIPLIER : 1);
    return d === 0 ? [] : [{ kind: "action", action: { type: "browse", delta: d } }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x06) {
    const d = delta7(d2);
    if (d === 0) return [];
    return [{ kind: "deck", deck: deckOf(ch), cmd: "seek", value: d * JOG_SECONDS_PER_TICK * (state.shift ? 10 : 1) }];
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
  // Everything else is ignored.
  return [];
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

export function installMidiBridge(): () => void {
  const state = createMidiState();
  const bus = createDeckBus(detail => window.dispatchEvent(new CustomEvent<DeckCommand>("cratemind:deck", { detail })));

  function onMidi(e: Event) {
    const detail = (e as CustomEvent).detail;
    if (!Array.isArray(detail)) return;
    const ctx = { tagRoute: window.location.pathname === "/tag", now: performance.now() };
    for (const m of detail) {
      if (!Array.isArray(m) || m.length !== 3 || !m.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      for (const o of decodeMidi(m as [number, number, number], state, ctx)) {
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
          else if (o.control === "bend") setDeckBend(o.deck, o.dir, ctx.now);
          else toggleKeylock(o.deck);
        } else if (o.kind === "bank") {
          setPadBank(o.deck, o.bank);
        } else if (!hasOpenSurface()) {
          bus.flush();
          window.dispatchEvent(new CustomEvent<MidiAction>("cratemind:midi-action", { detail: o.action }));
        }
      }
    }
  }
  function onStatus(e: Event) {
    const connected = (e as CustomEvent).detail?.connected;
    if (typeof connected !== "boolean") return;
    if (!connected) { state.pitchMsb = { A: null, B: null }; state.bank = { A: "cue", B: "cue" }; resetPadBanks(); }
    setMidiConnected(connected);
  }

  window.addEventListener("cratemind:midi", onMidi);
  window.addEventListener("cratemind:midi-status", onStatus);
  return () => {
    bus.flush();
    releaseBends();
    window.removeEventListener("cratemind:midi", onMidi);
    window.removeEventListener("cratemind:midi-status", onStatus);
  };
}
