import { getPref, type LibraryProfile } from "./prefs";
import { serializeTokens } from "./queryGrammar";
import type { Facet, Track } from "./types";

/** Rows per /tag request; the backend pages by keyset on (artist, title, id). */
export const QUEUE_PAGE = 500;

export type QueueFilter = { label: string; q: string };

/**
 * The /tag queues. The «Χωρίς …» queues come from the vocabularies that exist:
 * a hard-coded `-purpose:*` with no `purpose` facet would fall through to free
 * text and show the whole library.
 */
export function queueFilters(facets: readonly Facet[], profile: LibraryProfile = getPref("libraryProfile")): QueueFilter[] {
  const therapy = profile === "therapy";
  return [
    { label: "Όλα", q: "" },
    { label: "Χωρίς tags", q: "untagged" },
    { label: therapy ? "Υπό δοκιμή" : "Δοκιμή", q: "testing" },
    { label: "Για έλεγχο", q: "status:unknown" },
    ...(therapy ? [] : [
      { label: "Υποψήφιες γέφυρες", q: "role:bridge" },
      { label: "Μεγάλο blend", q: "tolerance:huge" },
    ]),
    ...facets.map(facet => ({ label: `Χωρίς ${facet.label}`, q: `-${facet.key}:*` })),
  ];
}

/** A folder the search grammar can quote: it has no escapes, so a `"` in the path would split the token. */
export function queryableFolder(path: string): boolean {
  return !path.includes('"');
}

/** The filter scoped to one folder. The trailing "/" keeps `Relax/` from matching `Relaxation/`. */
export function queueQuery(filterQ: string, folder: string): string {
  if (!folder) return filterQ;
  const path = folder.endsWith("/") ? folder : `${folder}/`;
  const token = serializeTokens([{ neg: false, field: "folder", value: path, quoted: true }]);
  return filterQ ? `${filterQ} ${token}` : token;
}

/** Appends a page, keeping order and skipping ids already loaded. */
export function appendPage(loaded: readonly Track[], page: readonly Track[]): Track[] {
  const seen = new Set(loaded.map(t => t.id));
  return [...loaded, ...page.filter(t => !seen.has(t.id))];
}

/** A short page means the queue is exhausted. */
export function hasMorePages(page: readonly Track[], pageSize = QUEUE_PAGE): boolean {
  return page.length >= pageSize && pageSize > 0;
}

/** Prefetch threshold: rows left before the end of the loaded pages. */
const PREFETCH_ROWS = 25;

/** Fetch the next page near the end of the loaded rows: one request at a time, never in shuffle (it loads everything). */
export function shouldFetchNextPage(s: { idx: number; loaded: number; hasMore: boolean; inFlight: boolean; shuffle: boolean }): boolean {
  return !s.shuffle && s.hasMore && !s.inFlight && s.loaded > 0 && s.idx >= s.loaded - PREFETCH_ROWS;
}

/**
 * The header's «Απομένουν» and «Κομμάτι i / n». `total` is the queue size counted at load;
 * until it arrives the loaded pages show with a "+".
 */
export function queueCounts(s: { idx: number; loaded: number; total: number | null; hasMore: boolean }): { remaining: string; position: string } {
  const plus = s.total == null && s.hasMore ? "+" : "";
  const size = Math.max(s.total ?? 0, s.loaded);
  if (s.loaded === 0) return { remaining: "0", position: "—" };
  return { remaining: `${Math.max(size - s.idx, 0)}${plus}`, position: `${s.idx + 1} / ${size}${plus}` };
}

export function progressLine(done: number, total: number): string {
  return `Ταξινομημένα ${done.toLocaleString("el-GR")} / ${total.toLocaleString("el-GR")}`;
}
