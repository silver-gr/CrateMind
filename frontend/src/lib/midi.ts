// MIDI bridge: the Tauri host forwards raw MIDI as window "cratemind:midi" events.
// Keys/pads/browse become synthetic keydown events so the single keyboard map stays
// the source of truth (every guard in keyboardGuard.ts keeps applying); deck
// transport goes to the MiniPlayers via "cratemind:deck" and faders to lib/mixer.ts.
// Mapping source: Mixxx's "Numark Mixtrack Platinum FX" mapping.
import { hasOpenSurface } from "./keyboardGuard";
import { setCrossfader, setMidiConnected, setMixerVolume } from "./mixer";
import type { DeckId } from "./player";

export type MidiAction = { type: "load" | "add-to-set" } | { type: "load-deck"; deck: DeckId };
export type DeckCommand = { deck: DeckId; cmd: "toggle" | "seek" | "pad"; value: number };

/** Seconds of seek per jog tick (x10 with Shift); to be tuned live. */
export const JOG_SECONDS_PER_TICK = 0.05;
/** Jog seeks are summed across events and flushed at most this often. */
export const JOG_FLUSH_MS = 30;

const DECK2_PAD_KEYS = ["a", "w", "x", "b", "p", "r", "m"];

export type MidiOutput =
  | { kind: "key"; key: string; code: string; shiftKey: boolean }
  | { kind: "action"; action: MidiAction }
  | ({ kind: "deck" } & DeckCommand)
  | { kind: "mixer"; control: "volume"; deck: DeckId; value: number }
  | { kind: "mixer"; control: "crossfader"; value: number };
/** `loadPressedAt`: press time per Load button, decided on release (tap = load, hold = add to set). */
export type MidiState = { shift: boolean; loadPressedAt: Record<DeckId, number | null> };
/** `tagRoute`: on /tag the pads keep their v1 meaning (digits / tagging letters). `now`: ms clock. */
export type MidiContext = { tagRoute: boolean; now: number };
export const createMidiState = (): MidiState => ({ shift: false, loadPressedAt: { A: null, B: null } });
/** Load held at least this long (ms) adds to the set instead of loading the deck. */
export const LOAD_HOLD_MS = 800;

const delta7 = (v: number) => (v >= 64 ? v - 128 : v);
const key = (k: string, code: string, shiftKey = false): MidiOutput => ({ kind: "key", key: k, code, shiftKey });
const deckOf = (ch: number): DeckId => (ch === 0 ? "A" : "B");

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
    if (!ctx.tagRoute) return d1 <= 0x1b ? [{ kind: "deck", deck: "A", cmd: "pad", value: d1 - 0x14 }] : [];
    const n = ((d1 - 0x14) % 8) + 1;
    return [key(String(n), `Digit${n}`, d1 >= 0x1c)];
  }
  if (press && status === 0x95 && d1 >= 0x14 && d1 <= (ctx.tagRoute ? 0x1a : 0x1b)) {
    if (!ctx.tagRoute) return [{ kind: "deck", deck: "B", cmd: "pad", value: d1 - 0x14 }];
    const k = DECK2_PAD_KEYS[d1 - 0x14];
    return [key(k, `Key${k.toUpperCase()}`)];
  }
  if (status === 0xbf && d1 === 0x00) {
    const d = delta7(d2);
    const k = d > 0 ? "j" : "k";
    return Array.from({ length: Math.min(Math.abs(d), 8) }, () => key(k, `Key${k.toUpperCase()}`));
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x06) {
    const d = delta7(d2);
    if (d === 0) return [];
    return [{ kind: "deck", deck: deckOf(ch), cmd: "seek", value: d * JOG_SECONDS_PER_TICK * (state.shift ? 10 : 1) }];
  }
  if (type === 0xb0 && (ch === 0 || ch === 1) && d1 === 0x1c) {
    return [{ kind: "mixer", control: "volume", deck: deckOf(ch), value: d2 / 127 }];
  }
  if (status === 0xbf && d1 === 0x08) {
    return [{ kind: "mixer", control: "crossfader", value: d2 / 63.5 - 1 }];
  }
  if (press && status === 0x9f && (d1 === 0x06 || d1 === 0x07)) return [{ kind: "action", action: { type: "load" } }];
  if ((status === 0x9f || status === 0x8f) && (d1 === 0x02 || d1 === 0x03)) {
    const loadDeck = d1 === 0x02 ? "A" : "B";
    if (press) { state.loadPressedAt[loadDeck] = ctx.now; return []; }
    const pressedAt = state.loadPressedAt[loadDeck];
    state.loadPressedAt[loadDeck] = null;
    if (pressedAt === null) return [];
    return [{ kind: "action", action: ctx.now - pressedAt >= LOAD_HOLD_MS ? { type: "add-to-set" } : { type: "load-deck", deck: loadDeck } }];
  }
  // Everything else (pitch, cue, knobs, ...) is ignored.
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
          bus.send(o);
        } else if (o.kind === "mixer") {
          if (o.control === "volume") setMixerVolume(o.deck, o.value);
          else setCrossfader(o.value);
        } else if (!hasOpenSurface()) {
          bus.flush();
          window.dispatchEvent(new CustomEvent<MidiAction>("cratemind:midi-action", { detail: o.action }));
        }
      }
    }
  }
  function onStatus(e: Event) {
    const connected = (e as CustomEvent).detail?.connected;
    if (typeof connected === "boolean") setMidiConnected(connected);
  }

  window.addEventListener("cratemind:midi", onMidi);
  window.addEventListener("cratemind:midi-status", onStatus);
  return () => {
    bus.flush();
    window.removeEventListener("cratemind:midi", onMidi);
    window.removeEventListener("cratemind:midi-status", onStatus);
  };
}
