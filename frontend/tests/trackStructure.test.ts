import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { cueSuggestions, formatBars, ghostPads, isPhraseTime, mapBlocks, mixPoints, padMixPoints, sectionKinds, sectionMarks, structureDuration, structureSummary, suggestionTitle, type StructureSection } from "../src/lib/trackStructure";

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
    expect(structureSummary([sec(0, 256, true), sec(102, 32, false), sec(115, 64, true)])).toBe("Πρώτο μπάσο 0:00 · 1 break");
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
  test("section marks name each part and its length for the scrolling waveform", () => {
    expect(sectionMarks(track).map(m => [m.time_s, m.text, m.bass])).toEqual([
      [0.2, "Εισαγωγή · 32 bars", false], [51.4, "Μπάσο · 64 bars", true], [153.8, "Break · 16 bars", false],
      [179.4, "Μπάσο · 64 bars", true], [281.8, "Κλείσιμο · 16 bars", false]]);
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

describe("preset cues from structure", () => {
  // The track above on its own grid: 150 BPM, bar 1 at 0.2 s, every section start on a bar line.
  const grid: BeatGrid = { kind: "straight", anchor: 0.2, period: 0.4, estimated: false, overridden: false, source: "cratemind" };
  const common = { quality: 0.9, sections: track, anchors: [51.4, 179.4] };
  const points = (s: Parameters<typeof cueSuggestions>[0], g: BeatGrid | null = grid, duration = 307.4) =>
    cueSuggestions(s, g, duration).map(c => [c.slot + 1, c.label, +c.time_s.toFixed(3)]);
  const withSections = (sections: StructureSection[], anchors = common.anchors) => ({ ...common, sections, anchors });

  test("a common track gets pads 5 to 8, the third 8 bars before the bass returns", () => {
    expect(points(common)).toEqual([[5, "Πρώτο μπάσο", 51.4], [6, "Break", 153.8], [7, "Πριν το drop", 166.6], [8, "Τέλος μπάσου", 281.8]]);
    expect(cueSuggestions(common, grid, 0).length).toBe(4); // no catalog length: the structure's own
    expect(cueSuggestions(common, grid, 307.4)[0].beat_s).toBeCloseTo(0.4, 9);
  });
  test("a short pause is not a break: an old row with 2-bar pauses reads like a new one", () => {
    const paused = [sec(0.2, 128, false), sec(51.4, 120, true), sec(99.4, 8, false), sec(102.6, 128, true), ...track.slice(2)];
    expect(points(withSections(paused, [51.4, 102.6, 179.4]))).toEqual(points(common));
    // No break of 8 bars or more: the first and the last only.
    const flat = [sec(0.2, 128, false), sec(51.4, 280, true), sec(163.4, 16, false), sec(169.8, 280, true), sec(281.8, 64, false)];
    expect(points(withSections(flat, [51.4, 169.8]))).toEqual([[5, "Πρώτο μπάσο", 51.4], [8, "Τέλος μπάσου", 281.8]]);
  });
  test("the longest break is the one that counts, and a break of exactly 8 bars has no pad 7", () => {
    const two = [sec(0.2, 128, false), sec(51.4, 128, true), sec(102.6, 32, false), sec(115.4, 96, true), ...track.slice(2)];
    expect(points(withSections(two, [51.4, 115.4, 179.4]))).toEqual(points(common));
    const eight = [sec(0.2, 128, false), sec(51.4, 256, true), sec(153.8, 32, false), sec(166.6, 288, true), sec(281.8, 64, false)];
    expect(points(withSections(eight, [51.4, 166.6]))).toEqual([[5, "Πρώτο μπάσο", 51.4], [6, "Break", 153.8], [8, "Τέλος μπάσου", 281.8]]);
  });
  test("a point one beat off the bar line is moved onto it; two beats off, the track gets nothing", () => {
    const late = track.map((s, i) => (i === 2 ? { ...s, start_s: 154.2 } : s));
    expect(points(withSections(late))).toEqual(points(common));
    expect(points(withSections(track.map((s, i) => (i === 2 ? { ...s, start_s: 154.6 } : s))))).toEqual([]);
  });
  test("any other track gets none", () => {
    expect(points({ ...common, quality: 0.79 })).toEqual([]);
    expect(points(common, null)).toEqual([]);
    expect(points(common, { ...grid, estimated: true })).toEqual([]);
    expect(points({ ...common, anchors: [179.4] })).toEqual([]); // the first bass fades in
    expect(points({ ...common, anchors: [51.4] })).toEqual([]); // the bass fades back in after the break
    expect(points(withSections([sec(0.2, 16, false), sec(6.6, 368, true), ...track.slice(2)], [6.6, 179.4]))).toEqual([]); // 4-bar lead-in
    expect(points(withSections(track.slice(1)))).toEqual([]); // bass from the start
    expect(points(withSections(track.slice(0, 4)))).toEqual([]); // ends with bass
    expect(points(withSections([...track.slice(0, 4), sec(281.8, 8, false)]))).toEqual([]); // 2-bar closing
    expect(points(common, grid, 900)).toEqual([]); // the bass ends in the first half
    expect(points(common, grid, 90)).toEqual([]); // the first bass is in the second half
    const many = [sec(0.2, 128, false), ...[0, 1, 2, 3].flatMap(i => [sec(51.4 + i * 51.2, 96, true), sec(89.8 + i * 51.2, 32, false)]), sec(256.2, 64, true), sec(281.8, 64, false)];
    expect(points(withSections(many, [51.4, 102.6, 153.8, 205, 256.2]))).toEqual([]); // four long breaks
  });
  test("a ghost shows only on an empty pad with no saved cue within a beat of it", () => {
    const all = cueSuggestions(common, grid, 307.4);
    const empty = Array(8).fill(null);
    expect(ghostPads(all, empty, []).map(g => g?.label ?? null)).toEqual([null, null, null, null, "Πρώτο μπάσο", "Break", "Πριν το drop", "Τέλος μπάσου"]);
    expect(ghostPads([], empty, [])).toEqual(empty);
    // Pad 6 holds a cue; a cue elsewhere sits 0.3 s (under a beat) from the first bass; one 0.5 s from the last point is its own.
    const cues = [{ id: 1, position_ms: 9000 }, { id: 2, position_ms: 51_700 }, { id: 3, position_ms: 282_300 }];
    expect(ghostPads(all, [2, null, null, null, null, 1, null, null], cues).map(g => g?.slot ?? null)).toEqual([null, null, null, null, null, null, 6, 7]);
    // A pad that still names a deleted cue is empty.
    expect(ghostPads(all, [null, null, null, null, 99, null, null, null], [])[4]?.label).toBe("Πρώτο μπάσο");
    expect(suggestionTitle(all[2])).toBe("Πρόταση: Πριν το drop 2:47 · πάτησε για να πας εκεί");
  });
  test("the Phrase Finder list carries the pad numbers and the extra point", () => {
    const rows = padMixPoints(mixPoints(track), cueSuggestions(common, grid, 307.4));
    expect(rows.map(r => [r.label, r.pad])).toEqual([["Πρώτο μπάσο", 5], ["Break", 6], ["Πριν το drop", 7], ["Επιστροφή μπάσου", null], ["Τέλος μπάσου", 8]]);
    expect(rows[2].detail).toBe("8 bars πριν επιστρέψει το μπάσο");
    expect(padMixPoints(mixPoints(track), [])).toEqual(mixPoints(track).map(p => ({ ...p, pad: null })));
  });
});
