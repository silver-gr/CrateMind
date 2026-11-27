import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LIBRARY_SIDE_BY_SIDE_MIN, deckMatchTerms, hasSortToken, librarySideBySide, sessionPlayedIds, termsActive, toggleTerms, totalDurationLabel,
} from "../src/lib/libraryExtras";
import { parseQueryChips } from "../src/lib/queryChips";
import type { PlayHistoryEntry, Track } from "../src/lib/types";

const track = (fields: Partial<Track>): Track => ({ id: 1, absolute_path: "/a.mp3", file_name: "a.mp3", extension: "mp3", ...fields }) as Track;

describe("deck match terms", () => {
  test("tempo within about 6 % and the compatible Camelot keys", () => {
    expect(deckMatchTerms(track({ bpm: 143, key_text: "Am" }))).toEqual(["bpm:134-152", "key:8A,9A,7A,8B"]);
  });

  test("the fallback key and the wheel wrap", () => {
    expect(deckMatchTerms(track({ key_djay: "12B" }))).toEqual(["key:12B,1B,11B,12A"]);
  });

  test("nothing to match on", () => {
    expect(deckMatchTerms(track({}))).toEqual([]);
  });

  test("a click adds the terms in place of a bpm or key filter, a second click removes them", () => {
    const terms = ["bpm:134-152", "key:8A,9A,7A,8B"];
    const added = toggleTerms("energy:8-9 bpm:120-125 -key:1A", terms);
    expect(added).toBe("energy:8-9 -key:1A bpm:134-152 key:8A,9A,7A,8B");
    expect(termsActive(added, terms)).toBe(true);
    expect(toggleTerms(added, terms)).toBe("energy:8-9 -key:1A");
    expect(termsActive("bpm:134-152", terms)).toBe(false);
  });

  test("a removed term inside an OR group takes its OR along", () => {
    const terms = ["bpm:134-152", "key:8A,9A,7A,8B"];
    expect(toggleTerms("role:peak OR bpm:140-150 energy:8", terms))
      .toBe("role:peak energy:8 bpm:134-152 key:8A,9A,7A,8B");
    expect(toggleTerms("bpm:140-150 OR role:peak energy:8", terms))
      .toBe("role:peak energy:8 bpm:134-152 key:8A,9A,7A,8B");
    expect(toggleTerms("role:peak OR bpm:134-152 OR role:warmup key:8A,9A,7A,8B", terms))
      .toBe("role:peak OR role:warmup");
  });
});

test("only a known sort: field overrides the column sort", () => {
  expect(hasSortToken("energy:9 sort:-bpm")).toBe(true);
  expect(hasSortToken("-sort:Energy limit:5")).toBe(true);
  expect(hasSortToken("sort:colour")).toBe(false);
  expect(hasSortToken("sort bpm")).toBe(false);
});

test("total duration", () => {
  expect(totalDurationLabel(34 * 3600 + 12 * 60 + 20)).toBe("34 ώ 12 λ");
  expect(totalDurationLabel(12 * 60 + 40)).toBe("13 λ");
  expect(totalDurationLabel(0)).toBe("0 λ");
});

test("session plays start at or after the app's start", () => {
  const play = (id: number, trackId: number, at: string) => ({ id, track_id: trackId, played_at: at }) as PlayHistoryEntry;
  const since = Date.parse("2026-11-26T10:00:00Z");
  const ids = sessionPlayedIds([play(1, 5, "2026-11-26T10:05:00Z"), play(2, 6, "2026-11-26T09:59:00Z"), play(3, 7, "2026-11-26T10:00:00Z")], since);
  expect([...ids].sort()).toEqual([5, 7]);
});

test("chips for OR, plays, key lists, sort and limit", () => {
  const labels = parseQueryChips("energy:8-9 OR role:peak plays:5+ key:8A,9A sort:-bpm -sort:key limit:20 \"OR\"").map(c => c.label);
  expect(labels[1]).toBe("ή");
  expect(labels.slice(3)).toEqual([
    "≥ 5 παιξίματα", "κλειδί 8A, 9A",
    "ταξινόμηση: BPM ↓", "ταξινόμηση: κλειδί ↓", "πρώτα 20", "\"OR\"",
  ]);
});

test("the Library switches to side by side at the same page width whether or not the inspector is in the rail", () => {
  // Inspector in the page: the page's width is all of it.
  expect(librarySideBySide(LIBRARY_SIDE_BY_SIDE_MIN, 384, false)).toBe(true);
  expect(librarySideBySide(LIBRARY_SIDE_BY_SIDE_MIN - 1, 384, false)).toBe(false);
  // Inspector in the rail: the page leaves it out, so its width counts again and nothing flips back and forth.
  expect(librarySideBySide(LIBRARY_SIDE_BY_SIDE_MIN - 384, 384, true)).toBe(true);
  expect(librarySideBySide(LIBRARY_SIDE_BY_SIDE_MIN - 385, 384, true)).toBe(false);
  // 1,440 px window, 330 px sidebar, 384 px inspector: side by side.
  expect(librarySideBySide(1440 - 330 - 384, 384, true)).toBe(true);
});

test("the Library's inspector goes to the shell's rail only side by side", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  expect(library).toContain("<PageRail inline={!wide}>");
  expect(library).not.toContain("@min-[56rem]");
});
