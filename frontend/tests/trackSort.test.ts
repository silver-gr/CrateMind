import { describe, expect, test } from "bun:test";
import { sortTracks } from "../src/lib/trackSort";
import type { Track } from "../src/lib/types";

function track(id: number, bpm?: number | null, bpm_analyzed?: number | null): Track {
  return { id, file_name: `${id}.mp3`, absolute_path: `/${id}.mp3`, play_count: 0, missing: false, bpm, bpm_analyzed };
}

describe("Library BPM sorting", () => {
  const tracks = [track(1, 150), track(2, null, 190), track(3, 0, 160), track(4), track(5, -1), track(6, 70)];

  test("sorts tag and analyzed tempos together, including zero-tag fallbacks", () => {
    expect(sortTracks(tracks, { key: "bpm", dir: "desc" }).map(t => t.id)).toEqual([2, 3, 1, 6, 4, 5]);
  });

  test("keeps unavailable tempos last in ascending order too", () => {
    expect(sortTracks(tracks, { key: "bpm", dir: "asc" }).map(t => t.id)).toEqual([6, 1, 3, 2, 4, 5]);
  });

  test("does not mutate fetched tracks or the original array", () => {
    const before = structuredClone(tracks);
    sortTracks(tracks, { key: "bpm", dir: "desc" });
    expect(tracks).toEqual(before);
  });
});
