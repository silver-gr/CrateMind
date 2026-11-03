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

  test("explicit misplaced metadata keeps 280 over analyzed half-time and yields to manual choice", () => {
    const track = { bpm: null, bpm_analyzed: 140.4, display_bpm_hint: 280,
      metadata_provenance: { bpm: { basis: "numeric_artist" } },
      bpm_consensus: 140, bpm_consensus_sources: "local+essentia" };
    expect(effectiveBpm(track)).toBe(280);
    expect(bpmSource(track)).toBe("metadata:numeric_artist");
    track.bpm_consensus_sources = "manual:local";
    expect(effectiveBpm(track)).toBe(140);
    expect(bpmSource(track)).toBe("manual:local");
    expect(track.bpm).toBeNull();
    expect(track.bpm_analyzed).toBe(140.4);
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
    expect(bpmDescription(track)).toContain("Ανάλυση BPM");
    expect(bpmDescription(track)).toContain("70%");
    track.bpm_consensus = 180;
    track.bpm_consensus_sources = "manual:local";
    expect(bpmDescription(track)).toBe("Χειροκίνητη επιλογή BPM");
    track.bpm_consensus_sources = "local+essentia";
    expect(bpmDescription(track)).toBe("Συμφωνία αναλύσεων BPM");
  });

  test("a therapy track analysed with no clear tempo says so, unless a manual or tag BPM exists", () => {
    const track: Track = { id: 2, file_name: "b.mp3", absolute_path: "/b.mp3", play_count: 0, missing: false,
      bpm_analyzed: null, bpm_analyzed_method: "librosa-onset-wide-v1@40-240", analyzed_at: "2026-11-03T10:00:00", analysis_error: null };
    expect(bpmDescription(track)).toBe("Χωρίς σταθερό ρυθμό");
    expect(bpmDescription({ ...track, analysis_error: "decode failed" })).toBeUndefined();
    expect(bpmDescription({ ...track, analyzed_at: null })).toBeUndefined();
    expect(bpmDescription({ ...track, bpm_analyzed_method: "librosa-onset-multilag-v2@133-286" })).toBeUndefined();
    expect(bpmDescription({ ...track, bpm: 64 })).toBe("BPM από tag αρχείου");
    expect(bpmDescription({ ...track, bpm_consensus: 60, bpm_consensus_sources: "manual:octave" })).toBe("Χειροκίνητη επιλογή BPM");
  });

  test("a local reading names its window in Greek, never the raw method", () => {
    const track: Track = { id: 3, file_name: "c.mp3", absolute_path: "/c.mp3", play_count: 0, missing: false,
      bpm_analyzed: 72, bpm_analyzed_method: "librosa-onset-wide-v1@40-240", bpm_analyzed_confidence: 0.5 };
    expect(bpmDescription(track)).toBe("Ανάλυση BPM (μουσικοθεραπεία 40–240) · 50% εμπιστοσύνη");
    expect(bpmDescription({ ...track, bpm_analyzed_method: "ffmpeg+onset-autocorr-v1@118-250", bpm_analyzed_confidence: null }))
      .toBe("Εναλλακτική ανάλυση BPM (μικτό 118–250)");
  });
});
