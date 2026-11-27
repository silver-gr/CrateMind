// The tagging key table shared by the /tag page and the controller's pad banks (Auto Loop / Sampler modes).
// One mapping, so a pad press writes exactly what the same key writes on /tag.
import { api } from "./api";
import { fieldLabel, writesOnlyShownStatus } from "./labels";
import { getPref, type LibraryProfile } from "./prefs";
import type { Profile } from "./types";

export type TagKeyAction = {
  patch: Partial<Profile>;
  label: string;
  /** /tag also merges the patch into its on-screen profile at once (roles and statuses); energy, darkness and melody just save. */
  optimistic: boolean;
};

/** Status/role bank: pad 1..7 sends these keys (the same letters /tag uses, in the controller's order). */
export const STATUS_PAD_KEYS = ["a", "w", "x", "b", "p", "r", "m"] as const;

/** Cue-pad digits exist only in the DJ profile; in therapy the digits rate the track. */
export const cuePadKeysEnabled = (profile: LibraryProfile = getPref("libraryProfile")): boolean => profile === "dj";

/** An active deck reserves 1-8 for cue jumps on /tag (DJ only), including pads that are currently empty. */
export const isCueJumpKey = (key: string, shiftKey: boolean, playbackOwned: boolean, profile: LibraryProfile = getPref("libraryProfile")): boolean =>
  cuePadKeysEnabled(profile) && /^[1-8]$/.test(key) && !shiftKey && playbackOwned;

/**
 * The digit a key event means, from the physical key when known. With Shift held,
 * `key` is "#" (US and Greek layouts) while `code` is still "Digit3".
 */
export function digitFromEvent(e: { key: string; code?: string }): string | null {
  const physical = e.code?.match(/^(?:Digit|Numpad)([0-9])$/);
  if (physical) return physical[1];
  return /^[0-9]$/.test(e.key) ? e.key : null;
}

/** Letters that only mean something in the DJ profile (roles and "weapon"). */
const DJ_ONLY_KEYS = new Set(["b", "l", "p", "r", "w"]);

/**
 * What a /tag key writes: digits = energy (Shift = darkness, 0 = 10), letters = melody / role / status.
 * In therapy digits = arousal (energy), Shift = valence, and role/weapon keys are off.
 */
export function tagKeyAction(key: string, shiftKey: boolean, profile: LibraryProfile = getPref("libraryProfile")): TagKeyAction | null {
  if (/^[0-9]$/.test(key)) {
    const val = key === "0" ? 10 : Number(key);
    const axis = shiftKey ? (profile === "therapy" ? "valence" : "darkness") : "energy";
    return { patch: { [axis]: val }, label: `${fieldLabel(axis, profile)} ${val}`, optimistic: false };
  }
  if (profile === "therapy" && DJ_ONLY_KEYS.has(key.toLowerCase())) return null;
  switch (key.toLowerCase()) {
    case "m": return { patch: { melody: 8 }, label: "μελωδικό", optimistic: false };
    case "b": return { patch: { set_role: "bridge" }, label: "ρόλος γέφυρα", optimistic: true };
    case "p": return { patch: { set_role: "peak" }, label: "ρόλος κορύφωση", optimistic: true };
    case "r": return { patch: { set_role: "reset" }, label: "ρόλος reset", optimistic: true };
    case "l": return { patch: { set_role: "closer" }, label: "ρόλος κλείσιμο", optimistic: true };
    case "w": return { patch: { personal_status: "weapon" }, label: "BANGER", optimistic: true };
    case "a": return { patch: { personal_status: "approved" }, label: "εγκεκριμένο", optimistic: true };
    case "x": return { patch: { personal_status: "avoid" }, label: "απόφυγε", optimistic: true };
    default: return null;
  }
}

/**
 * /tag's Option + digit (Alt on Windows): energy 1..10 even while a loaded deck keeps the plain digits for its cue pads.
 * Alt must come without Ctrl (AltGr arrives as Ctrl + Alt), Cmd or Shift; anything else gives null.
 */
export function optionDigitAction(
  e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  profile: LibraryProfile = getPref("libraryProfile"),
): TagKeyAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const digit = digitFromEvent(e);
  return digit ? tagKeyAction(digit, false, profile) : null;
}

/** The name of the Option key in the shortcut tables: «Option» on a Mac, «Alt» elsewhere. */
export const optionKeyName = (userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string =>
  /Mac OS X|Macintosh/i.test(userAgent) ? "Option" : "Alt";

/** Tag bank pads: 0..7 = energy 1..8, 8..15 (Shift + pad) = darkness 1..8 (valence in therapy). */
export const tagBankAction = (pad: number, profile: LibraryProfile = getPref("libraryProfile")): TagKeyAction | null =>
  Number.isInteger(pad) && pad >= 0 && pad < 16 ? tagKeyAction(String((pad % 8) + 1), pad >= 8, profile) : null;

/** Status bank pads 0..6 = a w x b p r m (role and weapon pads do nothing in therapy). */
export const statusBankAction = (pad: number, profile: LibraryProfile = getPref("libraryProfile")): TagKeyAction | null =>
  Number.isInteger(pad) && pad >= 0 && pad < STATUS_PAD_KEYS.length ? tagKeyAction(STATUS_PAD_KEYS[pad], false, profile) : null;

export type ShortcutSection = { section: string; rows: { keys: string[]; label: string }[] };

/** The /tag keyboard reference (and the tagging block of the shortcuts dialog), mirroring tagKeyAction. */
export function queueShortcuts(profile: LibraryProfile = getPref("libraryProfile"), alt: string = optionKeyName()): ShortcutSection[] {
  const listen = { section: "Ακρόαση", rows: [{ keys: ["Space"], label: "αναπαραγωγή / παύση" }] };
  const navigate = { section: "Πλοήγηση", rows: [{ keys: ["J"], label: "επόμενο" }, { keys: ["K"], label: "προηγούμενο" }] };
  if (profile === "therapy") {
    return [
      listen,
      { section: "Βαθμολογία", rows: [
        { keys: ["1–9", "0"], label: `${fieldLabel("energy", profile)} 1–10` },
        { keys: ["Shift", "1–0"], label: `${fieldLabel("valence", profile)} 1–10` },
        { keys: ["M"], label: "μελωδικό" },
      ] },
      { section: "Κατάσταση", rows: [{ keys: ["A"], label: "εγκεκριμένο" }, { keys: ["X"], label: "αποφυγή" }] },
      navigate,
    ];
  }
  return [
    { ...listen, rows: [...listen.rows, { keys: ["1–8"], label: "μετάβαση στα cue pads του επιλεγμένου track" }] },
    { section: "Βαθμολογία", rows: [
      { keys: ["1–9", "0"], label: "ενέργεια 1–10 (1–8 μόνο χωρίς επιλεγμένο track)" },
      { keys: [alt, "1–0"], label: "ενέργεια 1–10, και με επιλεγμένο track" },
      { keys: ["Shift", "1–0"], label: "σκοτεινότητα 1–10" },
      { keys: ["M"], label: "μελωδικό" },
    ] },
    { section: "Κατάσταση", rows: [
      { keys: ["W"], label: "banger" },
      { keys: ["A"], label: "εγκεκριμένο" },
      { keys: ["X"], label: "απόφυγε" },
    ] },
    { section: "Ρόλος", rows: [
      { keys: ["B"], label: "γέφυρα" },
      { keys: ["P"], label: "κορύφωση" },
      { keys: ["R"], label: "reset" },
      { keys: ["L"], label: "κλείσιμο" },
    ] },
    navigate,
  ];
}

export type TagWriteIo = {
  /**
   * The track the deck holds right now (read at the press). `values` are its profile fields as shown at the press; when
   * given, the toast names a replaced number («ενέργεια 6 → 8») and offers «Αναίρεση» through `toast.undo`.
   */
  track: () => { id: number; title: string; values?: Partial<Profile> } | null;
  update: (trackId: number, patch: Partial<Profile>) => Promise<unknown>;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    /** A confirmation with «Αναίρεση» (6 s); without it the write confirms with `success` and has no undo. */
    undo?: (message: string, onUndo: () => void) => void;
  };
  /** Announces the write (and an undo) with the fields written, so /tag and the decks can show them. */
  emit: (trackId: number, patch: Partial<Profile>) => void;
  /** The track's stored status, read only for a therapy status write (defaults to the API). */
  status?: (trackId: number) => Promise<string | null | undefined>;
};

const storedStatus = async (trackId: number) => (await api.getTrack(trackId)).profile?.personal_status;

/**
 * The patch that puts back what `patch` replaced: each field's earlier value, empty when it had none, and «unknown» for a
 * status (the column cannot be empty). Undo restores values; a profile row the first write created stays.
 */
export function undoPatch(patch: Partial<Profile>, before: Partial<Profile>): Partial<Profile> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof Profile)[]) {
    out[key] = before[key] ?? (key === "personal_status" ? "unknown" : null);
  }
  return out as Partial<Profile>;
}

/** The toast's text: a number that replaced another one reads «ενέργεια 6 → 8»; anything else is the action's label. */
export function writeLabel(action: TagKeyAction, before?: Partial<Profile>, profile: LibraryProfile = getPref("libraryProfile")): string {
  const keys = Object.keys(action.patch) as (keyof Profile)[];
  if (!before || keys.length !== 1) return action.label;
  const [key] = keys;
  const old = before[key];
  const next = action.patch[key];
  if (typeof old !== "number" || typeof next !== "number" || old === next) return action.label;
  return `${fieldLabel(key, profile)} ${old} → ${next}`;
}

const samePatch = (patch: Partial<Profile>, before: Partial<Profile>) =>
  (Object.keys(patch) as (keyof Profile)[]).every(key => (before[key] ?? null) === (patch[key] ?? null));

/** Writes one bank action to the deck's track; the id, title and shown values are snapshotted at the press, before the first await. */
export async function writeTagAction(
  action: TagKeyAction | null, io: TagWriteIo, profile: LibraryProfile = getPref("libraryProfile"),
): Promise<boolean> {
  const track = io.track();
  if (!action || !track) return false;
  const { id, title, values } = track;
  const next = action.patch.personal_status;
  try {
    // Therapy shows a DJ weapon as approved; the «A» pad must skip it like the «A» key, not erase the weapon.
    if (next && profile === "therapy" && writesOnlyShownStatus(await (io.status ?? storedStatus)(id), next, profile)) return false;
    await io.update(id, action.patch);
  } catch (cause: unknown) {
    io.toast.error(cause instanceof Error ? cause.message : "Η αποθήκευση απέτυχε.");
    return false;
  }
  const message = `${title}: ${writeLabel(action, values, profile)}`;
  if (values && io.toast.undo && !samePatch(action.patch, values)) {
    const restore = undoPatch(action.patch, values);
    io.toast.undo(message, () => {
      io.update(id, restore).then(() => {
        io.toast.success(`${title}: αναιρέθηκε`);
        io.emit(id, restore);
      }, (cause: unknown) => { io.toast.error(cause instanceof Error ? cause.message : "Η αναίρεση απέτυχε."); });
    });
  } else {
    io.toast.success(message);
  }
  io.emit(id, action.patch);
  return true;
}
