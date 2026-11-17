import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BEAT_DIVISIONS, DEFAULT_FAVOURITES, DEFAULT_PRESET_ID, FRACTAL_TABLES, FX_FAMILIES, FX_PRESETS, SCRAMBLE_TABLES,
  SLICE_GATE_PATTERNS, beatsIndex, beatsLabel, beatsNote, beatsValue, curveValue, keyHz, presetById, presetsOfFamily,
} from "../src/lib/fxRack/presets";
import {
  CaptureRing, type Curve, type FilterParams, type FxPreset, type GateParams, type PhaserParams, type ShortDelayParams,
} from "../src/lib/fxRack/types";

const ALL_ONE = { a: 1, m: 1, rho: 1, t: 1e9 };
const ALL_ZERO = { a: 0, m: 0, rho: 0, t: 0 };
const ends = (c: Curve): number[] => (typeof c === "number" ? [c] : [c.from, c.to]);
const within = (c: Curve | undefined, lo: number, hi: number) => c === undefined || ends(c).every(v => v >= lo && v <= hi);
const blocks = (p: FxPreset) => JSON.stringify({ ins: p.ins, delay: p.delay, reverb: p.reverb, gens: p.gens, exit: p.exit, release: p.release });
const isDivision = (v: number) => BEAT_DIVISIONS.some(d => Math.abs(d.beats - v) < 1e-9);

function filtersOf(p: FxPreset): FilterParams[] {
  const list = [...(p.ins?.filters ?? []), ...(p.delay?.loop ?? []), ...(p.gens ?? []).flatMap(g => g.filters ?? [])];
  return list.filter((f): f is FilterParams => f.type !== "phaser");
}
const phasersOf = (p: FxPreset) => (p.ins?.filters ?? []).filter((f): f is PhaserParams => f.type === "phaser");
const shortDelaysOf = (p: FxPreset): ShortDelayParams[] =>
  [p.ins?.shortDelay, ...(p.gens ?? []).map(g => g.flanger)].filter((d): d is ShortDelayParams => d !== undefined);
const gatesOf = (p: FxPreset): GateParams[] =>
  [p.ins?.gate, p.reverb?.gate, ...(p.gens ?? []).map(g => g.gate)].filter((g): g is GateParams => g !== undefined);

describe("preset table", () => {
  test("66 rows in table order with unique kebab-case ids and unique names", () => {
    expect(FX_PRESETS.map(p => p.n)).toEqual(Array.from({ length: 66 }, (_, i) => i + 1));
    expect(new Set(FX_PRESETS.map(p => p.id)).size).toBe(66);
    expect(new Set(FX_PRESETS.map(p => p.name)).size).toBe(66);
    for (const p of FX_PRESETS) expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("own-named presets have a Greek line, every preset a line and a known family, every family presets", () => {
    const families = FX_FAMILIES.map(f => f.id);
    const ownNamed = (n: number) => n === 13 || (n >= 21 && n <= 35) || (n >= 45 && n <= 63);
    for (const p of FX_PRESETS) {
      expect(p.line.length).toBeGreaterThan(0);
      if (ownNamed(p.n)) expect(p.line).toMatch(/[Ͱ-Ͽ]/);
      expect(families).toContain(p.family);
    }
    for (const f of FX_FAMILIES) {
      expect(presetsOfFamily(f.id).length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  test("favourites and the first-run preset resolve", () => {
    expect(DEFAULT_FAVOURITES.map(id => presetById(id)?.n)).toEqual([10, 55, 1, 6, 3, 25, 54, 50, 64, 14]);
    expect(presetById(DEFAULT_PRESET_ID)?.n).toBe(10);
    expect(presetById("nope")).toBeUndefined();
  });

  test("BEATS choices are known divisions with an in-range default", () => {
    for (const p of FX_PRESETS) {
      if (!p.beats) continue;
      expect(p.beats.def).toBeGreaterThanOrEqual(0);
      expect(p.beats.def).toBeLessThan(p.beats.options.length);
      for (const v of p.beats.options) {
        if (typeof v === "number") expect(isDivision(v)).toBe(true);
        else if (v === "phrase") expect(p.macro).toBe(true);
        else if ("pattern" in v) expect(v.pattern).toBeLessThan(SLICE_GATE_PATTERNS.length);
        else if ("hits" in v) expect(p.gens?.some(g => g.hits === "beats")).toBe(true);
        else {
          expect(p.delay?.mode).toBe("dual");
          expect(isDivision(v[0]) && isDivision(v[1])).toBe(true);
        }
      }
    }
  });

  test("a \"beats\" reference only appears where the choices are beat values", () => {
    for (const p of FX_PRESETS) {
      const json = blocks(p);
      if (!json.includes(':"beats"')) continue;
      expect(p.beats).not.toBeNull();
      const hits = json.includes('"hits":"beats"');
      for (const v of p.beats!.options) {
        if (hits) expect(typeof v === "object" && "hits" in v).toBe(true);
        else expect(typeof v === "number" || Array.isArray(v)).toBe(true);
      }
    }
  });

  test("∅ presets have no BEATS and use no beat units", () => {
    const free = FX_PRESETS.filter(p => p.noBpm);
    expect(free.map(p => p.n)).toEqual([5, 18, 21, 36, 37, 38, 40, 65]);
    for (const p of free) {
      expect(p.beats).toBeNull();
      expect(blocks(p)).not.toMatch(/Beats"|"beats"|"by":"(t|rho)"/);
    }
  });

  test("flags match the blocks: K uses a key, M uses the macro, exits are 14–17", () => {
    for (const p of FX_PRESETS) {
      const json = blocks(p);
      expect(json.includes('"key":{')).toBe(p.key);
      expect(json.includes('"by":"m"')).toBe(p.macro);
      expect(p.exit !== undefined).toBe(p.n >= 14 && p.n <= 17);
    }
    expect(FX_PRESETS.filter(p => p.star === 2).map(p => p.n)).toEqual([10, 55]);
  });

  test("curves are finite and exponential curves stay positive", () => {
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (typeof v === "number") { expect(Number.isFinite(v)).toBe(true); return; }
      if (typeof v !== "object" || v === null) return;
      const o = v as Record<string, unknown>;
      if (o.c === "E") expect((o.from as number) > 0 && (o.to as number) > 0).toBe(true);
      if (o.by === "t") expect(o.overBeats).toBeGreaterThan(0);
      Object.values(o).forEach(visit);
    };
    FX_PRESETS.forEach(visit);
  });

  test("block parameters stay in their ranges", () => {
    for (const p of FX_PRESETS) {
      for (const f of filtersOf(p)) {
        expect(within(f.hz, 20, 20000)).toBe(true);
        expect(within(f.q, 0.5, 8)).toBe(true);
        expect(within(f.gainDb, -24, 12)).toBe(true);
        if (f.lfo) expect(f.lfo.lo).toBeGreaterThanOrEqual(20);
        if (f.key) expect(f.key.hi).toBe(f.key.lo * 2);
      }
      for (const ph of phasersOf(p)) {
        expect(ph.stages >= 6 && ph.stages <= 8 && ph.lo < ph.hi).toBe(true);
        expect(within(ph.fb, 0, 0.95) && within(ph.mix, 0, 1)).toBe(true);
      }
      for (const d of shortDelaysOf(p)) {
        expect(within(d.ms, 0.3, 8) && within(d.fb, 0, 0.95) && within(d.mix, 0, 1)).toBe(true);
        if (d.lfo) expect(d.lfo.lo >= 0.3 && d.lfo.lo <= 8).toBe(true);
      }
      for (const g of gatesOf(p)) {
        expect(within(g.depth, 0, 1)).toBe(true);
        if (g.duty !== undefined) expect(g.duty > 0 && g.duty < 1).toBe(true);
        if (g.edgeMs !== undefined) expect(g.edgeMs >= 1 && g.edgeMs <= 3).toBe(true);
      }
      const c = p.ins?.crusher;
      if (c) expect(within(c.bits, 3, 16) && within(c.rateHz, 1500, 48000)).toBe(true);
      const d = p.delay;
      if (d) {
        expect(curveValue(d.fb, ALL_ONE)).toBeLessThan(1);
        expect(within(d.fb, 0, 0.95) && within(d.send, 0, 1) && within(d.drive, 1, 3)).toBe(true);
        if (d.mode === "comb") expect(d.combHz !== undefined && d.key !== undefined).toBe(true);
        else expect(d.timeBeats).toBeDefined();
        if (typeof d.timeBeats === "number") expect(isDivision(d.timeBeats)).toBe(true);
        expect((d.cross ?? 0) <= 0.3 && (d.pan ?? [0, 0]).every(x => Math.abs(x) <= 1)).toBe(true);
      }
      const r = p.reverb;
      if (r) {
        expect(within(r.send, 0, 1) && within(r.damp, 0, 1) && within(r.shimmer, 0, 1)).toBe(true);
        if (r.t60Beats !== "beats") expect(within(r.t60Beats, 1, 32)).toBe(true);
      }
      for (const g of p.gens ?? []) {
        expect(within(g.level, 0, 1.4)).toBe(true);
        if (g.reverb) expect(g.reverb.wet <= 1 && g.reverb.t60Beats > 0).toBe(true);
      }
      const s = p.ins?.slicer;
      if (s?.prog === "roll" && s.schedule) {
        expect(s.schedule.sizes.length).toBe(s.schedule.at.length);
        expect(s.schedule.at[0]).toBe(0);
        expect(s.schedule.sizes.every(isDivision)).toBe(true);
      }
      expect(within(p.ins?.mix, 0, 1)).toBe(true);
    }
  });

  test("defaults are in range at both ends of the amount", () => {
    for (const p of FX_PRESETS) {
      expect(beatsIndex(p, undefined)).toBe(p.beats?.def ?? 0);
      for (const v of [ALL_ZERO, ALL_ONE]) {
        if (p.delay) expect(curveValue(p.delay.fb, v)).toBeLessThan(1);
        for (const f of filtersOf(p)) expect(curveValue(f.hz, v)).toBeGreaterThanOrEqual(20);
      }
    }
  });

  test("pattern, permutation and fractal tables are well formed", () => {
    expect(SLICE_GATE_PATTERNS).toHaveLength(4);
    for (const pattern of SLICE_GATE_PATTERNS) expect(pattern).toMatch(/^[x.]{16}$/);
    for (const [size, tables] of Object.entries(SCRAMBLE_TABLES)) {
      for (const t of tables) expect([...t].sort((a, b) => a - b)).toEqual(Array.from({ length: Number(size) }, (_, i) => i));
    }
    expect(FRACTAL_TABLES).toHaveLength(4);
    for (const t of FRACTAL_TABLES) {
      expect(t).toHaveLength(12);
      expect(new Set(t.map(([step]) => step)).size).toBe(12);
      for (const [step] of t) expect(step >= 0 && step < 16).toBe(true);
    }
  });

  test("no djay reference name ships in presets.ts", () => {
    const source = readFileSync(new URL("../src/lib/fxRack/presets.ts", import.meta.url), "utf8");
    const refs = ["Arctic Reverb", "Noisifyer", "Clapifyer", "Blur", "Riser", "Rocket", "Hydrant", "Alarm Riser", "Handsup",
      "Jet Stream", "Landing", "Stutter", "Cooldown", "Distance", "Underwater", "Time Travel", "Space Hop", "Trippple Trap",
      "Snare Gun", "Bumble Bee", "Looper", "Complexer", "Uhnk Uhnk", "Bass Gun", "Wake Up", "Freestyle", "Shuffle", "UFO",
      "Cold Reverb", "Beatverb", "Gate Panner", "Gate Masher", "Sweep Delay"];
    // Case-sensitive: the Greek lines may use ordinary words such as "stutter".
    for (const ref of refs) expect(source).not.toMatch(new RegExp(`\\b${ref}\\b`));
    for (const p of FX_PRESETS) expect(refs).not.toContain(p.name);
    // "Chromatic" is djay's name for 55 and part of ours, so only the bare name is checked.
    expect(source).not.toContain('"Chromatic"');
    expect(source).not.toMatch(/\(\s*[A-Z][a-z]+( [A-Z][a-z]+)?\s*\)/);
  });
});

describe("BEATS labels", () => {
  test("beats first with the note value second", () => {
    expect([beatsLabel(3 / 4), beatsNote(3 / 4)]).toEqual(["¾", "3/16"]);
    expect([beatsLabel(1 / 3), beatsNote(1 / 3)]).toEqual(["⅓", "1/8T"]);
    expect([beatsLabel(1 / 4), beatsNote(1 / 4)]).toEqual(["¼", "1/16"]);
    expect([beatsLabel(4), beatsNote(4)]).toEqual(["4", "1 μέτρο"]);
    expect([beatsLabel([3 / 4, 1]), beatsNote([3 / 4, 1])]).toEqual(["¾·1", "3:4"]);
    expect([beatsLabel([3 / 4, 1.25]), beatsNote([3 / 4, 1.25])]).toEqual(["¾·1¼", "3:5"]);
    expect([beatsLabel("phrase"), beatsNote("phrase")]).toEqual(["Φ", "ως τη φράση"]);
    expect([beatsLabel({ pattern: 1 }), beatsNote({ pattern: 1 })]).toEqual(["Μ2", "Μοτίβο 2"]);
    expect(beatsLabel({ hits: "2&4" })).toBe("2&4");
  });

  test("every choice of every preset has a label and a note", () => {
    for (const p of FX_PRESETS) for (const v of p.beats?.options ?? []) {
      expect(beatsLabel(v).length).toBeGreaterThan(0);
      expect(beatsNote(v).length).toBeGreaterThan(0);
    }
  });

  test("an index out of range falls back to the default", () => {
    const echo = presetById("echo")!;
    expect(beatsValue(echo, 99)).toBe(3 / 4);
    expect(beatsValue(echo, 0)).toBe(1 / 4);
    expect(beatsValue(echo, 1.5)).toBe(3 / 4);
    expect(beatsValue(presetById("bit-crusher")!, 2)).toBeNull();
  });
});

describe("curves and key", () => {
  test("linear, exponential, power and drivers", () => {
    const v = { a: 0.5, m: 0.25, rho: 0.75, t: 2 };
    expect(curveValue(0.3, v)).toBe(0.3);
    expect(curveValue({ c: "L", from: 0.25, to: 0.75 }, v)).toBeCloseTo(0.5);
    expect(curveValue({ c: "E", from: 100, to: 10000 }, v)).toBeCloseTo(1000);
    expect(curveValue({ c: "L", from: 0, to: 1, pow: 1.5 }, v)).toBeCloseTo(0.5 ** 1.5);
    expect(curveValue({ c: "L", from: 0, to: 12, by: "m" }, v)).toBeCloseTo(3);
    expect(curveValue({ c: "L", from: -1, to: -3, by: "rho" }, v)).toBeCloseTo(-2.5);
    expect(curveValue({ c: "E", from: 150, to: 600, by: "t", overBeats: 8 }, v)).toBeCloseTo(150 * 4 ** 0.25);
    expect(curveValue({ c: "L", from: 0, to: 1 }, { ...v, a: 3 })).toBe(1);
    expect(curveValue({ c: "L", from: 0, to: 1 }, { ...v, a: -1 })).toBe(0);
  });

  test("the root folds into its window, with a fixed value when the key is unknown", () => {
    expect(keyHz(9, { lo: 700, hi: 1400 }, 880)).toBeCloseTo(880);
    expect(keyHz(0, { lo: 55, hi: 110 }, 110)).toBeCloseTo(65.406, 2);
    expect(keyHz(0, { lo: 55, hi: 110, mul: 4 }, 250)).toBeCloseTo(261.63, 1);
    expect(keyHz(null, { lo: 55, hi: 110 }, 110)).toBe(110);
    for (let pc = 0; pc < 12; pc++) {
      const f = keyHz(pc, { lo: 700, hi: 1400 }, 880);
      expect(f >= 700 && f < 1400).toBe(true);
    }
  });
});

describe("CaptureRing", () => {
  const frames = (...v: number[]) => Float32Array.from(v);

  test("stores x/fader clamped to ±4 and reads by index since reset", () => {
    const ring = new CaptureRing(10, 0.5);
    expect(ring.size).toBe(5);
    ring.write(frames(0.1, 0.5, -3), frames(-0.1, 2, 3), 2, 3);
    expect(ring.written).toBe(3);
    expect([ring.at(0, 0), ring.at(0, 1), ring.at(0, 2)].map(v => Math.round(v * 1e4) / 1e4)).toEqual([0.2, 1, -4]);
    expect([ring.at(1, 1), ring.at(1, 2)]).toEqual([4, 4]);
    expect(ring.at(0, 3)).toBe(0);
    expect(ring.at(0, -1)).toBe(0);
  });

  test("a closed fader captures silence", () => {
    const ring = new CaptureRing(10, 0.5);
    ring.write(frames(1, 1), frames(1, 1), 0, 2);
    expect([ring.at(0, 0), ring.at(1, 1)]).toEqual([0, 0]);
  });

  test("wraps, forgets overwritten frames, and reset hides everything before it", () => {
    const ring = new CaptureRing(10, 0.4);
    const x = frames(1, 2, 3, 4, 5, 6);
    ring.write(x, x, 0.1, 6);
    expect(ring.has(1)).toBe(false);
    expect(ring.at(0, 1)).toBe(0);
    expect([2, 3, 4, 5].map(i => Math.round(ring.at(0, i) * 10))).toEqual([3, 4, 5, 6]);
    ring.reset();
    expect(ring.written).toBe(0);
    expect(ring.at(0, 0)).toBe(0);
    ring.write(frames(0.7), frames(0.7), 1, 1);
    expect(ring.at(0, 0)).toBeCloseTo(0.7);
    expect(ring.has(1)).toBe(false);
  });
});
