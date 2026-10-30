import { describe, expect, test } from "bun:test";
import { isKeyGroupEnd, sortTracks } from "../src/lib/trackSort";
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

describe("Track key sorting", () => {
  function keyedTrack(id: number, key_text?: string | null, key_analyzed?: string | null): Track {
    return { ...track(id), key_text, key_analyzed };
  }

  test("sorts all Camelot numbers numerically with A before B", () => {
    const tracks = Array.from({ length: 24 }, (_, i) =>
      keyedTrack(i + 1, `${Math.floor(i / 2) + 1}${i % 2 ? "B" : "A"}`),
    ).reverse();

    expect(sortTracks(tracks, { key: "key", dir: "asc" }).map(t => t.id))
      .toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(sortTracks(tracks, { key: "key", dir: "desc" }).map(t => t.id))
      .toEqual(Array.from({ length: 24 }, (_, i) => 24 - i));
  });

  test("normalizes musical, Open Key, and analyzed keys using display precedence", () => {
    const tracks = [
      keyedTrack(1, null, "~Bm"), // 10A
      keyedTrack(2, " ", "F♯ minor"), // 11A
      keyedTrack(3, "12B", "1A"), // tag wins
      keyedTrack(4, "  ~A♭ minor "), // 1A
      keyedTrack(5, "7m"), // 2A
    ];

    expect(sortTracks(tracks, { key: "key", dir: "asc" }).map(t => t.id))
      .toEqual([4, 5, 1, 2, 3]);
  });

  test("keeps missing and unrecognized keys last in either direction", () => {
    const tracks = [
      keyedTrack(1), keyedTrack(2, "unknown", "1A"), keyedTrack(3, "8B"),
      keyedTrack(4, "", " "), keyedTrack(5, "13A"), keyedTrack(6, "2A"),
    ];

    expect(sortTracks(tracks, { key: "key", dir: "asc" }).map(t => t.id))
      .toEqual([6, 3, 1, 2, 4, 5]);
    expect(sortTracks(tracks, { key: "key", dir: "desc" }).map(t => t.id))
      .toEqual([3, 6, 1, 2, 4, 5]);
  });

  test("preserves equivalent key order without changing fetched tracks", () => {
    const tracks = [keyedTrack(1, "Am"), keyedTrack(2, "8a"), keyedTrack(3, null, "~1m"), keyedTrack(4, "2A")];
    const before = structuredClone(tracks);

    expect(sortTracks(tracks, { key: "key", dir: "asc" }).map(t => t.id)).toEqual([4, 1, 2, 3]);
    expect(sortTracks(tracks, { key: "key", dir: "desc" }).map(t => t.id)).toEqual([1, 2, 3, 4]);
    expect(tracks).toEqual(before);
  });

  test("orders effective BPM low to high inside canonical key groups in both key directions", () => {
    const tracks = [
      { ...keyedTrack(1, "8A"), bpm: 150 },
      { ...keyedTrack(2, "10B"), bpm: 170 },
      { ...keyedTrack(3, "Am"), bpm: 0, bpm_analyzed: 140 },
      { ...keyedTrack(4, "D"), bpm_consensus: 160 },
      keyedTrack(5, "1m"), // missing BPM stays last within 8A
      { ...keyedTrack(6, "8a"), bpm: 130, bpm_consensus: 145, bpm_consensus_sources: "manual:test" },
      { ...keyedTrack(7, null, "~Am"), bpm: 145 }, // tied tempo stays stable
      { ...keyedTrack(8, "10B"), bpm: -1 },
    ];
    const before = structuredClone(tracks);

    expect(sortTracks(tracks, { key: "key", dir: "asc" }).map(t => t.id))
      .toEqual([3, 6, 7, 1, 5, 4, 2, 8]);
    expect(sortTracks(tracks, { key: "key", dir: "desc" }).map(t => t.id))
      .toEqual([4, 2, 8, 3, 6, 7, 1, 5]);
    expect(tracks).toEqual(before);
  });

  test("keeps unavailable keys in one final BPM-ordered group", () => {
    const tracks = [
      { ...keyedTrack(1, "unknown"), bpm: 160 },
      keyedTrack(2),
      { ...keyedTrack(3, "8A"), bpm: 180 },
      { ...keyedTrack(4, "13A"), bpm_analyzed: 140 },
    ];
    for (const dir of ["asc", "desc"] as const) {
      const sorted = sortTracks(tracks, { key: "key", dir });
      expect(sorted.map(t => t.id)).toEqual([3, 4, 1, 2]);
      expect(sorted.map((t, i) => isKeyGroupEnd(t, sorted[i + 1], "key")))
        .toEqual([true, false, false, false]);
    }
  });

  test("marks only canonical key changes using full-array neighbors in either direction", () => {
    const tracks = [keyedTrack(1, "Am"), keyedTrack(2, "8a"), keyedTrack(3, null, "~1m"), keyedTrack(4, "2A")];
    const ascending = sortTracks(tracks, { key: "key", dir: "asc" });
    const descending = sortTracks(tracks, { key: "key", dir: "desc" });

    expect(ascending.map((t, i) => isKeyGroupEnd(t, ascending[i + 1], "key")))
      .toEqual([true, false, false, false]);
    expect(descending.map((t, i) => isKeyGroupEnd(t, descending[i + 1], "key")))
      .toEqual([false, false, true, false]);
    // A final visible row can be a group end when the next group is offscreen.
    expect(isKeyGroupEnd(descending[2], descending[3], "key")).toBe(true);
    expect(isKeyGroupEnd(descending[3], undefined, "key")).toBe(false);
  });

  test("BPM sorting stays purely numeric and never creates key dividers", () => {
    const tracks = [
      { ...keyedTrack(1, "2A"), bpm: 150 },
      { ...keyedTrack(2, "8A"), bpm: 140 },
      { ...keyedTrack(3, "2A"), bpm: 140 },
    ];
    const ascending = sortTracks(tracks, { key: "bpm", dir: "asc" });
    const descending = sortTracks(tracks, { key: "bpm", dir: "desc" });

    expect(ascending.map(t => t.id)).toEqual([2, 3, 1]);
    expect(descending.map(t => t.id)).toEqual([1, 2, 3]);
    for (const sortKey of ["bpm", "title", undefined] as const) {
      expect(ascending.some((t, i) => isKeyGroupEnd(t, ascending[i + 1], sortKey))).toBe(false);
    }
  });
});

describe("Library melody and weirdness sorting", () => {
  test.each(["melody", "weirdness"] as const)("sorts %s numerically with missing values last", key => {
    const tracks = [
      { ...track(1), [key]: 8 }, { ...track(2), [key]: null },
      { ...track(3), [key]: 0 }, { ...track(4), [key]: 5 }, { ...track(5) },
    ];
    const before = structuredClone(tracks);
    expect(sortTracks(tracks, { key, dir: "asc" }).map(t => t.id)).toEqual([3, 4, 1, 2, 5]);
    expect(sortTracks(tracks, { key, dir: "desc" }).map(t => t.id)).toEqual([1, 4, 3, 2, 5]);
    expect(tracks).toEqual(before);
  });
});
