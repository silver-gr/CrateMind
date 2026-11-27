// The controller's six FX buttons as effect pickers («Τα κουμπιά FX διαλέγουν εφέ», off by default: off, they are the
// transition-note buttons), and Shift + BEATS stepping through the effect list. Both act on both decks at once, through
// the same store call and the same rules as each deck's on-screen picker (FxRackPicker): nothing while the rack is
// unavailable, and a deck whose track has no BPM keeps its effect when the new one needs a BPM.
import { toast } from "sonner";
import { getFxRack, selectPreset } from "./fxRack";
import { FX_PRESETS, needsBpm, presetById } from "./fxRack/presets";
import type { DeckId } from "./player";
import { getPref, setPref } from "./prefs";

/** The printed names, in the order of `FX_SELECT_NOTES` in midi.ts (button 0..5). */
export const FX_BUTTON_LABELS = ["HPF", "LPF", "FLANGER", "ECHO", "REVERB", "PHASER"] as const;
/** Each button's effect until the owner stores another: the rack preset that does what its name says. */
export const DEFAULT_FX_BUTTON_PRESETS: readonly string[] = ["highpass", "lowpass", "flanger", "echo", "reverb", "phaser"];

const DECKS = ["A", "B"] as const;
const TOAST_ID = "cm-fx-buttons";

/** The six assignments: saved ids, with an unknown, missing or malformed entry falling back to its default. */
export function fxButtonPresets(saved: unknown = getPref("fxButtonPresets")): string[] {
  const list = Array.isArray(saved) ? saved : [];
  return DEFAULT_FX_BUTTON_PRESETS.map((def, i) => (typeof list[i] === "string" && presetById(list[i]) ? list[i] : def));
}

/** What a deck's picker would say: "empty" (no track: no picker, any effect is kept for the next track), "bpm" or "none". */
export type DeckTempo = "empty" | "bpm" | "none";
export type DeckTempoOf = (deck: DeckId) => DeckTempo;

/** The picker's rule for one deck: a preset that needs a BPM is disabled on a deck whose track has none. */
export const canTake = (tempo: DeckTempo, id: string) => {
  const p = presetById(id);
  return !!p && !(tempo === "none" && needsBpm(p));
};

/** The last effect the controller chose, and both decks' effects right after: while the decks still show those, stepping
 * goes on from it, so a preset neither deck could take is still a step of its own. */
let cursor: { id: string; A: string; B: string } | null = null;

/** The effect the controller treats as current: the cursor while the decks are as it left them; else the deck that changed
 * since (B only when A did not), else Deck A's. */
export function controllerEffect(): string {
  const { A, B } = getFxRack().decks;
  if (cursor && cursor.A === A.preset && cursor.B === B.preset) return cursor.id;
  if (cursor && cursor.A === A.preset && cursor.B !== B.preset) return B.preset;
  return A.preset;
}

export type PickResult = { id: string; took: DeckId[]; refused: DeckId[] };

/** Sets `id` on every deck that can take it, like picking it in each deck's picker; null while the rack is unavailable. */
export function pickEffect(id: string, tempoOf: DeckTempoOf): PickResult | null {
  if (!getFxRack().available || !presetById(id)) return null;
  const took: DeckId[] = [], refused: DeckId[] = [];
  for (const deck of DECKS) {
    if (canTake(tempoOf(deck), id)) { selectPreset(deck, id); took.push(deck); } else refused.push(deck);
  }
  const { A, B } = getFxRack().decks;
  cursor = { id, A: A.preset, B: B.preset };
  return { id, took, refused };
}

/** One step through the whole list in the picker's family order (FX_PRESETS), stopping at the ends: "start" / "end". */
export function stepEffect(dir: -1 | 1, tempoOf: DeckTempoOf): PickResult | "start" | "end" | null {
  if (!getFxRack().available) return null;
  const i = FX_PRESETS.findIndex(p => p.id === controllerEffect()) + dir;
  if (i < 0) return "start";
  if (i >= FX_PRESETS.length) return "end";
  return pickEffect(FX_PRESETS[i].id, tempoOf);
}

/** Shift + button: stores the current effect on that button; returns the effect's id. */
export function storeOnButton(button: number): string | null {
  if (!Number.isInteger(button) || button < 0 || button >= FX_BUTTON_LABELS.length) return null;
  const id = controllerEffect();
  const next = fxButtonPresets();
  next[button] = id;
  setPref("fxButtonPresets", next);
  return id;
}

const nameOf = (id: string) => presetById(id)?.name ?? id;

function notePick(r: PickResult | null) {
  if (!r || r.refused.length === 0) return;
  const where = r.refused.length === 2 ? "και στα δύο decks" : `στο Deck ${r.refused[0]}`;
  toast.warning(`Το «${nameOf(r.id)}» χρειάζεται BPM ${where}· εκεί μένει το εφέ που είχε.`, { id: TOAST_ID });
}

/** Controller entry points (lib/midi.ts): the store call plus a short Greek toast where the screen alone would not say why. */
export function controllerPick(button: number, tempoOf: DeckTempoOf) {
  const id = fxButtonPresets()[button];
  if (id) notePick(pickEffect(id, tempoOf));
}
export function controllerStore(button: number) {
  const id = storeOnButton(button);
  if (id) toast.success(`Το κουμπί ${FX_BUTTON_LABELS[button]} βάζει τώρα το «${nameOf(id)}».`, { id: TOAST_ID });
}
export function controllerStep(dir: -1 | 1, tempoOf: DeckTempoOf) {
  const r = stepEffect(dir, tempoOf);
  if (r === "start" || r === "end") toast(r === "start" ? "Πρώτο εφέ της λίστας." : "Τελευταίο εφέ της λίστας.", { id: TOAST_ID });
  else notePick(r);
}

/** Test hook. */
export function resetFxButtons() {
  cursor = null;
}
