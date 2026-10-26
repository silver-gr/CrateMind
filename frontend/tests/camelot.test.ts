import { describe, expect, test } from "bun:test";
import { ALL_CAMELOT, CAMELOT_TO_MUSICAL, camelotCode, formatKey, keyColor, neighbors, toCamelot } from "../src/lib/camelot";

describe("musical key schema", () => {
  test.each([
    ["A minor", "8A"], ["8a", "8A"], [" 8 A ", "8A"], ["８Ａ", "8A"],
    ["AM", "11B"], ["Am", "8A"], ["A MAJOR", "11B"],
    ["F♯ minor", "11A"], ["G♭m", "11A"], ["A♭ major", "4B"],
    ["C-sharp minor", "12A"], ["D flat major", "3B"],
    ["1m", "8A"], ["1d", "8B"], ["6m", "1A"], ["12d", "7B"],
  ])("normalizes %s as %s", (raw, expected) => {
    const parsed = toCamelot(raw);
    expect(parsed && camelotCode(parsed)).toBe(expected);
  });

  test.each(["0A", "13B", "0m", "13d", "C dorian", "unknown", "C diminished", "Am7", "", null])(
    "rejects unsupported keys: %s", (raw) => expect(toCamelot(raw)).toBeNull(),
  );

  test("all 24 display keys round-trip to their Camelot buckets", () => {
    for (const code of ALL_CAMELOT) {
      expect(camelotCode(toCamelot(CAMELOT_TO_MUSICAL[code])!)).toBe(code);
    }
  });

  test("uses analyzed keys when the metadata field is blank", () => {
    expect(formatKey("   ", "A minor", "both")).toBe("8A · Am");
    expect(keyColor("   ", "A minor")).toBe(keyColor("8A"));
    expect(formatKey("C major", "A minor")).toBe("8B");
  });

  test("harmonic neighbors wrap across 12 and retain the relative mode", () => {
    expect(neighbors({ n: 12, side: "A" }).map(camelotCode)).toEqual(["1A", "11A", "12B"]);
    expect(neighbors({ n: 1, side: "B" }).map(camelotCode)).toEqual(["2B", "12B", "1A"]);
  });
});
