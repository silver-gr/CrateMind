import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export type MixerState = { volume: Record<DeckId, number>; crossfader: number; midiConnected: boolean };

let state: MixerState = { volume: { A: 1, B: 1 }, crossfader: 0, midiConnected: false };
const listeners = new Set<() => void>();
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);
function update(next: MixerState) {
  state = next;
  listeners.forEach(listener => listener());
}

export const getMixer = () => state;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useMixer = () => useSyncExternalStore(subscribe, getMixer, getMixer);
export const useMidiConnected = () => useSyncExternalStore(subscribe, () => state.midiConnected, () => state.midiConnected);
export const useDeckGain = (deck: DeckId) => useSyncExternalStore(subscribe, () => deckGain(deck, state), () => deckGain(deck, state));

export function setMixerVolume(deck: DeckId, value: number) {
  update({ ...state, volume: { ...state.volume, [deck]: clamp(value, 0, 1) } });
}
export function setCrossfader(value: number) {
  update({ ...state, crossfader: clamp(value, -1, 1) });
}
export function setMidiConnected(connected: boolean) {
  if (connected !== state.midiConnected) update({ ...state, midiConnected: connected });
}
/** Test hook: restore the initial mixer. */
export function resetMixer() {
  update({ volume: { A: 1, B: 1 }, crossfader: 0, midiConnected: false });
}

/** Squared fader taper times a crossfader that leaves both decks at full gain in the centre. */
export function deckGain(deck: DeckId, s: MixerState): number {
  const x = deck === "A" ? 1 - s.crossfader : 1 + s.crossfader;
  return s.volume[deck] ** 2 * clamp(x, 0, 1);
}

/** Two-deck dock: a controller is connected or Deck B holds a track. */
export function isTwoDeck(midiConnected: boolean, deckBTrack: unknown): boolean {
  return midiConnected || deckBTrack != null;
}
