import { fitsBudget } from "../audio/stretchDeck";
import type { Track } from "../types";

/** Duplicated from MiniPlayer's UNSUPPORTED on purpose: those tracks play on the element path, never the stretch engine. */
export const MIX_UNSUPPORTED_EXT = [".aiff", ".aif"];

/** Can the track play on the stretch engine (and so take a scheduled mix rather than the cut path)? */
export function isMixable(track: Pick<Track, "extension" | "duration">, sampleRate: number): boolean {
  const ext = `.${(track.extension || "").replace(/^\./, "").toLowerCase()}`;
  return !MIX_UNSUPPORTED_EXT.includes(ext) && fitsBudget(track.duration, sampleRate);
}
