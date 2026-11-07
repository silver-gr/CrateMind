import { fitsBudget } from "../audio/stretchDeck";
import type { Track } from "../types";

/** Duplicated from MiniPlayer's UNSUPPORTED on purpose (MiniPlayer is a hot file; a test keeps the two equal): the decks
 *  refuse these tracks outright, so a set mix skips them. They are never cut: they cannot play at all. */
export const MIX_UNSUPPORTED_EXT = [".aiff", ".aif"];

const extOf = (track: Pick<Track, "extension">) => `.${(track.extension || "").replace(/^\./, "").toLowerCase()}`;

/** Can the track load on a deck at all? */
export function isDeckPlayable(track: Pick<Track, "extension">): boolean {
  return !MIX_UNSUPPORTED_EXT.includes(extOf(track));
}

/** Can the track play on the stretch engine (and so take a scheduled mix)? A playable track over the decode budget
 *  plays on the element and takes the cut path. */
export function isMixable(track: Pick<Track, "extension" | "duration">, sampleRate: number): boolean {
  return isDeckPlayable(track) && fitsBudget(track.duration, sampleRate);
}
