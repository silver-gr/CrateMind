/** Pure helpers for the Library's deck-match chips, `sort:` override, list totals and session plays. */
import { camelotCode, fallbackKey, neighbors, toCamelot } from "./camelot";
import { playStartMs } from "./playHistory";
import { serializeTokens, tokenizeQuery, type QueryToken } from "./queryGrammar";
import { effectiveBpm } from "./tempo";
import type { PlayHistoryEntry, Track } from "./types";

/** The `sort:` fields of backend services/search.py (_SORT_FIELDS); an unknown one is ignored there. */
export const SORT_FIELDS = new Set([
  "bpm", "key", "added", "played", "plays", "lufs", "title", "artist",
  "energy", "intensity", "darkness", "melody", "weirdness", "mixability", "confidence", "chaos_level", "tempo_bridge_score", "valence",
]);

/** Whether the query orders its own results (`sort:bpm`, `sort:-energy`): the Library then keeps the server order. */
export function hasSortToken(query: string): boolean {
  return tokenizeQuery(query).some(t => t.field?.toLowerCase() === "sort" && SORT_FIELDS.has(t.value.toLowerCase().replace(/^-+/, "")));
}

/** Search terms for tracks that mix with `track`: a tempo within about 6 % and a compatible Camelot key
 * (the same, one step either way, the relative major/minor). Empty when the track has neither. */
export function deckMatchTerms(track: Track): string[] {
  const terms: string[] = [];
  const bpm = effectiveBpm(track);
  if (bpm) terms.push(`bpm:${Math.floor(bpm * 0.94)}-${Math.ceil(bpm * 1.06)}`);
  const key = toCamelot((track.key_text?.trim() || fallbackKey(track))?.replace(/^~/, "").trim());
  if (key) terms.push(`key:${[key, ...neighbors(key)].map(camelotCode).join(",")}`);
  return terms;
}

const termSet = (query: string) => new Set(tokenizeQuery(query).map(t => serializeTokens([t])));

export function termsActive(query: string, terms: readonly string[]): boolean {
  const present = termSet(query);
  return terms.length > 0 && terms.every(term => present.has(term));
}

const isOr = (t: QueryToken) => !t.field && !t.neg && !t.quoted && t.value === "OR";

/** Removes the terms when they are all there; otherwise adds them in place of any `bpm:` / `key:` filter. A removed
 * term takes one `OR` next to it along, so the OR never joins two other terms. */
export function toggleTerms(query: string, terms: readonly string[]): string {
  const active = termsActive(query, terms);
  const removed = (t: QueryToken) => active
    ? terms.includes(serializeTokens([t]))
    : !t.neg && ["bpm", "key"].includes(t.field?.toLowerCase() ?? "");
  const kept: QueryToken[] = [];
  let dropNextOr = false;
  for (const t of tokenizeQuery(query)) {
    if (removed(t)) {
      if (kept.length && isOr(kept[kept.length - 1])) kept.pop();
      else dropNextOr = true;
    } else if (dropNextOr && isOr(t)) {
      dropNextOr = false;
    } else {
      dropNextOr = false;
      kept.push(t);
    }
  }
  return serializeTokens(active ? kept : [...kept, ...tokenizeQuery(terms.join(" "))]);
}

/** «34 ώ 12 λ», or «12 λ» under an hour. */
export function totalDurationLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} ώ ${minutes % 60} λ` : `${minutes} λ`;
}

/** The tracks of the plays that started at or after `sinceMs` (the app's start). */
export function sessionPlayedIds(plays: readonly PlayHistoryEntry[], sinceMs: number): Set<number> {
  return new Set(plays.filter(play => playStartMs(play) >= sinceMs).map(play => play.track_id));
}

/** The page width (inspector included) from which the Library shows its table and inspector side by side; narrower, they stack. */
export const LIBRARY_SIDE_BY_SIDE_MIN = 896;

/**
 * Whether the Library shows the table and the inspector side by side. `pageWidth` is the page's own width: with the inspector
 * in the shell's right rail it leaves the inspector out, so its width is added back and the switch point stays the same
 * either way (no flicker as the inspector moves).
 */
export function librarySideBySide(pageWidth: number, inspectorWidth: number, inspectorInRail: boolean): boolean {
  return (inspectorInRail ? pageWidth + inspectorWidth : pageWidth) >= LIBRARY_SIDE_BY_SIDE_MIN;
}
