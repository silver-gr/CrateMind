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

/**
 * A refresh may keep the surviving cards only while it asks about the same tracks. A moved endpoint (the
 * last track after an add) is a new question: take the fresh order and start again on page 1.
 */
export function sameRecommendationEndpoints(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return previous.after_track_id === next.after_track_id
    && (previous.before_track_id ?? null) === (next.before_track_id ?? null);
}
