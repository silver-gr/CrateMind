import type { DJSet } from "./types";

/** Sets that received tracks from «Προσθήκη σε άλλο set» in this session, most recent first. */
let recentTargets: number[] = [];

export function rememberSetTarget(id: number) {
  recentTargets = [id, ...recentTargets.filter(target => target !== id)];
}

export function forgetSetTarget(id: number) {
  recentTargets = recentTargets.filter(target => target !== id);
}

export function lastSetTarget(): number | null {
  return recentTargets[0] ?? null;
}

/** Above this many targets the menu shows a filter field. */
export const SET_TARGET_FILTER_FROM = 8;

/**
 * The other sets, for the «Προσθήκη σε άλλο set» menu: this session's targets first (the last one
 * on top), then the rest newest first. Sets keep no change time, so the newest set stands in for
 * the most recently changed one.
 */
export function orderSetTargets(sets: DJSet[], currentSetId: number | null, filter = "", recent: number[] = recentTargets): DJSet[] {
  const needle = filter.trim().toLocaleLowerCase("el");
  const rank = (set: DJSet) => {
    const index = recent.indexOf(set.id);
    return index < 0 ? recent.length : index;
  };
  return sets
    .filter(set => set.id !== currentSetId && (!needle || set.title.toLocaleLowerCase("el").includes(needle)))
    .sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}
