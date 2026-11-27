import type { SavedSearch } from "./types";

/** «Γρήγορες λίστες»: the pinned crates, ordered by sort_order then name. */
export function quickLists(crates: SavedSearch[]): SavedSearch[] {
  return crates
    .filter((c) => c.pinned)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "el"));
}

/**
 * The therapy version of the dashboard stats and tiles: no «Bangers», the approved count includes
 * DJ weapons (therapy shows them as approved).
 */
export function therapyStats<T extends { key: string; label: string; query?: string }>(items: T[]): T[] {
  return items
    .filter((s) => s.key !== "weapons")
    .map((s) => {
      if (s.key === "approved" && s.query !== undefined) return { ...s, query: "status:approved,weapon" };
      return s;
    });
}
