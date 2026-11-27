/**
 * Shift + BEATS on the controller steps both decks through the effect list. While Shift stays down after a step, both
 * decks' FX pickers show their list on the effect just chosen, so its family and neighbours can be read; they close
 * when Shift is let go (the MIDI bridge sets both) or when one is dismissed by hand.
 */
let peek = false;
const listeners = new Set<() => void>();

export const fxPickerPeek = () => peek;
export function setFxPickerPeek(on: boolean) {
  if (on === peek) return;
  peek = on;
  listeners.forEach(listener => listener());
}
export function subscribeFxPickerPeek(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
