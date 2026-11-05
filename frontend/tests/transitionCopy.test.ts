import { describe, expect, test } from "bun:test";
import {
  EQ_LABELS, FILTER_LABELS, MIX_COPY, PRESET_LABELS, REASON_LABELS, VOLUME_LABELS,
  describeAuto, loopLabel, presetLabel, reasonLabel,
} from "../src/lib/transitions/copy";
import { EQ_CURVES, FILTER_CURVES, LOOP_BEATS, PRESET_KEYS, REASON_CODES, VOLUME_CURVES } from "../src/lib/transitions/types";

// English that may stay in the UI: plan Decision 8, plus the DJ terms the app already shows untranslated
// (AGENTS.md: beatgrid; PlayerCues: Entry/Exit/Cue; DjayBeatgridCard: tempo; deck: pitch) and track/beat/grid from the copy table.
const ALLOWED_ENGLISH = [
  "bpm", "eq", "loop", "cut", "fade", "crossfade", "lp", "hp", "bar", "bars", "in", "out",
  "beat", "beatgrid", "grid", "track", "tempo", "pitch", "cue", "entry", "exit",
];
const GREEK = /[Ͱ-Ͽἀ-῿]/;
const stray = (label: string) => (label.match(/[A-Za-z]+/g) ?? []).filter(word => !ALLOWED_ENGLISH.includes(word.toLowerCase()));
const keyLike = /^[a-z]+(_[a-z]+)+$/;

const expectGreek = (labels: Record<string, string>, keys: readonly string[]) => {
  expect(Object.keys(labels).sort()).toEqual([...keys].sort());
  for (const key of keys) {
    const label = labels[key];
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(stray(label)).toEqual([]);
    expect(label).not.toMatch(keyLike);
    expect(label).not.toBe(key);
  }
};

describe("transition copy", () => {
  test("every preset, curve and reason key has a Greek label", () => {
    expectGreek(PRESET_LABELS, PRESET_KEYS);
    expectGreek(VOLUME_LABELS, VOLUME_CURVES);
    expectGreek(EQ_LABELS, EQ_CURVES);
    expectGreek(FILTER_LABELS, FILTER_CURVES);
    expectGreek(REASON_LABELS, REASON_CODES);
  });

  test("preset names are Greek words, not English with a Greek accent", () => {
    for (const key of PRESET_KEYS) expect(PRESET_LABELS[key]).toMatch(GREEK);
    expect(PRESET_LABELS.slam).toBe("Κόψιμο");
    expect(PRESET_LABELS.none).toBe("Χωρίς μετάβαση");
  });

  test("loop labels", () => {
    expect(LOOP_BEATS.map(loopLabel)).toEqual(["1 beat loop", "2 beat loop", "4 beat loop", "8 beat loop", "16 beat loop"]);
    expect(loopLabel(null)).toBe("Χωρίς loop");
  });

  test("describeAuto joins the Greek reasons and drops unknown codes", () => {
    const text = describeAuto(["same_key", "bpm_close"]);
    expect(text).toContain("ίδιο κλειδί");
    expect(text).toContain("κοντινό BPM");
    expect(describeAuto(["same_key", "made_up_code"])).toBe("ίδιο κλειδί");
    expect(describeAuto([])).toBe("");
    expect(reasonLabel("made_up_code")).toBeNull();
  });

  test("the pill label names the resolved preset under Auto", () => {
    expect(presetLabel("auto", "blend")).toBe("Αυτόματο · Ανάμειξη");
    expect(presetLabel("auto", null)).toBe("Αυτόματο");
    expect(presetLabel("wave", null)).toBe("Κύμα");
  });

  test("strip, pill and editor strings are Greek-only", () => {
    for (const label of Object.values(MIX_COPY)) expect(stray(label)).toEqual([]);
    expect(MIX_COPY.unmixable).toBe("χωρίς μίξη");
    expect(MIX_COPY.editorTitle).toBe("Επεξεργασία μετάβασης");
  });
});
