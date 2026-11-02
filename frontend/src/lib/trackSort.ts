/**
 * Client-side track sorting for the Library table. The backend `/tracks`
 * endpoint takes no `order`/`sort` param (search mini-language only), so the
 * already-loaded result set is sorted in the browser. Missing values always
 * sort last regardless of direction (standard table UX).
 */
import type { SoundCloudListTrack, Track } from "./types";
import { effectiveBpm } from "./tempo";
import { formatKey, toCamelot } from "./camelot";

export type SortKey =
  | "title"
  | "status"
  | "energy"
  | "darkness"
  | "valence"
  | "melody"
  | "weirdness"
  | "role"
  | "bpm"
  | "key"
  | "genre"
  | "substyle"
  | "soundcloud_plays"
  | "soundcloud_likes"
  | "last"
  | "added"
  | "modified"
  | "created";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

// DJ-meaningful ranking so "status" sorts by desirability, not alphabet.
const STATUS_RANK: Record<string, number> = {
  weapon: 5,
  approved: 4,
  testing: 3,
  unknown: 2,
  retired: 1,
  avoid: 0,
};

function keyOrder(t: Track): number | null {
  // Match the table's tag/analyzed precedence and key normalization.
  const camelot = toCamelot(formatKey(t.key_text, t.key_analyzed));
  return camelot ? (camelot.n - 1) * 2 + (camelot.side === "B" ? 1 : 0) : null;
}

/** Compare full-array neighbors, including the row beyond a virtual viewport. */
export function isKeyGroupEnd(track: Track, nextTrack: Track | undefined, sortKey?: SortKey): boolean {
  return sortKey === "key" && nextTrack !== undefined && keyOrder(track) !== keyOrder(nextTrack);
}

function cellValue(t: Track, key: SortKey): number | string | null {
  switch (key) {
    case "title":
      return (t.title || t.file_name || "").toLowerCase();
    case "status":
      return t.personal_status ? STATUS_RANK[t.personal_status] ?? null : null;
    case "energy":
      return t.energy ?? null;
    case "darkness":
      return t.darkness ?? null;
    case "valence":
      return t.valence ?? null;
    case "melody":
      return t.melody ?? null;
    case "weirdness":
      return t.weirdness ?? null;
    case "role":
      return t.set_role || null;
    case "bpm":
      return effectiveBpm(t);
    case "key":
      return keyOrder(t);
    case "genre":
      return t.genre || null;
    case "substyle":
      return t.psy_substyle || null;
    case "soundcloud_plays":
      return (t as SoundCloudListTrack).soundcloud_playback_count ?? null;
    case "soundcloud_likes":
      return (t as SoundCloudListTrack).soundcloud_likes_count ?? null;
    case "last":
      return t.last_played_at || null; // ISO strings sort chronologically
    case "added":
      return t.imported_at || null;
    case "modified":
      return t.modified_time ?? null;
    case "created":
      return t.created_time ?? null;
  }
}

/** Returns a new sorted array, or the original reference when `sort` is null. */
export function sortTracks(tracks: Track[], sort: SortState | null): Track[] {
  if (!sort) return tracks;
  const { key, dir } = sort;
  const arr = [...tracks];
  arr.sort((a, b) => {
    const va = cellValue(a, key);
    const vb = cellValue(b, key);
    // Key direction changes the group order; tempos within every group stay low → high.
    if (key === "key" && va === vb) {
      const bpmA = effectiveBpm(a);
      const bpmB = effectiveBpm(b);
      if (bpmA === null && bpmB === null) return 0;
      if (bpmA === null) return 1;
      if (bpmB === null) return -1;
      return bpmA - bpmB;
    }
    const na = va === null || va === "";
    const nb = vb === null || vb === "";
    if (na && nb) return 0;
    if (na) return 1; // missing always last
    if (nb) return -1;
    const c =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "el");
    return dir === "asc" ? c : -c;
  });
  return arr;
}
