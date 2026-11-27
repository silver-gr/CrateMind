// Gaps in the tempo and key tests: the stored grid's octave fold (foldPeriod, through buildBeatGrid) at two octaves and
// at its 3% edge, effectiveBpm at the same edges and with an empty manual reading, the BPM badge and the grid agreeing,
// Camelot compatibility over the whole wheel, enharmonic and Unicode key names, and the full key chain a deck shows.
import { describe, expect, test } from "bun:test";
import { buildBeatGrid, gridBpm } from "../src/lib/beatGrid";
import { ALL_CAMELOT, camelotCode, fallbackKey, formatKey, isCompatible, neighbors, toCamelot, type Camelot, type KeySources } from "../src/lib/camelot";
import { bpmSource, effectiveBpm } from "../src/lib/tempo";
import type { BeatGridDto } from "../src/lib/types";

const straight = (bpm: number): BeatGridDto => ({ bpm, straight: true, anchor_s: 0.2, source: "cratemind" } as BeatGridDto);
const periodOf = (bpm: number, deckBpm: number | null) => {
  const grid = buildBeatGrid(straight(bpm), deckBpm, null);
  return grid?.kind === "straight" ? grid.period : null;
};

describe("a stored steady grid follows the deck's octave (foldPeriod)", () => {
  test.each([
    // stored grid BPM, deck BPM, the grid's tempo after the fold
    [140, 35, 35], [140, 70, 70], [140, 280, 280], [140, 560, 560],
    [140, 72, 70],         // 2.8% from 70: folded, and the measured tempo is kept (not the deck's 72)
    [140, 72.2, 140],      // 3.05% from 70: left alone
    [140.5, 140, 140.5],   // same octave: the measured tempo is kept, not rounded to the deck's
    [140, 105, 140],       // 3:4 is not an octave
    [140, null, 140], [140, NaN, 140], [140, 0, 140], [140, -70, 140], [140, Infinity, 140],
  ])("stored %d on a %p BPM deck plays at %d", (stored, deck, tempo) => {
    expect(60 / periodOf(stored, deck)!).toBeCloseTo(tempo, 9);
  });

  test("the fold keeps the stored downbeat", () => {
    const grid = buildBeatGrid(straight(140), 70, null)!;
    expect(grid.kind === "straight" && grid.anchor).toBe(0.2);
  });

  test("the grid's tempo and the BPM badge agree after the fold", () => {
    // tag BPM, CrateMind's grid tempo: the badge (effectiveBpm) keeps the tag's octave, and so does the deck's grid.
    for (const [tag, grid] of [[70, 140], [140, 70], [87, 174], [174, 87], [128, 128.4], [35, 140]] as const) {
      const bpm = effectiveBpm({ bpm: tag, bpm_grid: grid });
      expect(bpmSource({ bpm: tag, bpm_grid: grid })).toBe("grid");
      const built = buildBeatGrid(straight(grid), bpm, null);
      expect(gridBpm(built, bpm)!).toBeCloseTo(bpm!, 1);
    }
  });
});

describe("effectiveBpm at its edges", () => {
  test.each([
    [{ bpm_grid: 35, bpm: 140 }, 140, "grid"],                 // two octaves
    [{ bpm_grid: 560, bpm: 140 }, 140, "grid"],
    [{ bpm_grid: 73.123, bpm: 146.2 }, 146.25, "grid"],        // folded, then two decimals
    [{ bpm_grid: 146, bpm: 150.4 }, 146, "grid"],              // 2.9% from the tag: the same tempo
    [{ bpm_grid: 146, bpm: 150.6 }, 150.6, "metadata"],        // 3.05%: the tag stays
    [{ bpm_grid: 146, bpm_analyzed: 150.6 }, 146, "grid"],     // ... and a machine estimate gives way
    [{ bpm_grid: -146, bpm: 150 }, 150, "metadata"],
    [{ bpm_grid: Infinity, bpm_analyzed: 150 }, 150, "local"],
    // A manual choice without a usable value is no choice: the next source decides.
    [{ bpm_consensus_sources: "manual:octave", bpm_consensus: NaN, bpm: 128 }, 128, "metadata"],
    [{ bpm_consensus_sources: "manual:octave", bpm_consensus: 0, bpm_analyzed: 127 }, 127, "local"],
    [{ bpm_consensus_sources: "manual:octave", bpm_consensus: null, bpm_grid: 126 }, 126, "grid"],
    // Empty provenance strings fall back to a named source, never an empty one.
    [{ display_bpm_hint: 140, metadata_provenance: { bpm: { basis: "" } } }, 140, "metadata:title_annotation"],
    [{ bpm_consensus: 140, bpm_consensus_sources: "" }, 140, "consensus"],
  ])("%j", (track, bpm, source) => {
    expect(effectiveBpm(track as never)).toBe(bpm);
    expect(bpmSource(track as never)).toBe(source);
  });
});

const cam = (code: string): Camelot => toCamelot(code)!;

describe("isCompatible", () => {
  test.each([
    ["8A", "8A", true], ["8A", "8B", true], ["8A", "9A", true], ["8A", "7A", true],
    ["12A", "1A", true], ["1B", "12B", true],               // the wheel wraps
    ["8A", "9B", false], ["8A", "7B", false],               // a diagonal is not a neighbour
    ["8A", "10A", false], ["8A", "2A", false], ["12B", "2B", false],
  ])("%s with %s: %p", (a, b, ok) => {
    expect(isCompatible(cam(a), cam(b))).toBe(ok);
    expect(isCompatible(cam(b), cam(a))).toBe(ok);
  });

  test("over the whole wheel: each key goes with itself and exactly its three neighbours", () => {
    for (const a of ALL_CAMELOT) {
      const expected = new Set([a, ...neighbors(cam(a)).map(camelotCode)]);
      const found = ALL_CAMELOT.filter(b => isCompatible(cam(a), cam(b)));
      expect(new Set(found)).toEqual(expected);
      expect(found).toHaveLength(4);
    }
  });

  test("a missing key is never compatible, not even with another missing key", () => {
    expect(isCompatible(null, cam("8A"))).toBe(false);
    expect(isCompatible(cam("8A"), null)).toBe(false);
    expect(isCompatible(null, null)).toBe(false);
    expect(isCompatible(toCamelot("not a key"), toCamelot("not a key"))).toBe(false);
  });
});

describe("toCamelot: enharmonic, Unicode and mode spellings (as backend musical_key.to_camelot reads them)", () => {
  test.each([
    ["Cb", "1B"], ["B", "1B"], ["B#m", "5A"], ["Cm", "5A"], ["Cbm", "10A"], ["E#", "7B"], ["Fb", "12B"],
    ["Bbm", "3A"], ["A#m", "3A"], ["B flat minor", "3A"], ["Ab min", "1A"], ["G#m", "1A"], ["D#moll", "2A"],
    ["AMIN", "8A"], ["aM", "11B"], ["Dbmaj", "3B"], ["C#dur", "3B"],
    ["Ｃ＃ｍ", "12A"], ["c♯m", "12A"], ["D♭", "3B"], ["\tF♯ minor\n", "11A"],
  ])("%p is %s", (raw, code) => {
    expect(camelotCode(toCamelot(raw)!)).toBe(code);
  });
});

describe("the key a deck shows: tag, then a confident own key, then djay's, then our own at any confidence", () => {
  const method = "cqt-octave-trained-v2";
  test.each([
    ["a tag wins over everything", { key_text: "Am", key_djay: "E minor", key_analyzed: "C major", key_analyzed_confidence: 0.95, key_analyzed_method: method }, "8A"],
    ["an unrecognised tag is still the tag", { key_text: "Weird", key_djay: "E minor", key_analyzed: "C major" }, "Weird"],
    ["a blank tag falls through", { key_text: "  ", key_djay: "E minor", key_analyzed: "C major" }, "9A"],
    ["a confident own key beats djay's", { key_djay: "E minor", key_analyzed: "C major", key_analyzed_confidence: 0.7, key_analyzed_method: method }, "8B"],
    ["an unsure own key gives way to djay's", { key_djay: "E minor", key_analyzed: "C major", key_analyzed_confidence: 0.69, key_analyzed_method: method }, "9A"],
    ["a NaN confidence is not confident", { key_djay: "E minor", key_analyzed: "C major", key_analyzed_confidence: NaN, key_analyzed_method: method }, "9A"],
    ["with no djay key, our own at any confidence", { key_djay: null, key_analyzed: "C major", key_analyzed_confidence: 0.1, key_analyzed_method: method }, "8B"],
    ["a confident but blank own key falls to djay's", { key_djay: "E minor", key_analyzed: "   ", key_analyzed_confidence: 0.9, key_analyzed_method: method }, "9A"],
    ["a leading ~ is dropped", { key_analyzed: "~F#m" }, "11A"],
    ["nothing at all", {}, "—"],
  ] as const)("%s", (_name, track, shown) => {
    const t = track as KeySources;
    expect(formatKey(t.key_text, fallbackKey(t))).toBe(shown);
  });

  test("the fallback key comes back trimmed", () => {
    expect(fallbackKey({ key_analyzed: "  Am \t" })).toBe("Am");
    expect(fallbackKey({ key_djay: " E minor ", key_analyzed: "C major" })).toBe("E minor");
  });
});
