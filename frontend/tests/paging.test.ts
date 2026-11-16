import { expect, test } from "bun:test";
import { clampPage, pageCountFor, pageRangeLabel, pageSlice, visiblePages } from "../src/lib/paging";

const items = Array.from({ length: 96 }, (_, i) => i + 1);

test("96 suggestions make 8 pages of 12 that never repeat", () => {
  expect(pageCountFor(96)).toBe(8);
  expect(pageSlice(items, 2)).toEqual(items.slice(12, 24));
  expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].flatMap(p => pageSlice(items, p))).size).toBe(96);
  expect(pageRangeLabel(2, 96)).toBe("13–24 από 96");
  expect(pageRangeLabel(1, 5)).toBe("1–5 από 5");
  expect(pageRangeLabel(1, 0)).toBe("");
});

test("a shrinking list clamps the page instead of showing an empty one", () => {
  expect(clampPage(8, 84)).toBe(7);
  expect(clampPage(3, 0)).toBe(1);
  expect(pageSlice(items.slice(0, 84), 8)).toEqual(items.slice(72, 84));
  expect(pageRangeLabel(8, 84)).toBe("73–84 από 84");
});

test("at most 8 numbered buttons, kept around the current page", () => {
  expect(visiblePages(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(visiblePages(2, 3)).toEqual([1, 2, 3]);
  expect(visiblePages(12, 20)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  expect(visiblePages(20, 20)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
});
