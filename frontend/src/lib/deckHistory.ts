import { getPref, setPref } from "./prefs";

/** One deck load, kept per device in the prefs blob (`recentDeckLoads`). */
export interface DeckLoad {
  id: number;
  deck: "A" | "B";
  at: number;
}

export const DECK_HISTORY_CAP = 20;

/** Newest first, one entry per track (its latest load), at most 20. */
export function recordDeckLoad(list: DeckLoad[], trackId: number, deck: "A" | "B", at: number): DeckLoad[] {
  return [{ id: trackId, deck, at }, ...list.filter((e) => e.id !== trackId)].slice(0, DECK_HISTORY_CAP);
}

/** Records a deck load in the prefs blob; PlayerProvider's `load` calls it for every load. */
export function rememberDeckLoad(trackId: number, deck: "A" | "B", at = Date.now()): void {
  setPref("recentDeckLoads", recordDeckLoad(getPref("recentDeckLoads"), trackId, deck, at));
}

/** «πριν 5 λ.»-style relative time. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "μόλις τώρα";
  if (minutes < 60) return `πριν ${minutes} λ.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `πριν ${hours} ώ.`;
  return `πριν ${Math.floor(hours / 24)} ημ.`;
}
