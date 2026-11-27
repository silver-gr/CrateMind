import { describe, expect, test } from "bun:test";
import { deleteSetsMessage, deleteSetsOneByOne, deleteSetsSummary, emptySetIds, visibleSets } from "../src/lib/manageSets";
import type { SetSummary } from "../src/lib/types";

const set = (id: number, title: string, track_count: number, created_at: string, over: Partial<SetSummary> = {}): SetSummary =>
  ({ id, title, track_count, duration_seconds: track_count * 400, created_at, date: null, ...over });

const SETS = [
  set(1, "Goa night", 12, "2026-10-01T20:00:00"),
  set(2, "draft 2", 0, "2026-11-20T10:00:00"),
  set(3, "Draft 10", 0, "2026-11-21T10:00:00"),
  set(4, "Ψυχεδέλεια", 3, "2026-09-01T10:00:00", { date: "2026-11-25" }),
];
const ids = (list: SetSummary[]) => list.map(s => s.id);

describe("visibleSets", () => {
  test("sorts by name (Greek first, numbers in order, case ignored), date (own date first) and size", () => {
    expect(ids(visibleSets(SETS, "", { key: "name", desc: false }))).toEqual([4, 2, 3, 1]);
    expect(ids(visibleSets(SETS, "", { key: "date", desc: true }))).toEqual([4, 3, 2, 1]);
    expect(ids(visibleSets(SETS, "", { key: "size", desc: true }))).toEqual([1, 4, 3, 2]);
    expect(ids(visibleSets(SETS, "", { key: "size", desc: false }))).toEqual([3, 2, 4, 1]);
  });

  test("filters by name, ignoring case", () => {
    expect(ids(visibleSets(SETS, " DRAFT ", { key: "name", desc: false }))).toEqual([2, 3]);
    expect(ids(visibleSets(SETS, "ψυχ", { key: "name", desc: false }))).toEqual([4]);
  });

  test("the empty ones are the sets with no tracks among those shown", () => {
    expect(emptySetIds(SETS)).toEqual([2, 3]);
    expect(emptySetIds(visibleSets(SETS, "10", { key: "name", desc: false }))).toEqual([3]);
  });
});

describe("bulk delete", () => {
  test("goes one set at a time, keeps going after a failure and says which failed", async () => {
    const calls: number[] = [];
    const result = await deleteSetsOneByOne([{ id: 1, title: "A" }, { id: 2, title: "B" }, { id: 3, title: "C" }], async id => {
      calls.push(id);
      if (id === 2) throw new Error("404: Το set δεν βρέθηκε");
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(result.deleted.map(s => s.id)).toEqual([1, 3]);
    expect(result.failed).toEqual([{ id: 2, title: "B", message: "Το set δεν βρέθηκε" }]);
    expect(deleteSetsSummary(result)).toEqual({ ok: false, title: "Διαγράφηκαν 2 sets· 1 δεν διαγράφηκε", description: "«B»: Το set δεν βρέθηκε" });
  });

  test("messages say the tracks stay in the library", () => {
    expect(deleteSetsMessage(1)).toBe("Το set θα διαγραφεί μαζί με τις μεταβάσεις του. Τα tracks μένουν στη βιβλιοθήκη.");
    expect(deleteSetsMessage(3)).toBe("Τα 3 sets θα διαγραφούν μαζί με τις μεταβάσεις τους. Τα tracks μένουν στη βιβλιοθήκη.");
    expect(deleteSetsSummary({ deleted: [{ id: 1, title: "A" }], failed: [] })).toEqual({ ok: true, title: "Διαγράφηκε 1 set" });
  });
});
