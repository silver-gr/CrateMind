import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import KeyWheelSourceControl from "../src/components/KeyWheelSourceControl";
import { canonicalCamelot, resolveKeyWheelSource, type KeyWheelSource } from "../src/lib/keyWheelSource";

test("wheel sources normalize estimated and musical keys, preferring recognized metadata", () => {
  expect(canonicalCamelot({ key_text: "~A minor", key_analyzed: "12B" })).toBe("8A");
  expect(canonicalCamelot({ key_text: "unknown", key_analyzed: "~12B" })).toBe("12B");
  expect(canonicalCamelot({ key_text: " ", key_analyzed: "E major" })).toBe("12B");
  expect(canonicalCamelot({ key_text: "C dorian", key_analyzed: "unknown" })).toBeNull();
  expect(canonicalCamelot(null)).toBeNull();
});

test("wheel falls back immediately when a source is paused, removed, or loses its key", () => {
  expect(resolveKeyWheelSource("last", { last: "8A", selection: "12B", playing: "1A" })).toBe("last");
  expect(resolveKeyWheelSource("playing", { last: "8A", selection: "12B", playing: null })).toBe("last");
  expect(resolveKeyWheelSource("selection", { last: null, selection: null, playing: "1A" })).toBe("playing");
  expect(resolveKeyWheelSource("last", { last: null, selection: "12B", playing: "1A" })).toBe("selection");
  expect(resolveKeyWheelSource("playing", { last: null, selection: null, playing: null })).toBeNull();
  // The preferred source remains available to follow resumed playback.
  expect(resolveKeyWheelSource("playing", { last: "8A", selection: null, playing: "1A" })).toBe("playing");
});

test("source choices are native grouped radios with unavailable choices disabled", () => {
  const keys: Record<KeyWheelSource, string | null> = { playing: null, selection: "12B", last: "8A" };
  const html = renderToString(<KeyWheelSourceControl value="last" keys={keys}
    unavailable={{ playing: "Δεν παίζει track", selection: "Επίλεξε track", last: "Το set είναι άδειο" }}
    onChange={() => {}} />);
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
  expect(radios).toHaveLength(3);
  expect(radios[0]).toContain('disabled=""');
  expect(radios[0]).toContain("Δεν παίζει track");
  expect(radios[1]).not.toContain('disabled=""');
  expect(radios[2]).toContain('checked=""');
  expect(new Set(radios.map(radio => radio.match(/name="([^"]+)"/)?.[1])).size).toBe(1);
  expect(html).toContain("Πηγή key για αρμονική συμβατότητα");
});
