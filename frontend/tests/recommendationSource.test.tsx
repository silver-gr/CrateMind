import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import KeyWheelSourceControl from "../src/components/KeyWheelSourceControl";
import { canonicalCamelot } from "../src/lib/keyWheelSource";
import { recommendationSourceIsCurrent, recommendationSourceKey, recommendationSourceRequest, resolveRecommendationSource, type RecommendationSource } from "../src/lib/recommendationSource";

const track = (id: number) => ({ id, title: `Track ${id}`, file_name: `${id}.mp3`, key_text: null, key_analyzed: null });
const source = (kind: RecommendationSource["source"], id: number): RecommendationSource => ({ source: kind, track: track(id) });

test("each recommendation source uses its track even without key metadata", () => {
  const tracks = { playing: track(10), selection: track(20), last: track(30) };
  for (const kind of ["playing", "selection", "last"] as const) {
    expect(canonicalCamelot(tracks[kind])).toBeNull();
    const resolved = resolveRecommendationSource(kind, tracks)!;
    expect(resolved.source).toBe(kind);
    expect(recommendationSourceRequest(resolved)).toEqual({ after_track_id: tracks[kind].id, limit: 12 });
  }
});

test("unavailable sources fall back, and resumed playback returns to its preferred source", () => {
  expect(resolveRecommendationSource("playing", { playing: null, selection: track(20), last: track(30) })?.source).toBe("last");
  expect(resolveRecommendationSource("last", { playing: null, selection: track(20), last: undefined })?.source).toBe("selection");
  expect(resolveRecommendationSource("selection", { playing: track(10), selection: null, last: undefined })?.source).toBe("playing");
  expect(resolveRecommendationSource("playing", { playing: null, selection: null, last: undefined })).toBeNull();
  expect(resolveRecommendationSource("playing", { playing: track(10), selection: track(20), last: track(30) })?.source).toBe("playing");
});

test("source identity rejects late results when the chosen track, source or availability changes", () => {
  const requested = source("playing", 10);
  expect(recommendationSourceIsCurrent(requested, source("playing", 10))).toBe(true);
  expect(recommendationSourceIsCurrent(requested, source("playing", 11))).toBe(false);
  expect(recommendationSourceIsCurrent(requested, source("selection", 10))).toBe(false);
  expect(recommendationSourceIsCurrent(requested, null)).toBe(false);
  expect(recommendationSourceKey(null)).toBeNull();
});

test("refill follows a committed tail while rows refresh, and explicit bridges retain their endpoints", () => {
  expect(recommendationSourceIsCurrent(source("last", 40), source("last", 30), 40)).toBe(true);
  expect(recommendationSourceIsCurrent(source("last", 40), source("last", 30))).toBe(false);
  expect(recommendationSourceIsCurrent(source("last", 40), source("playing", 10), 40)).toBe(false);
  expect(recommendationSourceIsCurrent(source("selection", 40), source("selection", 30), 40)).toBe(false);
  expect(recommendationSourceIsCurrent(null, source("playing", 10))).toBe(true);
  expect(recommendationSourceIsCurrent(null, null)).toBe(true);
});

test("recommendation radios use their own accessible group and enable tracks without keys", () => {
  const html = renderToString(<>
    <KeyWheelSourceControl value="last" keys={{ playing: "Track 10", selection: null, last: "Track 30" }}
      legend="Πηγή για το επόμενο προτεινόμενο track"
      unavailable={{ playing: "Δεν παίζει track", selection: "Επίλεξε track", last: "Το set είναι άδειο" }} onChange={() => {}} />
    <KeyWheelSourceControl value="selection" keys={{ playing: null, selection: "12B", last: null }}
      unavailable={{ playing: "Χωρίς key", selection: "Επίλεξε track", last: "Χωρίς key" }} onChange={() => {}} />
  </>);
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
  expect(radios).toHaveLength(6);
  expect(radios[0]).not.toContain('disabled=""');
  expect(radios[1]).toContain('disabled=""');
  expect(radios[2]).toContain('checked=""');
  expect(radios[4]).toContain('checked=""');
  expect(new Set(radios.map(radio => radio.match(/name="([^"]+)"/)?.[1])).size).toBe(2);
  expect(html).toContain("Πηγή για το επόμενο προτεινόμενο track");
  expect(html).toContain("Πηγή key για αρμονική συμβατότητα");
});
