import { getLunaGenreResult } from "./artistGenreResults";
import { foldText } from "./queryGrammar";
import type { ArtistProfile } from "./types";

/** A Luna genre result that still waits for confirmation (the full page's «Προς επιβεβαίωση»). */
export function awaitingReview(row: ArtistProfile): boolean {
  const r = getLunaGenreResult(row);
  return r !== null && !r.confirmed;
}

/** The Library «Καλλιτέχνες» tab's search: server order kept, names matched accent- and case-insensitively. */
export function filterArtists(rows: readonly ArtistProfile[], search: string): readonly ArtistProfile[] {
  const needle = foldText(search.trim());
  return needle ? rows.filter(row => foldText(row.canonical_name).includes(needle)) : rows;
}
