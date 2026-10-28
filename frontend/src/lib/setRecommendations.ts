import type { Recommendation } from "./types";

/** Keep surviving cards in place, refresh their scores, and fill gaps with new picks. */
export function refillSetRecommendations(
  previous: Recommendation[], fresh: Recommendation[], excluded: ReadonlySet<number>, limit: number,
): Recommendation[] {
  const available = new Map(fresh.filter(rec => !excluded.has(rec.track_id)).map(rec => [rec.track_id, rec]));
  const result: Recommendation[] = [];
  for (const rec of [...previous, ...fresh]) {
    const current = available.get(rec.track_id);
    if (!current || result.length >= limit) continue;
    result.push(current);
    available.delete(rec.track_id);
  }
  return result;
}
