import { describe, expect, test } from "bun:test";
import { barsBetween, sectionAt, seekHoverText } from "../src/lib/barsFromPlayhead";
import { buildBeatGrid, type BeatGrid } from "../src/lib/beatGrid";
import type { StructureSection } from "../src/lib/trackStructure";

const straight = buildBeatGrid({ bpm: 150, straight: true, anchor_s: 0.4, first_downbeat_index: 0, beats: null }, null, null)!;
const bar = (4 * 60) / 150; // 1.6 s
const at = (n: number, frac = 0.5) => 0.4 + (n + frac) * bar; // inside the bar n bars after bar 1

describe("bars between the playhead and the pointer", () => {
  test("counts bar lines, the same forwards and backwards", () => {
    expect(barsBetween(straight, at(10), at(26))).toBe(16);
    expect(barsBetween(straight, at(26), at(10))).toBe(-16);
    expect(barsBetween(straight, at(10, 0.1), at(10, 0.9))).toBe(0);
    // Crossing one bar line, however little: one bar.
    expect(barsBetween(straight, at(10, 0.99), at(11, 0.01))).toBe(1);
  });
  test("never gives −0", () => {
    expect(Object.is(barsBetween(straight, at(5, 0.8), at(5, 0.2)), -0)).toBe(false);
    expect(seekHoverText(straight, at(5, 0.8), at(5, 0.2))).toBe("0 bars");
  });
  test("before the first downbeat the grid's tempo continues", () => {
    expect(barsBetween(straight, 0, at(2))).toBe(3); // 0:00 is in the bar before bar 1
  });
  test("follows a list grid's real beats across a tempo change", () => {
    // 8 bars at 0.5 s a beat, then 8 bars at 0.4 s a beat.
    const times = [...Array.from({ length: 32 }, (_, i) => i * 0.5), ...Array.from({ length: 33 }, (_, i) => 16 + i * 0.4)];
    const list: BeatGrid = { kind: "list", times, downIndex: 0, estimated: false, overridden: false };
    expect(barsBetween(list, 1, 16 + 0.4 * 4 * 3 + 0.1)).toBe(11);
    // Past the last beat, the last gap goes on.
    expect(barsBetween(list, 0.1, 29.2 + 1.6 + 0.1)).toBe(17);
  });
});

describe("the hover's text", () => {
  test("signs and the minus sign", () => {
    expect(seekHoverText(straight, at(10), at(26))).toBe("+16 bars");
    expect(seekHoverText(straight, at(40), at(12))).toBe("−28 bars");
  });
  test("an estimated grid says so; one the user gave a downbeat does not", () => {
    const estimate = buildBeatGrid(null, 150, 0.4)!;
    expect(seekHoverText(estimate, at(10), at(26))).toBe("≈ +16 bars");
    expect(seekHoverText({ ...estimate, overridden: true }, at(10), at(26))).toBe("+16 bars");
  });
  test("with no grid, the time", () => {
    expect(seekHoverText(null, 100, 126.2)).toBe("+0:26");
    expect(seekHoverText(null, 100, 36)).toBe("−1:04");
    expect(seekHoverText(null, 100, 100.3)).toBe("0:00");
  });
});

describe("the part under the pointer", () => {
  const sections: StructureSection[] = [
    { start_s: 0, beats: 64, bass: false, level: 0.2 },
    { start_s: 25.6, beats: 128, bass: true, level: 0.8 },
    { start_s: 76.8, beats: 64, bass: false, level: 0.3 },
    { start_s: 102.4, beats: 128, bass: true, level: 0.8 },
    { start_s: 153.6, beats: 64, bass: false, level: 0.2 },
  ];
  test("names each part, the last one too", () => {
    expect(sectionAt(sections, 10)).toBe("Εισαγωγή");
    expect(sectionAt(sections, 30)).toBe("Κύριο μέρος");
    expect(sectionAt(sections, 80)).toBe("Break");
    expect(sectionAt(sections, 200)).toBe("Κλείσιμο");
  });
  test("a build-up and the drop after it", () => {
    const built: StructureSection[] = [sections[0], { start_s: 25.6, beats: 32, bass: true, level: 0.5, kind: "buildup" }, { start_s: 38.4, beats: 96, bass: true, level: 0.8 }, ...sections.slice(2)];
    expect(sectionAt(built, 30)).toBe("Build-up");
    expect(sectionAt(built, 40)).toBe("Drop");
    expect(sectionAt(built, 110)).toBe("Κύριο μέρος");
  });
  test("nothing without a measured structure", () => {
    expect(sectionAt(null, 10)).toBeNull();
    expect(sectionAt([], 10)).toBeNull();
    expect(sectionAt([{ start_s: 5, beats: 64, bass: true, level: 1 }], 2)).toBeNull();
  });
});
