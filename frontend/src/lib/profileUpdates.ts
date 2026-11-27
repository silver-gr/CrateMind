// The profile-written window event. Every write of taste fields announces the track and the fields written, so the decks
// (lib/player.tsx), the Set Builder and /tag apply them without a read back: a deck's fast rating and pad banks
// (lib/fastRating.ts, lib/tagKeys.ts), /tag's keys, the track menu's status, the Library editor's save and a bulk edit
// (api.batchEdit). It imports nothing, so api.ts can use it.
import type { Profile } from "./types";

export const PROFILE_UPDATED = "cratemind:profile-updated";
/** A profile write; `patch` holds the fields written, when the writer knows them. */
export type ProfileUpdatedDetail = { trackId: number; patch?: Partial<Profile> };

export function announceProfile(trackId: number, patch?: Partial<Profile>): void {
  window.dispatchEvent(new CustomEvent<ProfileUpdatedDetail>(PROFILE_UPDATED, { detail: { trackId, patch } }));
}
