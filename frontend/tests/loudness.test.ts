import { describe, expect, test } from "bun:test";
import { translateJobMessage } from "../src/lib/labels";
import { parseQueryChips } from "../src/lib/queryChips";
import { sortTracks } from "../src/lib/trackSort";
import type { Track } from "../src/lib/types";

function track(id: number, loudness_lufs?: number | null): Track {
  return { id, file_name: `${id}.mp3`, absolute_path: `/${id}.mp3`, play_count: 0, missing: false, loudness_lufs };
}

describe("track loudness (LUFS)", () => {
  const tracks = [track(1, -9.6), track(2, null), track(3, -6.2), track(4, -14)];

  test("sorts quiet to loud and back, unmeasured tracks always last", () => {
    expect(sortTracks(tracks, { key: "loudness", dir: "asc" }).map(t => t.id)).toEqual([4, 1, 3, 2]);
    expect(sortTracks(tracks, { key: "loudness", dir: "desc" }).map(t => t.id)).toEqual([3, 1, 4, 2]);
  });

  test("the analysis job message names the measurements in Greek", () => {
    expect(translateJobMessage("analyzed 0, failed 0, beatgrids 2, loudness 340"))
      .toBe("αναλύθηκαν 0, απέτυχαν 0, beatgrids 2, μέτρηση LUFS σε 340");
  });

  test("search chips show signed specs with a real minus and never the raw key", () => {
    expect(parseQueryChips("lufs:-10--8 lufs:-8+ lufs:-12- lufs:-8 -lufs:-9+ lufs:-").map(c => c.label)).toEqual([
      "−10 έως −8 LUFS", "≥ −8 LUFS", "≤ −12 LUFS", "−8 LUFS", "όχι ≥ −9 LUFS", "LUFS -",
    ]);
  });
});
