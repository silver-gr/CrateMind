import type { KeyWheelSource } from "./keyWheelSource";
import type { Track } from "./types";

export type RecommendationSource = { source: KeyWheelSource; track: Pick<Track, "id" | "title" | "file_name"> };

/** Recommendations can use BPM and other metadata even when a track has no key. */
export function resolveRecommendationSource(
  preferred: KeyWheelSource,
  tracks: Record<KeyWheelSource, RecommendationSource["track"] | null | undefined>,
): RecommendationSource | null {
  const fallback: KeyWheelSource[] = ["last", "selection", "playing"];
  const source = [preferred, ...fallback].find(source => tracks[source] != null);
  return source ? { source, track: tracks[source]! } : null;
}

export function recommendationSourceKey(source: RecommendationSource | null): string | null {
  return source ? `${source.source}:${source.track.id}` : null;
}

export function recommendationSourceRequest(source: RecommendationSource): Record<string, unknown> {
  // The set recommendation endpoint calls the starting track `after_track_id`.
  return { after_track_id: source.track.id, limit: 12 };
}

/** Bridges have explicit endpoints; only next-track requests follow changing sources. */
export function recommendationSourceIsCurrent(
  requested: RecommendationSource | null,
  current: RecommendationSource | null,
  pendingTailId?: number,
): boolean {
  if (!requested) return true;
  if (recommendationSourceKey(requested) === recommendationSourceKey(current)) return true;
  return requested.source === "last" && current?.source === "last" && requested.track.id === pendingTailId;
}
