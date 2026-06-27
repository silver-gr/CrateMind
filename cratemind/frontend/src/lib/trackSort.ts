/**
 * Client-side track sorting for the Library table. The backend `/tracks`
 * endpoint takes no `order`/`sort` param (search mini-language only), so the
 * already-loaded result set is sorted in the browser. Missing values always
 * sort last regardless of direction (standard table UX).
 */
import type { Track } from "./types";

export type SortKey =
  | "title"
  | "status"
  | "energy"
  | "darkness"
  | "bpm"
  | "key"
  | "genre"
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
    case "bpm":
      return t.bpm ?? null;
    case "key":
      return t.key_text || null;
    case "genre":
      return t.genre || null;
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
