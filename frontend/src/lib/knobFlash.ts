// Controller knob turns announced to the on-screen knobs, so a Knob shows its value pill for a moment (Knob's `controlId`).
// Only the MIDI bridge announces: a transition, deck rescue, a track load or a reset changes the same values and shows nothing.
import type { EqBand } from "./mixer";
import type { MidiOutput } from "./midi";
import type { DeckId } from "./player";

/** The pill hides this long (ms) after the controller last moved the knob. */
export const KNOB_FLASH_MS = 1000;

/** One identity per on-screen knob the controller drives. The one Wet/Dry knob drives the WET of one deck at a time. */
export const KNOB_ID = {
  eq: (deck: DeckId, band: EqBand) => `eq:${deck}:${band}`,
  trim: (deck: DeckId) => `trim:${deck}`,
  filter: (deck: DeckId) => `filter:${deck}`,
  cueGain: "cueGain",
  cueMix: "cueMix",
  fxWet: (deck: DeckId) => `fxWet:${deck}`,
} as const;

/** The knob a decoded MIDI output turns and the value it sends, or null when it turns no on-screen knob. `fxDeck` is the
 * deck the shared Wet/Dry knob acts on now (none: it turns nothing); `key` names the physical knob when it is not the id. */
export function knobMove(o: MidiOutput, fxDeck: DeckId | null = null): { id: string; value: number; key?: string } | null {
  if (o.kind === "fxrack") return o.control === "amount" && fxDeck ? { id: KNOB_ID.fxWet(fxDeck), value: o.value, key: "fxWet" } : null;
  if (o.kind !== "mixer") return null;
  if (o.control === "eq") return { id: KNOB_ID.eq(o.deck, o.band), value: o.value };
  if (o.control === "trim" || o.control === "filter") return { id: KNOB_ID[o.control](o.deck), value: o.value };
  if (o.control === "cueGain" || o.control === "cueMix") return { id: KNOB_ID[o.control], value: o.value };
  return null;
}

const listeners = new Map<string, Set<() => void>>();

export function announceKnob(id: string) {
  listeners.get(id)?.forEach(fn => fn());
}

export function onKnobMove(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(id);
  };
}

/**
 * The bridge's side: announces a knob when the controller sends it a new value. The first value of each knob after a connect
 * (the position dump) is only its baseline, so connecting the controller flashes nothing; `reset` on disconnect.
 */
export function createKnobMoves(announce: (id: string) => void = announceKnob, fxDeck: () => DeckId | null = () => null) {
  const last = new Map<string, number>(); // per physical knob, so a change of the Wet/Dry knob's deck is no new baseline
  return {
    note(o: MidiOutput) {
      const move = knobMove(o, fxDeck());
      if (!move) return;
      const key = move.key ?? move.id;
      const prev = last.get(key);
      last.set(key, move.value);
      if (prev !== undefined && prev !== move.value) announce(move.id);
    },
    reset: () => last.clear(),
  };
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * The knob's side: `show(true)` on each announced move of `id`, `show(false)` `ms` after the last one. No timer runs until a
 * move; the returned function unsubscribes and clears the timer.
 */
export function watchKnobFlash(id: string, show: (on: boolean) => void, timers: Timers = realTimers, ms = KNOB_FLASH_MS): () => void {
  let handle: unknown = null;
  const off = onKnobMove(id, () => {
    if (handle !== null) timers.clear(handle);
    show(true);
    handle = timers.set(() => { handle = null; show(false); }, ms);
  });
  return () => {
    off();
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}
