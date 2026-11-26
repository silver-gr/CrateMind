import { describe, expect, test } from "bun:test";
import {
  EDITOR_COPY, EQ_LABELS, FILTER_LABELS, LOOP_LABELS, MIX_COPY, PRESET_LABELS, REASON_LABELS, VOLUME_LABELS,
  STRUCTURE_COPY, describeAuto, loopLabel, presetLabel, reasonLabel, skippedUnplayable, stretchChip, structureHint,
} from "../src/lib/transitions/copy";
import { tempoDeviation, tempoMatchRate } from "../src/lib/transitions/planner";
import { EQ_CURVES, FILTER_CURVES, LOOP_BEATS, PRESET_KEYS, REASON_CODES, VOLUME_CURVES } from "../src/lib/transitions/types";

// English that may stay in the UI: plan Decision 8, plus the DJ terms the app already shows untranslated
// (AGENTS.md: beatgrid; PlayerCues: Entry/Exit/Cue; DjayBeatgridCard: tempo; deck: pitch) and track/beat/grid from the copy table.
const ALLOWED_ENGLISH = [
  "bpm", "eq", "loop", "cut", "fade", "crossfade", "lp", "hp", "bar", "bars", "in", "out",
  "beat", "beatgrid", "grid", "track", "tempo", "pitch", "cue", "entry", "exit",
  // deck/decks and tracks as the rest of the app shows them; AIFF is a file format name.
  "deck", "decks", "tracks", "aiff",
  // The FX rack's effect, as its own button names it.
  "echo",
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
    expect(LOOP_BEATS.map(b => LOOP_LABELS[b])).toEqual(LOOP_BEATS.map(loopLabel));
    expect(LOOP_LABELS.none).toBe("Χωρίς loop");
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
    for (const label of Object.values(EDITOR_COPY)) {
      expect(stray(label)).toEqual([]);
      expect(label).toMatch(GREEK);
    }
    expect(MIX_COPY.unmixable).toBe("χωρίς μίξη");
    expect(MIX_COPY.editorTitle).toBe("Επεξεργασία μετάβασης");
  });

  test("the skipped-tracks toast names up to three tracks, in Greek", () => {
    const one = skippedUnplayable(["Α"]);
    expect(one).toContain("«Α»");
    expect(one).toMatch(GREEK);
    expect(stray(one)).toEqual([]);
    const many = skippedUnplayable(["Α", "Β", "Γ", "Δ", "Ε"]);
    expect(many).toContain("«Α», «Β», «Γ»");
    expect(many).not.toContain("«Δ»");
    expect(many).toContain("5");
    expect(stray(many)).toEqual([]);
  });
});

describe("«Χρονισμός από τη δομή»: the per-pair hint", () => {
  test("one part per side, from the planner's reasons", () => {
    expect(structureHint(["structure_out", "structure_in"], false)).toBe("Έξοδος: σε γραμμή φράσης · Είσοδος: το πρώτο μπάσο στην εναλλαγή");
    expect(structureHint(["structure_out"], false)).toBe("Έξοδος: σε γραμμή φράσης · Είσοδος: όπως πριν");
    expect(structureHint(["entry_cue", "structure_in", "bpm_out_of_range"], false)).toBe("Έξοδος: όπως πριν · Είσοδος: το πρώτο μπάσο στην εναλλαγή");
    expect(structureHint([], false)).toBe("Έξοδος: όπως πριν · Είσοδος: όπως πριν");
  });
  test("a draft that holds both anchors says so instead", () => {
    expect(structureHint(["structure_out", "structure_in"], true)).toBe(STRUCTURE_COPY.anchored);
    expect(STRUCTURE_COPY.anchored).toBe("Η μετάβαση έχει δικό της παράθυρο");
  });
});

describe("stretch chips", () => {
  const on = { preset: "auto", tempo_match: true } as const, off = { preset: "auto", tempo_match: false } as const;
  test("8.0 % none, 8.1 % amber, 16.0 % amber, 16.1 % rose", () => {
    expect(stretchChip(0.08, on)).toBeNull();
    expect(stretchChip(0.081, on)).toMatchObject({ tone: "amber", label: "Stretch 8 %" });
    expect(stretchChip(0.12, on)).toMatchObject({ tone: "amber", label: "Stretch 12 %" });
    expect(stretchChip(0.16, on)).toMatchObject({ tone: "amber", label: "Stretch 16 %" });
    expect(stretchChip(0.161, on)).toMatchObject({ tone: "rose", label: "Χωρίς ταίριασμα tempo" });
    expect(stretchChip(null, on)).toBeNull();
  });
  test("tempo match off: none at 12 %, rose at 20 %; «Χωρίς μετάβαση» never", () => {
    expect(stretchChip(0.12, off)).toBeNull();
    expect(stretchChip(0.2, off)?.tone).toBe("rose");
    expect(stretchChip(0.2, { preset: "none", tempo_match: true })).toBeNull();
    expect(stretchChip(0.12, { preset: "none", tempo_match: true })).toBeNull();
  });
  test("tempoDeviation folds octaves and is not capped", () => {
    expect(tempoDeviation(75, 150)).toBe(0);
    expect(tempoDeviation(140, 147)!).toBeCloseTo(0.0476, 4);
    expect(tempoDeviation(98, 160)!).toBeCloseTo(0.225, 9);
    expect(tempoDeviation(0, 120)).toBeNull();
    expect(stretchChip(tempoDeviation(75, 150), on)).toBeNull();
    expect(stretchChip(tempoDeviation(66, 150), on)).toMatchObject({ tone: "amber", label: "Stretch 12 %" });   // a folded pair
  });
  test("tempoMatchRate is null exactly when tempoDeviation is over 16 %", () => {
    for (let out = 60; out <= 200; out += 0.7) for (const inn of [75, 98, 120, 126.3, 140, 145, 160, 174]) {
      expect(tempoMatchRate(out, 1, inn) == null).toBe(tempoDeviation(out, inn)! > 0.16);
    }
  });
  test("every label and tooltip is Greek text", () => {
    for (const chip of [stretchChip(0.12, on)!, stretchChip(0.2, on)!]) {
      expect(chip.title).toMatch(/[Ͱ-Ͽ]/);
      expect(chip.title).toContain("%");
    }
  });
});
