// MIDI bridge: the Tauri host forwards raw MIDI as window "cratemind:midi" events.
// We turn it into synthetic keydown events so the single keyboard map stays the
// source of truth and every existing guard (keyboardGuard.ts) keeps applying.
// Mapping source: Mixxx's "Numark Mixtrack Platinum FX" mapping.
import { hasOpenSurface } from "./keyboardGuard";

export type MidiAction = { type: "load" | "add-to-set" };

/** Jog ticks per emitted seek step; to be tuned live. */
export const JOG_TICKS_PER_STEP = 24;

const DECK2_PAD_KEYS = ["a", "w", "x", "b", "p", "r", "m"];

export type MidiOutput =
  | { kind: "key"; key: string; code: string; shiftKey: boolean }
  | { kind: "action"; type: MidiAction["type"] };
export type MidiState = { shift: boolean; jog: [number, number] };
export const createMidiState = (): MidiState => ({ shift: false, jog: [0, 0] });

const delta7 = (v: number) => (v >= 64 ? v - 128 : v);
const key = (k: string, code: string, shiftKey = false): MidiOutput => ({ kind: "key", key: k, code, shiftKey });

/** Pure decoder: one [status, data1, data2] triple -> outputs; mutates `state`. */
export function decodeMidi([status, d1, d2]: [number, number, number], state: MidiState): MidiOutput[] {
  const type = status & 0xf0;
  const ch = status & 0x0f;
  const press = type === 0x90 && d2 > 0;

  if ((status === 0x90 || status === 0x91 || status === 0x80 || status === 0x81) && d1 === 0x20) {
    state.shift = press;
    return [];
  }
  if (press && (status === 0x90 || status === 0x91) && d1 === 0x00) return [key(" ", "Space")];
  if (press && status === 0x94 && d1 >= 0x14 && d1 <= 0x23) {
    const n = ((d1 - 0x14) % 8) + 1;
    return [key(String(n), `Digit${n}`, d1 >= 0x1c)];
  }
  if (press && status === 0x95 && d1 >= 0x14 && d1 <= 0x1a) {
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
    if (Math.sign(d) !== Math.sign(state.jog[ch])) state.jog[ch] = 0;
    state.jog[ch] += d;
    const steps = Math.trunc(Math.abs(state.jog[ch]) / JOG_TICKS_PER_STEP);
    if (steps === 0) return [];
    const k = state.jog[ch] > 0 ? "ArrowRight" : "ArrowLeft";
    state.jog[ch] -= Math.sign(state.jog[ch]) * steps * JOG_TICKS_PER_STEP;
    return Array.from({ length: steps }, () => key(k, k, state.shift));
  }
  if (press && status === 0x9f) {
    if (d1 === 0x06) return [{ kind: "action", type: "load" }];
    if (d1 === 0x02 || d1 === 0x03) return [{ kind: "action", type: "add-to-set" }];
  }
  // Everything else (crossfader, volume, pitch, cue, ...) is ignored in v1;
  // a 2-deck mixer comes in a later, separately planned change.
  return [];
}

export function installMidiBridge(): () => void {
  const state = createMidiState();

  function onMidi(e: Event) {
    const detail = (e as CustomEvent).detail;
    if (!Array.isArray(detail)) return;
    for (const m of detail) {
      if (!Array.isArray(m) || m.length !== 3 || !m.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      for (const o of decodeMidi(m as [number, number, number], state)) {
        if (o.kind === "key") {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: o.key, code: o.code, shiftKey: o.shiftKey, bubbles: true, cancelable: true }));
        } else if (!hasOpenSurface()) {
          window.dispatchEvent(new CustomEvent<MidiAction>("cratemind:midi-action", { detail: { type: o.type } }));
        }
      }
    }
  }

  window.addEventListener("cratemind:midi", onMidi);
  return () => window.removeEventListener("cratemind:midi", onMidi);
}
