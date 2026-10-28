import { afterEach, expect, test } from "bun:test";
import { api } from "../src/lib/api";
import { formatSetDuration } from "../src/lib/setDuration";
import { setKeyStats, formatSetBpmRange } from "../src/lib/setStats";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("set duration uses hours and minutes at hour boundaries", () => {
  expect(formatSetDuration(4 * 3600 + 14 * 60 + 59)).toBe("4ω 14'");
  expect(formatSetDuration(3600)).toBe("1ω 0'");
  expect(formatSetDuration(3599)).toBe("59'");
  expect(formatSetDuration(0)).toBe("0'");
});

test("set keys include analyzed keys, count distinct keys and retain the full path", () => {
  const stats = setKeyStats([
    { key_text: null, key_analyzed: "12B" },
    { key_text: " ", key_analyzed: "E major" },
    { key_text: "~1A", key_analyzed: "12B" },
    { key_text: null, key_analyzed: "unknown" },
  ]);
  expect(stats.counts).toEqual({ "12B": 2, "1A": 1 });
  expect(stats.distinct).toBe(2);
  expect(stats.path).toEqual(["12B", "12B", "1A"]);
  expect(stats.lastKey).toBeNull();
  expect(setKeyStats([{ key_analyzed: "12B" }]).lastKey).toBe("12B");
  expect(setKeyStats([]).distinct).toBe(0);
});

test("BPM range rounds presentation only and ignores missing or invalid values", () => {
  const values = [140, 169.98, null, 0, Number.NaN];
  expect(formatSetBpmRange(values)).toBe("140–170");
  expect(values[1]).toBe(169.98);
  expect(formatSetBpmRange([])).toBe("—");
});

test("removal sends the clicked occurrence position, including position zero", async () => {
  const calls: { url: unknown; method?: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url, method: init?.method });
    return Response.json({ removed: true });
  }) as typeof fetch;
  await api.removeSetTrack(3, 7, 0);
  await api.removeSetTrack(3, 7, 2200063);
  expect(calls).toEqual([
    { url: "/api/sets/3/tracks/7?position=0", method: "DELETE" },
    { url: "/api/sets/3/tracks/7?position=2200063", method: "DELETE" },
  ]);
});
