import type { DJSet, SavedSearch, Track } from "./types";

/** The hero crate: the user's main crate, or the «Bangers» preset when none is set (or it was deleted). */
export interface HeroCrate {
  id: number | null;
  name: string;
  query: string;
  count: number | null;
  fallback: boolean;
}

export function resolveMainCrate(
  crates: SavedSearch[], mainCrateId: number | null, weaponsCount: number | null,
): HeroCrate {
  const main = mainCrateId === null ? undefined : crates.find((c) => c.id === mainCrateId);
  if (main) return { id: main.id, name: main.name, query: main.query, count: main.count, fallback: false };
  return { id: null, name: "Bangers", query: "weapons", count: weaponsCount, fallback: true };
}

/** The star toggle: clicking the active main crate clears it. */
export function toggleMainCrate(current: number | null, id: number): number | null {
  return current === id ? null : id;
}

/**
 * Tracks played in the last 30 days (search.py: `played_recently`). Fetched unbounded:
 * the server lists by artist/title, so a capped page could miss the newest plays.
 */
export const RECENT_PLAYS_QUERY = "played_recently:30";

function playedAt(t: Track): number {
  const ms = t.last_played_at ? Date.parse(t.last_played_at) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** The most recently played tracks first; tracks never played are dropped. */
export function recentPlays(tracks: Track[], limit = 8): Track[] {
  return tracks
    .filter((t) => t.last_played_at)
    .sort((a, b) => playedAt(b) - playedAt(a))
    .slice(0, limit);
}

/** The newest set, as the Set Builder picks it when no ?id= is given (highest id). */
export function latestSet(sets: DJSet[]): DJSet | null {
  return sets.reduce<DJSet | null>((a, b) => (a === null || b.id > a.id ? b : a), null);
}

/** «Θέλουν προσοχή» count rows that open the Library with their query. */
export const ATTENTION_QUERIES: readonly { key: string; label: string; query: string }[] = [
  { key: "no_bpm", label: "Χωρίς BPM", query: "-bpm:0+" },
  { key: "double_bpm", label: "Πάνω από 200 BPM (πιθανό διπλό)", query: "bpm:200+" },
  { key: "new_untagged", label: "Νέα χωρίς tags (30 ημέρες)", query: "untagged added:30" },
];

export function libraryHref(query: string): string {
  return query ? "/library?q=" + encodeURIComponent(query) : "/library";
}

/** Narrowest «Συνέχεια» card that keeps a readable title next to tempo, key and the two deck buttons. */
export const CONTINUE_MIN_CARD_WIDTH = 560;

/** «Συνέχεια» masonry columns for the section's own width (gap-3 = 12px). */
export function continueColumnCount(width: number): 1 | 2 {
  return width >= CONTINUE_MIN_CARD_WIDTH * 2 + 12 ? 2 : 1;
}
