import { apiMessage } from "./facets";
import { deleteSetAndCleanUp } from "./setActions";
import type { SetSummary } from "./types";

/** «Διαχείριση sets»: how the list is ordered. */
export type SetSortKey = "name" | "date" | "size";
export interface SetSort { key: SetSortKey; desc: boolean }

export const SET_SORT_LABELS: Record<SetSortKey, string> = { name: "Όνομα", date: "Ημερομηνία", size: "Μέγεθος" };

/** The date a set shows: its own date when it has one, else the day it was made. */
export function setShownDate(set: SetSummary): string {
  return set.date || set.created_at;
}

/** The sets whose name contains the filter, in the chosen order (ties: newest first). */
export function visibleSets(sets: SetSummary[], filter: string, sort: SetSort): SetSummary[] {
  const needle = filter.trim().toLocaleLowerCase("el");
  const shown = needle ? sets.filter(set => set.title.toLocaleLowerCase("el").includes(needle)) : [...sets];
  const compare = (a: SetSummary, b: SetSummary) =>
    sort.key === "name" ? a.title.localeCompare(b.title, "el", { sensitivity: "base", numeric: true })
      : sort.key === "date" ? setShownDate(a).localeCompare(setShownDate(b))
        : a.track_count - b.track_count || a.duration_seconds - b.duration_seconds;
  return shown.sort((a, b) => (sort.desc ? -1 : 1) * compare(a, b) || b.id - a.id);
}

/** «Επιλογή όλων των κενών»: the shown sets with no tracks. */
export function emptySetIds(sets: SetSummary[]): number[] {
  return sets.filter(set => set.track_count === 0).map(set => set.id);
}

export function deleteSetsMessage(count: number): string {
  const what = count === 1 ? "Το set θα διαγραφεί μαζί με τις μεταβάσεις του" : `Τα ${count} sets θα διαγραφούν μαζί με τις μεταβάσεις τους`;
  return `${what}. Τα tracks μένουν στη βιβλιοθήκη.`;
}

export interface DeleteSetsResult {
  deleted: { id: number; title: string }[];
  failed: { id: number; title: string; message: string }[];
}

/**
 * Deletes the sets one at a time through the single delete (each keeps its own audit entry, a running
 * mix of it stops); a failure is noted and the rest continue.
 */
export async function deleteSetsOneByOne(
  sets: { id: number; title: string }[],
  remove: (id: number) => Promise<void> = deleteSetAndCleanUp,
): Promise<DeleteSetsResult> {
  const result: DeleteSetsResult = { deleted: [], failed: [] };
  for (const set of sets) {
    try {
      await remove(set.id);
      result.deleted.push(set);
    } catch (error) {
      result.failed.push({ ...set, message: apiMessage(error) });
    }
  }
  return result;
}

/** The toast after a bulk delete: how many went, and which ones did not. */
export function deleteSetsSummary(result: DeleteSetsResult): { ok: boolean; title: string; description?: string } {
  const gone = result.deleted.length === 1 ? "Διαγράφηκε 1 set" : `Διαγράφηκαν ${result.deleted.length} sets`;
  if (!result.failed.length) return { ok: true, title: gone };
  return {
    ok: false,
    title: result.deleted.length ? `${gone}· ${result.failed.length} δεν ${result.failed.length === 1 ? "διαγράφηκε" : "διαγράφηκαν"}` : "Δεν ήταν δυνατή η διαγραφή",
    description: result.failed.map(set => `«${set.title}»: ${set.message}`).join("\n"),
  };
}
