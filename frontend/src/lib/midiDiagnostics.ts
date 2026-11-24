// Controller diagnostics: a small in-memory log of MIDI messages decodeMidi does not use (never persisted, never sent
// anywhere) and the Deck 3/4 layer check. Pure helpers first, then the store the Settings page reads.
import { useSyncExternalStore } from "react";

export type MidiTriple = [number, number, number];
/** One row of the log: the latest bytes for a status + data1 pair, how often it came and when it was last seen (ms). */
export type UnhandledMidi = { status: number; d1: number; d2: number; count: number; at: number };

export const UNHANDLED_MAX = 30;
/** The Settings list re-renders at most this often (ms), however fast an unused knob sends. */
export const UNHANDLED_PUBLISH_MS = 250;
export const DECK_LAYER_WARN_MS = 30_000;

/** Note-offs (8n, or 9n with velocity 0) are never logged: a press already shows the button, and pad releases would flood the list. */
export const isLoggable = ([status, , d2]: MidiTriple) => {
  const type = status & 0xf0;
  return type !== 0x80 && !(type === 0x90 && d2 === 0);
};

/** Newest first; a repeat of the same status + data1 moves its row to the top and counts up instead of adding a row. */
export function recordUnhandled(ring: readonly UnhandledMidi[], [status, d1, d2]: MidiTriple, at: number, max = UNHANDLED_MAX): UnhandledMidi[] {
  const prev = ring.find(e => e.status === status && e.d1 === d1);
  return [{ status, d1, d2, count: (prev?.count ?? 0) + 1, at }, ...ring.filter(e => e !== prev)].slice(0, max);
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
/** "90 06 7F ×3". */
export const formatUnhandled = (e: UnhandledMidi) => `${hex(e.status)} ${hex(e.d1)} ${hex(e.d2)}${e.count > 1 ? ` ×${e.count}` : ""}`;

/**
 * A message the controller sends only in its Deck 3/4 layer (Mixxx's Platinum FX map): transport and mixer on MIDI
 * channels 3/4 (status low nibble 2/3), pads on channels 7/8 (6/7). Effects (9/10), master (15) and browse/load (16)
 * are shared by both layers, so they never count. Only button presses and jog turns count: the controller's knob and
 * fader position dump must not raise the warning. Note 08 on channels 3/4 is skipped, since it may be the deck switch
 * itself (the Mixxx sources disagree).
 */
export function isDeckLayerMessage([status, d1, d2]: MidiTriple): boolean {
  const type = status & 0xf0;
  const ch = status & 0x0f;
  if (type === 0x90 && d2 > 0) return ch === 6 || ch === 7 || ((ch === 2 || ch === 3) && d1 !== 0x08);
  return type === 0xb0 && (ch === 2 || ch === 3) && d1 === 0x06 && d2 !== 0;
}

/** Warn on a Deck 3/4 layer message, at most once per DECK_LAYER_WARN_MS. */
export const deckLayerWarningDue = (msg: MidiTriple, lastWarnedAt: number | null, now: number) =>
  isDeckLayerMessage(msg) && (lastWarnedAt === null || now - lastWarnedAt >= DECK_LAYER_WARN_MS);

let ring: UnhandledMidi[] = [];
let published = ring;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish() {
  timer = null;
  if (published === ring) return;
  published = ring;
  for (const l of listeners) l();
}

export function noteUnhandledMidi(msg: MidiTriple, at = Date.now()) {
  if (!isLoggable(msg)) return;
  ring = recordUnhandled(ring, msg, at);
  timer ??= setTimeout(publish, UNHANDLED_PUBLISH_MS);
}

export function clearUnhandledMidi() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  ring = [];
  publish();
}

export const getUnhandledMidi = () => published;
export const subscribeUnhandledMidi = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useUnhandledMidi = () => useSyncExternalStore(subscribeUnhandledMidi, getUnhandledMidi, getUnhandledMidi);
