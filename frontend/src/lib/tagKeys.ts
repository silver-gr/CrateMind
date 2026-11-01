// The tagging key table shared by the /tag page and the controller's pad banks (Auto Loop / Sampler modes).
// One mapping, so a pad press writes exactly what the same key writes on /tag.
import type { Profile } from "./types";

export type TagKeyAction = {
  patch: Partial<Profile>;
  label: string;
  /** /tag also merges the patch into its on-screen profile at once (roles and statuses); energy, darkness and melody just save. */
  optimistic: boolean;
};

/** Status/role bank: pad 1..7 sends these keys (the same letters /tag uses, in the controller's order). */
export const STATUS_PAD_KEYS = ["a", "w", "x", "b", "p", "r", "m"] as const;

/** An active deck reserves 1-8 for cue jumps on /tag, including pads that are currently empty. */
export const isCueJumpKey = (key: string, shiftKey: boolean, playbackOwned: boolean): boolean =>
  /^[1-8]$/.test(key) && !shiftKey && playbackOwned;

/** What a /tag key writes: digits = energy (Shift = darkness, 0 = 10), letters = melody / role / status. */
export function tagKeyAction(key: string, shiftKey: boolean): TagKeyAction | null {
  if (/^[0-9]$/.test(key)) {
    const val = key === "0" ? 10 : Number(key);
    return shiftKey ? { patch: { darkness: val }, label: `σκοτεινότητα ${val}`, optimistic: false }
      : { patch: { energy: val }, label: `ενέργεια ${val}`, optimistic: false };
  }
  switch (key.toLowerCase()) {
    case "m": return { patch: { melody: 8 }, label: "μελωδικό", optimistic: false };
    case "b": return { patch: { set_role: "bridge" }, label: "ρόλος γέφυρα", optimistic: true };
    case "p": return { patch: { set_role: "peak" }, label: "ρόλος κορύφωση", optimistic: true };
    case "r": return { patch: { set_role: "reset" }, label: "ρόλος reset", optimistic: true };
    case "w": return { patch: { personal_status: "weapon" }, label: "ΟΠΛΟ", optimistic: true };
    case "a": return { patch: { personal_status: "approved" }, label: "εγκεκριμένο", optimistic: true };
    case "x": return { patch: { personal_status: "avoid" }, label: "απόφυγε", optimistic: true };
    default: return null;
  }
}

/** Tag bank pads: 0..7 = energy 1..8, 8..15 (Shift + pad) = darkness 1..8. */
export const tagBankAction = (pad: number): TagKeyAction | null =>
  Number.isInteger(pad) && pad >= 0 && pad < 16 ? tagKeyAction(String((pad % 8) + 1), pad >= 8) : null;

/** Status bank pads 0..6 = a w x b p r m. */
export const statusBankAction = (pad: number): TagKeyAction | null =>
  Number.isInteger(pad) && pad >= 0 && pad < STATUS_PAD_KEYS.length ? tagKeyAction(STATUS_PAD_KEYS[pad], false) : null;

export type TagWriteIo = {
  /** The track the deck holds right now (read at the press). */
  track: () => { id: number; title: string } | null;
  update: (trackId: number, patch: Partial<Profile>) => Promise<unknown>;
  toast: { success: (message: string) => void; error: (message: string) => void };
  /** Announces the write so /tag can refresh the same track's profile. */
  emit: (trackId: number) => void;
};

/** Writes one bank action to the deck's track; the id and title are snapshotted at the press, before the first await. */
export async function writeTagAction(action: TagKeyAction | null, io: TagWriteIo): Promise<boolean> {
  const track = io.track();
  if (!action || !track) return false;
  const { id, title } = track;
  try {
    await io.update(id, action.patch);
  } catch (cause: unknown) {
    io.toast.error(cause instanceof Error ? cause.message : "Η αποθήκευση απέτυχε.");
    return false;
  }
  io.toast.success(`${title}: ${action.label}`);
  io.emit(id);
  return true;
}
