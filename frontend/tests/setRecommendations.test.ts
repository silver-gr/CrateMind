import { expect, test } from "bun:test";
import { refillSetRecommendations } from "../src/lib/setRecommendations";
import type { Recommendation } from "../src/lib/types";

const rec = (track_id: number, score = 1) => ({ track_id, score }) as Recommendation;

test("refill removes added tracks, retains surviving order and appends a fresh pick", () => {
  const previous = [rec(1), rec(2), rec(3)];
  const fresh = [rec(4), rec(3, 30), rec(2, 20), rec(1)];
  expect(refillSetRecommendations(previous, fresh, new Set([1]), 3)).toEqual([
    rec(2, 20), rec(3, 30), rec(4),
  ]);
  expect(previous).toEqual([rec(1), rec(2), rec(3)]);
});

test("refill does not repeat cards or retain picks absent from the updated result", () => {
  expect(refillSetRecommendations([rec(2), rec(3)], [rec(4), rec(4), rec(2)], new Set(), 12))
    .toEqual([rec(2), rec(4)]);
});

test("an exhausted candidate pool stays short instead of inventing replacements", () => {
  expect(refillSetRecommendations([rec(1)], [rec(1)], new Set([1]), 12)).toEqual([]);
  expect(refillSetRecommendations([], [rec(3), rec(4)], new Set(), 1)).toEqual([rec(3)]);
});
