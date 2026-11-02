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

export function progressLine(done: number, total: number): string {
  return `Ταξινομημένα ${done.toLocaleString("el-GR")} / ${total.toLocaleString("el-GR")}`;
}
