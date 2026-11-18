import { expect, test } from "bun:test";
import { fallbackKey, ownKeyFirst } from "../src/lib/camelot";

const method = "cqt-octave-trained-v2";
const track = (confidence: number | null, m: string | null) =>
  ({ key_djay: "E minor", key_analyzed: "C major", key_analyzed_confidence: confidence, key_analyzed_method: m });

test("a confident own key goes ahead of djay's, like effective_key in the backend", () => {
  expect(fallbackKey(track(0.7, method))).toBe("C major");
  expect(fallbackKey(track(0.69, method))).toBe("E minor");
  expect(fallbackKey(track(0.99, null))).toBe("E minor");
  expect(fallbackKey(track(0.99, "something-else"))).toBe("E minor");
  expect(ownKeyFirst(track(0.9, method))).toBe(true);
});

test("each source falls back to the other, and nothing gives null", () => {
  expect(fallbackKey({ key_djay: " ", key_analyzed: "C major" })).toBe("C major");
  expect(fallbackKey({ key_djay: "E minor", key_analyzed: "", key_analyzed_confidence: 0.9, key_analyzed_method: method })).toBe("E minor");
  expect(fallbackKey({})).toBeNull();
  expect(fallbackKey(null)).toBeNull();
});
