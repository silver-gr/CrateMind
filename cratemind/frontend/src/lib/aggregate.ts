/**
 * Small pure client-side aggregation helpers. The heavy lifting (exact bucket
 * counts) is done by the pages via `api.trackCount("energy:N")` etc. — these are
 * just shapers/normalizers. NO tag-frequency helper: list rows carry no tags and
 * there is no tag-count endpoint, so tag frequency is not derivable (Tag Cloud
 * renders uniform-weight chips instead).
 */
import type { Recommendation, Track } from "./types";

/** Normalize a list of recommender scores to relative 0-100 within the list. */
export function relativeMatch(scores: number[]): number[] {
  if (!scores.length) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 100);
  return scores.map((s) => Math.round(((s - min) / (max - min)) * 100));
}

export function recMatchPercents(recs: Recommendation[]): number[] {
  return relativeMatch(recs.map((r) => r.score));
}

/** Scatter "texture" points from a (sampled, labeled) Track[] — energy×darkness. */
export function energyDarknessPoints(
  tracks: Track[],
): { x: number; y: number; id: number }[] {
  return tracks
    .filter((t) => t.energy != null && t.darkness != null)
    .map((t) => ({ x: t.energy as number, y: t.darkness as number, id: t.id }));
}

/** Sum a Record<string, number> of counts. */
export function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** Largest value in a numeric record (for histogram scaling); 0 when empty. */
export function maxCount(counts: Record<string, number>): number {
  const vals = Object.values(counts);
  return vals.length ? Math.max(...vals) : 0;
}
