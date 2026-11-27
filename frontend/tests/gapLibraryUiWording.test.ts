// Test gaps (2026-11-27) for user-facing wording: the set story's Greek at its boundaries, the glossary links
// other pages use, and the recorder's pure helpers.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { describeSetStory, storyMinutes, type SetStoryReading, type StoryChapter } from "../src/lib/setStory";
import { filterGlossary, GLOSSARY_ALL, glossaryFor, glossaryHref } from "../src/lib/glossary";
import { formatElapsed, isFatal, joinBlocks, takeBatch } from "../src/lib/recordingCore";

function chapter(over: Partial<StoryChapter> = {}): StoryChapter {
  return {
    kind: "plateau", first_row: 0, last_row: 7, track_count: 8, start_seconds: 0, seconds: 3300,
    lo: 145, hi: 150, median: 148, entry: null, lufs: -8, lufs_change: null, style: null, key: null, artist: null,
    unknown: { bpm: 0, lufs: 0, bass: 0, key: 0, style: 0 }, drift: null, ...over,
  };
}
function reading(over: Partial<SetStoryReading> = {}): SetStoryReading {
  return {
    track_count: 8, seconds: 3300, crate: false, unknown: { bpm: 0, duration: 0 }, folded: [],
    chapters: [chapter()], parentheses: [], ...over,
  };
}

describe("set story: Greek at the boundaries", () => {
  test.each([
    [-60, "0′"],
    [30, "1′"],
    [3569, "59′"],
    [3570, "1ω 0′"],
    [10 * 3600 + 5 * 60, "10ω 5′"],
  ])("storyMinutes(%p) is %p", (seconds, text) => {
    expect(storyMinutes(seconds)).toBe(text);
  });

  test.each([
    [6, "Έξι κεφάλαια."],
    [7, "7 κεφάλαια."],
    [12, "12 κεφάλαια."],
  ])("%p chapters read «%s»", (n, summary) => {
    const chapters = Array.from({ length: n }, (_, i) => chapter({ first_row: i * 3, last_row: i * 3 + 2, seconds: 0 }));
    expect(describeSetStory(reading({ track_count: n * 3, seconds: 0, chapters })).summary).toBe(summary);
  });

  test("exactly three tracks already tell a story", () => {
    const text = describeSetStory(reading({ track_count: 3, chapters: [chapter({ last_row: 2, track_count: 3 })] }));
    expect(text.chapters).toHaveLength(1);
    expect(text.chapters[0].title).toBe("Κεφάλαιο 1 · tracks 1–3");
  });

  test.each([
    [0.99, null],
    [-0.99, null],
    [1, "1 dB πιο δυνατά από το προηγούμενο"],
    [-1, "1 dB πιο ήσυχα από το προηγούμενο"],
    [-1.5, "2 dB πιο ήσυχα από το προηγούμενο"],
    [3.49, "3 dB πιο δυνατά από το προηγούμενο"],
  ])("a loudness change of %p dB reads %p", (change, phrase) => {
    const body = describeSetStory(reading({ chapters: [chapter(), chapter({ first_row: 8, last_row: 15, lufs_change: change })] }))
      .chapters[1].body;
    if (phrase) expect(body).toContain(phrase);
    else expect(body).not.toContain("dB");
  });

  test("singular and plural notes", () => {
    const one = describeSetStory(reading({ unknown: { bpm: 1, duration: 0 } }));
    expect(one.notes).toEqual(["1 track χωρίς BPM δεν μετρήθηκε."]);
    const many = describeSetStory(reading({ folded: [1, 4, 6], unknown: { bpm: 0, duration: 3 } }));
    expect(many.notes).toEqual([
      "3 tracks με μισό ή διπλό tempo μετρήθηκαν στο tempo του set.",
      "Σε 3 tracks λείπει η διάρκεια, οπότε οι χρόνοι βγαίνουν μικρότεροι.",
    ]);
  });

  test("half-tempo BPMs are rounded, not truncated, in bands and entries", () => {
    const text = describeSetStory(reading({
      chapters: [chapter(), chapter({ first_row: 8, last_row: 15, lo: 72.5, hi: 75.4, entry: { kind: "jump", from_bpm: 149.6, to_bpm: 72.5, three_four: false } })],
    }));
    expect(text.chapters[1].entry).toBe("Άλμα 150 → 73 BPM.");
    expect(text.chapters[1].body).toContain("στα 73–75 BPM");
  });

  test("Greek and symbol names pass through untouched", () => {
    const body = describeSetStory(reading({
      chapters: [chapter({ style: { name: "Ψυχεδελικό ♪ trance", count: 5, of: 8 }, artist: { name: "Σταύρος Ξ.", count: 2 } })],
    })).chapters[0].body;
    expect(body).toBe("Περίπου 55′ σταθερά στα 145–150 BPM, κυρίως Ψυχεδελικό ♪ trance, 2 tracks του Σταύρος Ξ..");
  });

  test("the first chapter never shows a start time; a later one without one shows none", () => {
    const text = describeSetStory(reading({
      chapters: [chapter({ start_seconds: 600 }), chapter({ first_row: 8, last_row: 15, start_seconds: 0 })],
    }));
    expect(text.chapters.map(c => c.title)).toEqual(["Κεφάλαιο 1 · tracks 1–8", "Κεφάλαιο 2 · tracks 9–16"]);
  });

  test("a drift with every part empty says nothing", () => {
    const text = describeSetStory(reading({ chapters: [chapter({ drift: { tempo: null, lufs: null, bass: null } })] }));
    expect(text.chapters[0].drift).toBeNull();
  });

  test("a set with BPM-less tracks and too few tracks still reports the BPM note", () => {
    const text = describeSetStory(reading({ track_count: 2, unknown: { bpm: 1, duration: 0 }, chapters: [chapter({ last_row: 0 })] }));
    expect(text.notes).toEqual(["1 track χωρίς BPM δεν μετρήθηκε."]);
    expect(text.chapters).toEqual([]);
  });
});

describe("glossary links from other pages", () => {
  test("every <GlossaryLink id> and glossaryHref(\"…\") in src names an entry of a build without the Maximizer", async () => {
    const ids = new Set(glossaryFor(false).map(t => t.id));
    const src = `${import.meta.dir}/../src`;
    const used: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan(src)) {
      const text = await Bun.file(`${src}/${file}`).text();
      for (const m of text.matchAll(/<GlossaryLink\s+id="([^"]+)"/g)) used.push(m[1]);
      for (const m of text.matchAll(/glossaryHref\("([^"]+)"\)/g)) used.push(m[1]);
      for (const m of text.matchAll(/["'`]\/glossary#([a-z0-9-]+)/g)) used.push(m[1]);
    }
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(id => !ids.has(id))).toEqual([]);
  });

  test("glossaryHref keeps the id as the hash", () => {
    for (const { id } of GLOSSARY_ALL) expect(new URL(glossaryHref(id), "http://x").hash).toBe(`#${id}`);
  });

  test("a blank query lists every entry; a word nowhere lists none", () => {
    const terms = glossaryFor(false);
    expect(filterGlossary(terms, "   \t ")).toHaveLength(terms.length);
    expect(filterGlossary(terms, "ζζζζζζ")).toEqual([]);
  });
});

describe("recorder helpers: boundaries", () => {
  test.each([
    [59.999, "0:59"],
    [60, "1:00"],
    [3599.9, "59:59"],
    [3600, "1:00:00"],
    [36_000 + 61, "10:01:01"],
    [100 * 3600, "100:00:00"],
  ])("formatElapsed(%p) is %p", (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });

  test.each([
    ["400: Λάθος αίτημα", true],
    ["499: x", true],
    ["399: x", false],
    ["500: x", false],
    ["Σφάλμα 409: x", false],
    ["4000: x", false],
    ["", false],
  ])("isFatal(Error(%p)) is %p", (message, fatal) => {
    expect(isFatal(new Error(message))).toBe(fatal);
  });

  test("isFatal never throws on odd values", () => {
    for (const value of [null, undefined, 0, {}, { message: "409: x" }, { code: null }]) {
      expect(isFatal(value)).toBe(false);
    }
  });

  test("takeBatch: a batch that fits exactly is taken whole; the order is kept; the queue is not changed", () => {
    const q = [new Float32Array([1, 1]), new Float32Array([2, 2]), new Float32Array([3, 3, 3])];
    const [batch, rest] = takeBatch(q, 4);
    expect(batch.map(b => b[0])).toEqual([1, 2]);
    expect(rest.map(b => b[0])).toEqual([3]);
    expect(q).toHaveLength(3);
    const [all, none] = takeBatch(q, 7);
    expect([all.length, none.length]).toEqual([3, 0]);
  });

  test("takeBatch: an oversized first block goes alone and the rest waits", () => {
    const [batch, rest] = takeBatch([new Float32Array(100), new Float32Array(1)], 10);
    expect([batch.length, rest.length]).toEqual([1, 1]);
  });

  test("draining a queue batch by batch sends every sample once, in order", () => {
    let queue = Array.from({ length: 50 }, (_, i) => new Float32Array(1 + (i % 7)).fill(i));
    const sent: number[] = [];
    let posts = 0;
    while (queue.length) {
      const [batch, rest] = takeBatch(queue, 16);
      sent.push(...joinBlocks(batch));
      queue = rest;
      posts++;
    }
    const expected = Array.from({ length: 50 }, (_, i) => Array(1 + (i % 7)).fill(i)).flat();
    expect(sent).toEqual(expected);
    expect(posts).toBeLessThan(50);
  });
});
