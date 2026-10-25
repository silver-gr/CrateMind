import { describe, expect, test } from "bun:test";
import { bpmDescription, bpmSource, effectiveBpm } from "../src/lib/tempo";
import { sortTracks } from "../src/lib/trackSort";
import type { Track } from "../src/lib/types";

describe("effective BPM", () => {
  test.each([0, -150, NaN, Infinity, -Infinity, null, undefined])(
    "ignores invalid metadata %s in favor of local analysis", bpm => {
      const track = { bpm, bpm_analyzed: 176.4 };
      expect(effectiveBpm(track)).toBe(176.4);
      expect(bpmSource(track)).toBe("local");
    },
  );

  test("honors manual choice, then metadata, consensus, and local fallback", () => {
    const track = { bpm: 150, bpm_analyzed: 149, bpm_consensus: 75, bpm_consensus_sources: "manual:reccobeats" };
    expect(effectiveBpm(track)).toBe(75);
    expect(bpmSource(track)).toBe("manual:reccobeats");
    track.bpm_consensus_sources = "local+reccobeats";
    expect(effectiveBpm(track)).toBe(150);
    expect(bpmSource(track)).toBe("metadata");
    track.bpm = 0;
    expect(effectiveBpm(track)).toBe(75);
    expect(bpmSource(track)).toBe("local+reccobeats");
    track.bpm_consensus = NaN;
    expect(effectiveBpm(track)).toBe(149);
    expect(bpmSource(track)).toBe("local");
  });

  test("missing and entirely invalid readings remain unavailable", () => {
    expect(effectiveBpm()).toBeNull();
    expect(effectiveBpm(null)).toBeNull();
    expect(effectiveBpm({ bpm: Infinity, bpm_analyzed: 0, bpm_consensus: -5 })).toBeNull();
    expect(bpmSource({})).toBeNull();
  });

  test("does not guess half/double time, cap valid tempos, or mutate sources", () => {
    const track = { bpm: 45.25, bpm_analyzed: 180, bpm_consensus: 181 };
    expect(effectiveBpm(track)).toBe(45.25);
    expect(effectiveBpm({ bpm: 300 })).toBe(300);
    expect(track).toEqual({ bpm: 45.25, bpm_analyzed: 180, bpm_consensus: 181 });
  });

  test("Library ordering uses the same resolved values as all displayed tempos", () => {
    const tempos = [
      { bpm: 150, bpm_analyzed: 190 },
      { bpm_analyzed: 160.2 },
      { bpm: 0, bpm_analyzed: 160.1 },
      { bpm: 155, bpm_consensus: 170, bpm_consensus_sources: "manual:local" },
      { bpm_consensus: 149, bpm_consensus_sources: "local+essentia" },
      { bpm: Infinity },
    ];
    const tracks = tempos.map((tempo, id) => ({ id, file_name: `${id}.mp3`, absolute_path: `/${id}.mp3`, play_count: 0, missing: false, ...tempo }));
    expect(sortTracks(tracks, { key: "bpm", dir: "desc" }).map(effectiveBpm)).toEqual([170, 160.2, 160.1, 150, 149, null]);
  });

  test("provenance describes the selected source, including zero-tag fallbacks", () => {
    const track: Track = { id: 1, file_name: "a.mp3", absolute_path: "/a.mp3", play_count: 0, missing: false, bpm: 0, bpm_analyzed: 160, bpm_analyzed_confidence: 0.7 };
    expect(bpmDescription(track)).toContain("Ανάλυση ήχου");
    expect(bpmDescription(track)).toContain("70%");
    track.bpm_consensus = 180;
    track.bpm_consensus_sources = "manual:local";
    expect(bpmDescription(track)).toBe("Χειροκίνητη επιλογή BPM");
    track.bpm_consensus_sources = "local+essentia";
    expect(bpmDescription(track)).toBe("Συμφωνία αναλύσεων BPM");
  });
});
