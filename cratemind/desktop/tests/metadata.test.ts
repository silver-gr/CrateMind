// Regression coverage for the metadata-reader parsing rules, mirroring the
// backend code-review fixes (#3/#4/#5/#6 + the BPM>130 rule). These exercise
// the pure filename inference (inferTagsFromFilename) and the embedded-tag
// path (extractTags), which the scanner tests only cover indirectly.
import { assertEquals } from "@std/assert";
import { extractTags, inferTagsFromFilename } from "../src/services/metadata.ts";
import type { FfprobeJson } from "../src/services/ffprobe.ts";

/** Build a probe result whose format-level tags carry the given embedded
 * fields — the desktop stand-in for the backend's monkeypatched Mutagen tags. */
function embedded(tags: Record<string, string>): FfprobeJson {
  return { format: { tags }, streams: [{ codec_type: "audio" }] };
}

// ---- bare-number BPM rule (baeeaec #7): a bare number only counts as a tempo
// tag when > 130; at or below that it is part of the title. --------------------

Deno.test("bare trailing number is BPM only when over 130", () => {
  // <= 130 is part of the title, not a tempo tag — leave it untouched.
  assertEquals(inferTagsFromFilename("/tmp/Kavinsky - Route 66.mp3"), {
    artist: "Kavinsky",
    title: "Route 66",
  });
  assertEquals(inferTagsFromFilename("/tmp/Kavinsky - District 130.mp3"), {
    artist: "Kavinsky",
    title: "District 130",
  });
  // > 130 is treated as BPM and stripped from the title.
  const high = inferTagsFromFilename("/tmp/Kavinsky - Anthem 150.mp3");
  assertEquals(high.artist, "Kavinsky");
  assertEquals(high.title, "Anthem");
  assertEquals(high.bpm, 150);
});

// ---- #3: a parenthetical containing a number is text, not a BPM tag. ----------

Deno.test("parenthetical with a number is not read as BPM", () => {
  const result = inferTagsFromFilename("/tmp/Kavinsky - Nightcall (Area 88).mp3");
  assertEquals(result.artist, "Kavinsky");
  assertEquals(result.title, "Nightcall (Area 88)");
  assertEquals(result.bpm, undefined);
});

// ---- #4: the nested label-prefix branch keeps the BPM parsed from the full
// segment instead of overwriting it with the nested title's (none here). -------

Deno.test("label-prefix filename keeps BPM from the full segment", () => {
  const result = inferTagsFromFilename("/tmp/Rec Music - Artist 128bpm - Title.mp3");
  assertEquals(result.label, "Rec Music");
  assertEquals(result.title, "Title");
  assertEquals(result.bpm, 128);
});

// ---- #6: an embedded title tag is authoritative — keep its year/label
// parentheticals rather than aggressively stripping them like a filename. ------

Deno.test("embedded title keeps year and label suffix", () => {
  assertEquals(
    extractTags(embedded({ artist: "Real DJ", title: "Anniversary (2019)" }), "/tmp/dummy.wav")
      .title,
    "Anniversary (2019)",
  );
  assertEquals(
    extractTags(
      embedded({ artist: "Real DJ", title: "Skyline (Sangoma Records Edit)" }),
      "/tmp/dummy2.wav",
    ).title,
    "Skyline (Sangoma Records Edit)",
  );
});

Deno.test("embedded title still strips promo and inline bpm", () => {
  // gentle still removes obvious junk: promo brackets and an inline "NNN bpm".
  const result = extractTags(
    embedded({ artist: "Real DJ", title: "Nebula 174 BPM (FREE DOWNLOAD)" }),
    "/tmp/dummy.wav",
  );
  assertEquals(result.title, "Nebula");
  assertEquals(result.bpm, 174);
});

// ---- #5: a label-looking embedded artist survives unless a genuinely
// different, non-label candidate exists in the filename. -----------------------

Deno.test("label-like embedded artist is kept without a better candidate", () => {
  const result = extractTags(
    embedded({ artist: "Cosmic Music", title: "Nebula" }),
    "/tmp/Cosmic Music - Nebula.wav",
  );
  assertEquals(result.artist, "Cosmic Music");
});

Deno.test("label-like embedded artist is replaced when the filename has a real artist", () => {
  const result = extractTags(
    embedded({ artist: "Zenon Records", title: "Track" }),
    "/tmp/Zenon Records - RealDJ - Track.wav",
  );
  assertEquals(result.artist, "RealDJ");
  assertEquals(result.label, "Zenon Records");
});
