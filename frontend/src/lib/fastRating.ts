// Fast rating while playing («Γρήγορη βαθμολογία», Prefs.deckRating): the decks' status, energy and darkness controls and
// the Set Builder's energy column write through `writeTagAction` (lib/tagKeys.ts), the same path as the pad banks.
import { toast } from "sonner";
import { api } from "./api";
import { axisLabel, statusLabel, statusValues, type Axis } from "./labels";
import { getPref, type LibraryProfile } from "./prefs";
import { announceProfile } from "./profileUpdates";
import { tagKeyAction, writeTagAction, type TagKeyAction } from "./tagKeys";
import type { Profile, SetTrackRow, Track } from "./types";

export { PROFILE_UPDATED, announceProfile, type ProfileUpdatedDetail } from "./profileUpdates";

/**
 * One fast-rating write: `values` are the fields as shown at the click, so the toast reads «ενέργεια 6 → 8» and its
 * «Αναίρεση» (6 s) puts them back; without them (not read yet) the write confirms with no undo. Every listener of
 * `PROFILE_UPDATED` (the decks, /tag, the Set Builder) gets the patch.
 */
export function writeRating(
  action: TagKeyAction | null, track: { id: number; title: string }, values: Partial<Profile> | undefined,
  profile: LibraryProfile = getPref("libraryProfile"),
): Promise<boolean> {
  return writeTagAction(action, {
    track: () => ({ ...track, values }),
    update: (id, patch) => api.updateProfile(id, patch),
    toast: {
      success: message => { toast.success(message); },
      error: message => { toast.error(message); },
      undo: (message, onUndo) => { toast.success(message, { duration: 6000, action: { label: "Αναίρεση", onClick: onUndo } }); },
    },
    emit: announceProfile,
  }, profile);
}

/** The Set Builder's rows with a written profile applied to every occurrence of the track. */
export function patchRowsProfile(rows: SetTrackRow[], trackId: number, patch: Partial<Profile>): SetTrackRow[] {
  if (!rows.some(row => row.track.id === trackId)) return rows;
  return rows.map(row => row.track.id === trackId
    ? { ...row, track: patchTrackProfile(row.track, patch), profile: { ...(row.profile ?? { track_id: trackId }), ...patch } }
    : row);
}

/** The profile fields a list `Track` carries; a deck's loaded track is patched with only these. */
const TRACK_FIELDS = ["personal_status", "energy", "darkness", "valence", "melody", "weirdness", "set_role", "psy_substyle"] as const;

/** The loaded track with the written fields applied, so a deck shows a write without a refetch. */
export function patchTrackProfile(track: Track, patch: Partial<Profile>): Track {
  const out: Track = { ...track };
  for (const key of TRACK_FIELDS) {
    if (key in patch) (out as unknown as Record<string, unknown>)[key] = patch[key] ?? null;
  }
  return out;
}

/** The two numbers rated on a deck: energy, and darkness (valence in therapy, which the Shift digits write there too). */
export function ratingAxes(profile: LibraryProfile = getPref("libraryProfile")): [Axis, Axis] {
  return ["energy", profile === "therapy" ? "valence" : "darkness"];
}

/** One click on a meter: the same action as the digit key for that value (10 is «0»). */
export function ratingAction(axis: Axis, value: number, profile: LibraryProfile = getPref("libraryProfile")): TagKeyAction | null {
  if (!Number.isInteger(value) || value < 1 || value > 10) return null;
  return tagKeyAction(value === 10 ? "0" : String(value), axis !== "energy", profile);
}

/** The deck's status menu: the editor's statuses with «unknown» last, named «Καμία». */
export function statusChoices(profile: LibraryProfile = getPref("libraryProfile")): { status: string; label: string }[] {
  const named = statusValues(profile).filter(status => status !== "unknown")
    .map(status => ({ status, label: statusLabel(status, profile) }));
  return [...named, { status: "unknown", label: "Καμία" }];
}

export function statusAction(status: string, profile: LibraryProfile = getPref("libraryProfile")): TagKeyAction {
  const label = status === "unknown" ? "καμία κατάσταση" : status === "weapon" && profile === "dj" ? "BANGER" : statusLabel(status, profile);
  return { patch: { personal_status: status }, label, optimistic: true };
}

/** A meter's tooltip: «Ενέργεια 8», or «Ενέργεια: χωρίς τιμή». */
export function ratingTitle(axis: Axis, value: number | null | undefined, profile: LibraryProfile = getPref("libraryProfile")): string {
  return value == null ? `${axisLabel(axis, profile)}: χωρίς τιμή` : `${axisLabel(axis, profile)} ${value}`;
}

/** The fields the deck strip shows. */
export const SHOWN_FIELDS = ["personal_status", "energy", "darkness", "valence"] as const;

/** Whether a loaded track came without a shown field (a set row's track, for one), so the strip must read them. */
export const lacksProfileFields = (track: Track): boolean => SHOWN_FIELDS.some(key => track[key] === undefined);
