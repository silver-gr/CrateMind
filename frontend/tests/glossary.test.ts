import { describe, expect, test } from "bun:test";
import { filterGlossary, GLOSSARY_ALL as GLOSSARY, glossaryFor, glossaryHref } from "../src/lib/glossary";
import { eqDb, LOW_KILL_START, PITCH_RANGES, trimDb } from "../src/lib/mixer";
import { MAX_TEMPO_DEVIATION, STRETCH_WARN } from "../src/lib/transitions/planner";
import { NEXT_PART_SOON_BARS } from "../src/lib/deckFacts";
import { PEAK_HOLD_MS } from "../src/lib/masterMeter";
import { readFileSync } from "node:fs";

const byId = (id: string) => GLOSSARY.find(t => t.id === id)!;
const text = (id: string) => { const t = byId(id); return `${t.what} ${t.hear} ${t.act}`.replace(/−/g, "-"); };

describe("glossary", () => {
  test("every term has a name and all three parts", () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(20);
    for (const t of GLOSSARY) {
      expect(t.term.trim()).not.toBe("");
      for (const part of [t.what, t.hear, t.act]) expect(part.trim().length).toBeGreaterThan(20);
    }
  });

  test("anchors are unique, URL-safe, and every cross-reference exists, with and without the Maximizer", () => {
    for (const terms of [glossaryFor(true), glossaryFor(false)]) {
      const ids = terms.map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const t of terms) for (const id of t.see ?? []) {
        expect(ids).toContain(id);
        expect(id).not.toBe(t.id);
      }
    }
    expect(glossaryHref("lufs")).toBe("/glossary#lufs");
  });

  test("a build without the Maximizer never mentions it", () => {
    const terms = glossaryFor(false);
    expect(terms.map(t => t.id)).not.toContain("maximizer");
    for (const t of terms) expect(`${t.what} ${t.hear} ${t.act}`).not.toContain("«MAX»");
    expect(terms.find(t => t.id === "safety-limiter")!.act).toEndWith("ή άνοιξε το Auto Gain.");
    expect(glossaryFor(true).find(t => t.id === "safety-limiter")!.act).toContain("«MAX»");
  });

  test("the requested terms are all there", () => {
    for (const id of ["db", "peak", "clipping", "headroom", "lufs", "gain-trim", "auto-gain", "limiter", "safety-limiter", "maximizer",
      "eq", "filter", "crossfader", "bpm", "beatgrid", "phrase", "key", "sync", "quantize", "loop", "hot-cue", "stretch", "echo-out", "fingerprint"]) {
      expect(byId(id)).toBeDefined();
    }
  });

  test("numbers match the code", async () => {
    expect(text("gain-trim")).toContain(`-${trimDb(1)} έως +${trimDb(1)} dB`);
    expect(text("eq")).toContain(`${eqDb(-1)} έως +${eqDb(1)} dB`);
    expect(text("eq")).toContain(`${Math.round((1 + LOW_KILL_START) * 100)} %`);
    expect(text("sync")).toContain(PITCH_RANGES.map(r => r * 100).join(" → "));
    expect(text("stretch")).toContain(`${STRETCH_WARN * 100} %`);
    expect(text("stretch")).toContain(`${MAX_TEMPO_DEVIATION * 100} %`);
    // Auto Gain (services/playback_loudness.py) and the limiters' ceiling (lib/audio/peak-limiter-core.js), read from the source.
    const loudness = await Bun.file(`${import.meta.dir}/../../backend/app/services/playback_loudness.py`).text();
    const target = /^TARGET_LUFS = (-?\d+)$/m.exec(loudness)![1];
    const truePeak = /^TRUE_PEAK_CEILING = (-?\d+)$/m.exec(loudness)![1];
    const [, low, high] = /gain = max\((-?\d+)(?:\.0)?, min\((\d+)(?:\.0)?, gain\)\)/.exec(loudness)!;
    const limiter = await Bun.file(`${import.meta.dir}/../src/lib/audio/peak-limiter-core.js`).text();
    const ceiling = /this\.ceiling = Math\.pow\(10, (-?\d+) \/ 20\)/.exec(limiter)![1];
    expect(text("auto-gain")).toContain(`${target} LUFS`);
    expect(text("auto-gain")).toContain(`${truePeak} dB`);
    expect(text("auto-gain")).toContain(`${low} έως +${high} dB`);
    expect(text("safety-limiter")).toContain(`${ceiling} dB`);
    // The meter's peak hold (lib/masterMeter.ts) and the facts row's amber count (lib/deckFacts.ts).
    expect(text("peak")).toContain(`${PEAK_HOLD_MS / 1000} δευτερόλεπτο`);
    expect(text("phrase")).toContain(`Από τα ${NEXT_PART_SOON_BARS} bars και κάτω`);
  });

  test("«εκτός master» names the way out the REC refusal gives", () => {
    // Read from the source: importing lib/recorder.ts here would load the audio graph into every test file's process.
    const source = readFileSync(new URL("../src/lib/recorder.ts", import.meta.url), "utf8");
    const OUTSIDE_MASTER_REFUSAL = source.match(/OUTSIDE_MASTER_REFUSAL = "([^"]+)"/)?.[1] ?? "";
    expect(OUTSIDE_MASTER_REFUSAL).toContain("εκτός master");
    for (const way of ["δεύτερο deck", "Auto Gain", "φόρτωσε ξανά"]) {
      expect(OUTSIDE_MASTER_REFUSAL).toContain(way);
      expect(text("outside-master")).toContain(way);
    }
  });

  test("search ignores case and accents and needs every word", () => {
    expect(filterGlossary(GLOSSARY, "")).toHaveLength(GLOSSARY.length);
    expect(filterGlossary(GLOSSARY, "lufs").map(t => t.id)).toContain("lufs");
    expect(filterGlossary(GLOSSARY, "ΤΟΝΙΚΟΤΗΤΑ").map(t => t.id)).toContain("key");
    expect(filterGlossary(GLOSSARY, "camelot 8a").map(t => t.id)).toEqual(["key"]);
    expect(filterGlossary(GLOSSARY, "zzzz")).toEqual([]);
  });
});
