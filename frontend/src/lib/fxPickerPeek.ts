import type { DeckId } from "./player";

/**
 * Shift + BEATS on the controller steps one deck through the effect list. While Shift stays down after a step, that
 * deck's FX picker shows its list on the effect just chosen, so its family and neighbours can be read; it closes when
 * Shift is let go (the MIDI bridge sets both) or when it is dismissed by hand.
 */
let peek: DeckId | null = null;
const listeners = new Set<() => void>();

export const fxPickerPeek = () => peek;
export function setFxPickerPeek(deck: DeckId | null) {
  if (deck === peek) return;
  peek = deck;
  listeners.forEach(listener => listener());
}
export function subscribeFxPickerPeek(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
