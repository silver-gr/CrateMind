/** Recommendation lists load once (up to 96) and show 12 per page. */
export const RECS_PER_PAGE = 12;
export const RECS_LIMIT = 96;

export const pageCountFor = (total: number, perPage = RECS_PER_PAGE): number => Math.max(1, Math.ceil(total / perPage));

/** Keeps a 1-based page inside the list, e.g. after cards leave it. */
export const clampPage = (page: number, total: number, perPage = RECS_PER_PAGE): number =>
  Math.min(Math.max(1, page), pageCountFor(total, perPage));

export function pageSlice<T>(items: T[], page: number, perPage = RECS_PER_PAGE): T[] {
  const start = (clampPage(page, items.length, perPage) - 1) * perPage;
  return items.slice(start, start + perPage);
}

/** «13–24 από 96»; empty for an empty list. */
export function pageRangeLabel(page: number, total: number, perPage = RECS_PER_PAGE): string {
  if (total <= 0) return "";
  const start = (clampPage(page, total, perPage) - 1) * perPage;
  return `${start + 1}–${Math.min(total, start + perPage)} από ${total}`;
}

/** Up to `max` consecutive page numbers around the current page (no ellipsis). */
export function visiblePages(page: number, pageCount: number, max = 8): number[] {
  const count = Math.min(max, pageCount);
  const first = Math.min(Math.max(1, page - Math.floor((count - 1) / 2)), pageCount - count + 1);
  return Array.from({ length: count }, (_, i) => first + i);
}
