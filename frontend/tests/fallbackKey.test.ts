import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fallbackKey, ownKeyFirst, uncertainKey } from "../src/lib/camelot";

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

test("only an own key below the limit (or from an uncalibrated method), with no tag or djay key, is uncertain", () => {
  const own = (confidence: number | null, m: string | null) =>
    ({ key_analyzed: "C major", key_analyzed_confidence: confidence, key_analyzed_method: m });
  expect(uncertainKey(own(0.7, method))).toBe(false);
  expect(uncertainKey(own(0.69, method))).toBe(true);
  expect(uncertainKey(own(0.99, null))).toBe(true);
  expect(uncertainKey(own(0.99, "something-else"))).toBe(true);
  expect(uncertainKey({ ...own(0.3, method), key_text: "Am" })).toBe(false);
  expect(uncertainKey({ ...own(0.3, method), key_djay: "E minor" })).toBe(false);
  expect(uncertainKey({ ...own(0.3, method), key_djay: " " })).toBe(true);
  expect(uncertainKey({ key_djay: "E minor" })).toBe(false);
  expect(uncertainKey({})).toBe(false);
  expect(uncertainKey(null)).toBe(false);
});

test("the confidence limit and calibrated methods match backend/app/services/musical_key.py", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const front = read("../src/lib/camelot.ts");
  const back = read("../../backend/app/services/musical_key.py");
  const limit = back.match(/^OWN_KEY_MIN_CONFIDENCE = ([\d.]+)/m)?.[1];
  expect(limit).toBeDefined();
  expect(front.match(/OWN_KEY_MIN_CONFIDENCE = ([\d.]+)/)?.[1]).toBe(limit);
  const methods = (text: string | undefined) => [...(text ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
  expect(methods(front.match(/CALIBRATED_KEY_METHODS = new Set\(\[([^\]]*)\]/)?.[1]))
    .toEqual(methods(back.match(/^CALIBRATED_KEY_METHODS = frozenset\(\{([^}]*)\}/m)?.[1]));
  expect(methods(front.match(/CALIBRATED_KEY_METHODS = new Set\(\[([^\]]*)\]/)?.[1])).not.toEqual([]);
});
