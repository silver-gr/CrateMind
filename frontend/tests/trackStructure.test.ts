import { describe, expect, test } from "bun:test";
import { formatBars, isPhraseTime, mapBlocks, mixPoints, sectionKinds, structureDuration, structureSummary, type StructureSection } from "../src/lib/trackStructure";

const sec = (start_s: number, beats: number, bass: boolean, level = 0.5): StructureSection => ({ start_s, beats, bass, level });
// Intro 32 bars, bass, a break, bass, outro 16 bars (0.4 s per beat).
const track = [sec(0.2, 128, false, 0.3), sec(51.4, 256, true, 1), sec(153.8, 64, false, 0.4), sec(179.4, 256, true, 0.95), sec(281.8, 64, false, 0.2)];

describe("track structure helpers", () => {
  test("sections are named by where they sit", () => {
    expect(sectionKinds(track)).toEqual(["intro", "main", "break", "main", "outro"]);
    expect(sectionKinds([sec(0, 64, true), sec(26, 32, false)])).toEqual(["main", "outro"]);
    expect(sectionKinds([sec(0, 64, false)])).toEqual(["intro"]);
  });
  test("lengths read in bars", () => {
    expect(formatBars(128)).toBe("32 bars");
    expect(formatBars(122)).toBe("30.5 bars");
  });
  test("the summary line names intro, first bass, breaks and outro", () => {
    expect(structureSummary(track)).toBe("Εισαγωγή 32 bars · πρώτο μπάσο 0:51 · 1 break · κλείσιμο 16 bars");
    expect(structureSummary([sec(0, 256, true), sec(102, 32, false), sec(115, 64, true)])).toBe("πρώτο μπάσο 0:00 · 1 break");
    expect(structureSummary([sec(0, 64, false), sec(26, 256, true)])).toBe("Εισαγωγή 16 bars · πρώτο μπάσο 0:26 · 0 breaks");
  });
  test("mix points: first bass, each break and return, the end of the bass", () => {
    expect(mixPoints(track).map(p => [p.kind, p.time_s])).toEqual([["first-bass", 51.4], ["break", 153.8], ["return", 179.4], ["last-out", 281.8]]);
    expect(mixPoints(track).map(p => p.label)).toEqual(["Πρώτο μπάσο", "Break", "Επιστροφή μπάσου", "Τέλος μπάσου"]);
    expect(mixPoints(track).map(p => p.detail)).toEqual(["μετά από 32 bars εισαγωγής", "κρατάει 16 bars", "παίζει 64 bars", "κλείσιμο 16 bars"]);
    expect(mixPoints([sec(0, 64, true), sec(26, 32, false)])[0].detail).toBe("από την αρχή");
    expect(structureDuration(track)).toBeCloseTo(281.8 + 64 * 0.4, 1);
    expect(structureDuration([])).toBe(0);
  });
  test("map blocks cover the whole track once", () => {
    const blocks = mapBlocks(track, 310);
    expect(blocks[0].left).toBe(0);
    expect(blocks.reduce((sum, b) => sum + b.width, 0)).toBeCloseTo(1, 6);
    expect(blocks.map(b => b.kind)).toEqual(["intro", "main", "break", "main", "outro"]);
    expect(blocks[1].left).toBeCloseTo(51.4 / 310, 6);
    expect(mapBlocks(track, 0)).toEqual([]);
    expect(mapBlocks(track, 200).every(b => b.left >= 0 && b.left + b.width <= 1 + 1e-9)).toBe(true);   // a duration shorter than the last section
  });
  test("a time is a phrase line within the tolerance", () => {
    const phrases = [0.2, 13.0, 25.8, 38.6, 51.4];
    expect(isPhraseTime(phrases, 25.82, 0.05)).toBe(true);
    expect(isPhraseTime(phrases, 25.9, 0.05)).toBe(false);
    expect(isPhraseTime(phrases, 51.4, 0.05)).toBe(true);
    expect(isPhraseTime([], 1, 0.05)).toBe(false);
  });
});
