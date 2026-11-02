import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QUEUE_PAGE, appendPage, hasMorePages, progressLine, queueFilters, queueQuery, shouldFetchNextPage } from "../src/lib/queuePaging";
import type { Facet, Track } from "../src/lib/types";

const purpose: Facet = { id: 1, key: "purpose", label: "Θεραπευτικός στόχος", multi: true, sort_order: 0, values: [] };
const mood: Facet = { id: 2, key: "mood", label: "Διάθεση", multi: true, sort_order: 1, values: [] };
const track = (id: number): Track => ({ id, file_name: `${id}.mp3`, absolute_path: `/${id}.mp3`, extension: "mp3", play_count: 0, missing: false });

describe("queue filters", () => {
  test("therapy filters are built from the vocabularies", () => {
    expect(queueFilters([purpose, mood], "therapy")).toEqual([
      { label: "Όλα", q: "" },
      { label: "Χωρίς tags", q: "untagged" },
      { label: "Υπό δοκιμή", q: "testing" },
      { label: "Για έλεγχο", q: "status:unknown" },
      { label: "Χωρίς Θεραπευτικός στόχος", q: "-purpose:*" },
      { label: "Χωρίς Διάθεση", q: "-mood:*" },
    ]);
  });

  test("DJ keeps its bridge and blend queues and its wording", () => {
    const dj = queueFilters([purpose], "dj");
    expect(dj).toContainEqual({ label: "Δοκιμή", q: "testing" });
    expect(dj).toContainEqual({ label: "Υποψήφιες γέφυρες", q: "role:bridge" });
    expect(dj).toContainEqual({ label: "Μεγάλο blend", q: "tolerance:huge" });
    expect(dj).toContainEqual({ label: "Χωρίς Θεραπευτικός στόχος", q: "-purpose:*" });
    expect(queueFilters([], "therapy").map(f => f.q)).toEqual(["", "untagged", "testing", "status:unknown"]);
  });

  test("queueQuery scopes a filter to a folder, never matching a sibling prefix", () => {
    expect(queueQuery("-purpose:*", "C:/Music/A")).toBe('-purpose:* folder:"C:/Music/A/"');
    expect(queueQuery("", "C:/Music/A/")).toBe('folder:"C:/Music/A/"');
    expect(queueQuery("untagged", "")).toBe("untagged");
    expect(queueQuery("", "")).toBe("");
  });
});

describe("paging", () => {
  test("appendPage keeps order and drops ids already loaded", () => {
    expect(appendPage([1, 2, 3].map(track), [3, 4].map(track)).map(t => t.id)).toEqual([1, 2, 3, 4]);
  });

  test("a short page means the queue is exhausted", () => {
    expect(QUEUE_PAGE).toBe(500);
    expect(hasMorePages(Array.from({ length: 500 }, (_, i) => track(i)))).toBe(true);
    expect(hasMorePages(Array.from({ length: 499 }, (_, i) => track(i)))).toBe(false);
    expect(hasMorePages([])).toBe(false);
  });

  test("the next page is fetched 25 rows before the end, once, and never in shuffle", () => {
    const at = (idx: number, over: Partial<Parameters<typeof shouldFetchNextPage>[0]> = {}) =>
      shouldFetchNextPage({ idx, loaded: 500, hasMore: true, inFlight: false, shuffle: false, ...over });
    expect(at(500 - 26)).toBe(false);
    expect(at(500 - 25)).toBe(true);
    expect(at(499)).toBe(true);
    expect(at(499, { inFlight: true })).toBe(false);
    expect(at(499, { shuffle: true })).toBe(false);
    expect(at(499, { hasMore: false })).toBe(false);
    expect(at(0, { loaded: 0 })).toBe(false);
  });

  test("progressLine uses Greek digit grouping", () => {
    expect(progressLine(1240, 6800)).toBe("Ταξινομημένα 1.240 / 6.800");
  });
});

describe("TaggingQueue wiring", () => {
  const source = readFileSync(new URL("../src/pages/TaggingQueue.tsx", import.meta.url), "utf8");

  // Booleans keep a failure readable (toContain would print the whole page source).
  const has = (text: string) => source.includes(text);

  test("pages by keyset with one in-flight guard and no whole-library request", () => {
    for (const text of ["queueQuery(queue, folder)", "hasMorePages(", "appendPage(", "inFlight: pageInFlight.current", "shouldFetchNextPage({"]) {
      expect([text, has(text)]).toEqual([text, true]);
    }
    // Every request is one page: QUEUE_PAGE is always the limit, never 0 (whole library).
    const calls = source.match(/listTracks\(/g) ?? [];
    const paged = source.match(/listTracks\([^,]*,\s*QUEUE_PAGE,/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(paged.length).toBe(calls.length);
  });

  test("filters, folders and the preset come from the API", () => {
    for (const text of ["queueFilters(", "listFolders()", 'loadFacetPreset("therapy")', "Φόρτωση προτεινόμενου λεξιλογίου"]) {
      expect([text, has(text)]).toEqual([text, true]);
    }
  });
});
