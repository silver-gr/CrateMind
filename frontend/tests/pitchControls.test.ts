import { beforeEach, describe, expect, test } from "bun:test";
import {
  NEUTRAL_FX, PITCH_RANGES, cycleRange, deckGain, deckRate, faderRate, getMixer, pickupCrossed, planRate, resetMixer,
  setDeckPitch, setDeckPitchFromController, setDeckRangePitch, setDeckTrim, setMasterGain, setMidiConnected, trimDb, type DeckFx, type MixerState,
} from "../src/lib/mixer";
import { planSync, referenceTempo, registerSyncSource, syncSourceOf, type SyncSource } from "../src/lib/deckSync";

const fx = (range: number, pitch: number): DeckFx => ({ ...NEUTRAL_FX, range, pitch });
const mix = (master: number, volume = 1): MixerState => ({ volume: { A: volume, B: volume }, crossfader: 0, midiConnected: false, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master });

describe("trim and master", () => {
  beforeEach(resetMixer);
  test("trim maps -1..1 to -12..+12 dB and clamps", () => {
    expect([trimDb(0), trimDb(1), trimDb(-1), trimDb(0.5), trimDb(3), trimDb(-3)]).toEqual([0, 12, -12, 6, 12, -12]);
    setDeckTrim("A", 2);
    expect(getMixer().fx.A.trim).toBe(1);
    setDeckTrim("A", NaN);
    expect(getMixer().fx.A.trim).toBe(1);
    setDeckTrim("B", -0.25);
    expect(trimDb(getMixer().fx.B.trim)).toBe(-3);
  });
  test("master is a squared 0..1 attenuation on top of the fader and crossfader", () => {
    expect(deckGain("A", mix(1))).toBe(1);
    expect(deckGain("A", mix(0.5))).toBeCloseTo(0.25);
    expect(deckGain("A", mix(0))).toBe(0);
    expect(deckGain("B", mix(0.5, 0.5))).toBeCloseTo(0.0625);
    setMasterGain(7);
    expect(getMixer().master).toBe(1);
    setMasterGain(-1);
    expect(getMixer().master).toBe(0);
    setMasterGain(NaN);
    expect(getMixer().master).toBe(0);
  });
});

describe("range cycle", () => {
  const cycle = (range: number, pitch: number) => cycleRange(fx(range, pitch));
  const rateOf = (p: { range: number; pitch: number } | null) => p && faderRate(fx(p.range, p.pitch));

  test("rescales pitch so the rate does not jump, in both signs", () => {
    for (const sign of [1, -1]) {
      const a = cycle(0.08, 0.5 * sign)!;
      expect(a.range).toBe(0.16);
      expect(a.pitch).toBeCloseTo(0.25 * sign);
      expect(rateOf(a)).toBeCloseTo(1 + 0.04 * sign);
      const b = cycle(0.16, 0.25 * sign)!;
      expect(b.range).toBe(0.5);
      expect(b.pitch).toBeCloseTo(0.08 * sign);
      const c = cycle(0.5, 0.08 * sign)!;
      expect(c.range).toBe(0.08);
      expect(c.pitch).toBeCloseTo(0.5 * sign);
    }
  });

  test("skips a range that cannot hold the rate (both signs)", () => {
    for (const sign of [1, -1]) {
      const rate = 1 + 0.15 * sign; // 50% fader at 0.3: 8% can't hold it, 16% can
      const p = cycle(0.5, 0.3 * sign)!;
      expect(p.range).toBe(0.16);
      expect(p.pitch).toBeCloseTo(0.9375 * sign);
      expect(rateOf(p)).toBeCloseTo(rate);
      // From 8%: 16% holds 1.15? No (0.9375 of 0.16 = 1.15 needs 16% >= 15%: yes) -> still 16%.
      expect(cycle(0.08, 0.5 * sign)!.range).toBe(0.16);
    }
    // From 16% at a 14% offset: next is 50%, which holds anything.
    expect(cycle(0.16, 0.875)!.range).toBe(0.5);
  });

  test("when no other range can hold the rate, there is no plan (range stays)", () => {
    expect(cycle(0.5, 0.8)).toBeNull(); // 1.4x
    expect(cycle(0.5, -0.8)).toBeNull(); // 0.6x
  });

  test("boundaries: exactly full-scale at the target range is allowed; a hair beyond is skipped", () => {
    const edge = cycle(0.5, 0.16)!; // rate 1.08 -> 8% at pitch 1
    expect(edge.range).toBe(0.08);
    expect(edge.pitch).toBeCloseTo(1);
    expect(cycle(0.5, -0.16)!.pitch).toBeCloseTo(-1);
    const over = cycle(0.5, 0.1601)!; // 1.08005: 8% would need pitch 1.0006
    expect(over.range).toBe(0.16);
    expect(over.pitch).toBeCloseTo(0.5003, 3);
    expect(cycle(0.08, 1)!.range).toBe(0.16); // 1.08 on 16%
    expect(cycle(0.16, 1)!.range).toBe(0.5); // 1.16 on 50%
    expect(cycle(0.16, -1)!.range).toBe(0.5);
  });

  test("full cycle returns to the start range with the same rate", () => {
    let p = { range: 0.08 as number, pitch: 0.4 };
    const rate = faderRate(fx(p.range, p.pitch));
    const seen: number[] = [];
    for (let i = 0; i < PITCH_RANGES.length; i++) { p = cycle(p.range, p.pitch)!; seen.push(p.range); expect(faderRate(fx(p.range, p.pitch))).toBeCloseTo(rate); }
    expect(seen).toEqual([0.16, 0.5, 0.08]);
  });

  test("deckRate follows the range", () => {
    expect(deckRate(fx(0.5, 1), 0)).toBe(1.5);
    expect(deckRate(fx(0.16, -0.5), 0)).toBeCloseTo(0.92);
    expect(deckRate(fx(0.08, 1), 0)).toBeCloseTo(1.08);
  });
});

describe("fader pickup (soft takeover)", () => {
  beforeEach(resetMixer);
  const pitch = () => getMixer().fx.A.pitch;

  test("crossing logic", () => {
    expect(pickupCrossed(0.5, 0.1, 0.3)).toBe(false);
    expect(pickupCrossed(0.5, 0.3, 0.7)).toBe(true);
    expect(pickupCrossed(0.5, 0.9, 0.7)).toBe(false);
    expect(pickupCrossed(0.5, 0.9, 0.2)).toBe(true);
    expect(pickupCrossed(0.5, null, 0.3)).toBe(false);
    expect(pickupCrossed(0.5, null, 0.49)).toBe(true); // within epsilon
  });

  test("after a software move the fader is ignored until it crosses the value, then follows", () => {
    setDeckPitchFromController("A", 0);
    expect(pitch()).toBe(0);
    setDeckRangePitch("A", 0.16, 0.5);
    setDeckPitchFromController("A", 0.1);
    setDeckPitchFromController("A", 0.4);
    expect(pitch()).toBe(0.5); // untouched: no tempo jump
    setDeckPitchFromController("A", 0.6);
    expect(pitch()).toBe(0.6); // crossed
    setDeckPitchFromController("A", 0.2);
    expect(pitch()).toBe(0.2); // pickup is over
  });

  test("approaching from above crosses too, and landing on the value picks up", () => {
    setDeckPitchFromController("A", 0.9);
    setDeckRangePitch("A", 0.08, -0.3);
    setDeckPitchFromController("A", 0.5);
    expect(pitch()).toBe(-0.3);
    setDeckPitchFromController("A", -0.5);
    expect(pitch()).toBe(-0.5);
    setDeckRangePitch("A", 0.08, 0.3);
    setDeckPitchFromController("A", 0.29);
    expect(pitch()).toBe(0.29);
  });

  test("with no earlier fader position only landing on the value picks up", () => {
    setDeckRangePitch("A", 0.08, 0.5);
    setDeckPitchFromController("A", 0.9);
    expect(pitch()).toBe(0.5);
    setDeckPitchFromController("A", 0.2); // crossing now that a previous position is known
    expect(pitch()).toBe(0.2);
  });

  test("on-screen drags bypass and end the pickup; decks are independent", () => {
    setDeckPitchFromController("A", 0);
    setDeckRangePitch("A", 0.16, 0.5);
    setDeckPitch("A", 0.9);
    expect(pitch()).toBe(0.9);
    setDeckPitchFromController("A", 0.1);
    expect(pitch()).toBe(0.1);
    setDeckRangePitch("A", 0.08, 0.5);
    setDeckPitchFromController("B", 0.3);
    expect(getMixer().fx.B.pitch).toBe(0.3);
  });

  test("a disconnect forgets the pickup", () => {
    setDeckPitchFromController("A", 0);
    setDeckRangePitch("A", 0.16, 0.5);
    setMidiConnected(true);
    setMidiConnected(false);
    setDeckPitchFromController("A", 0.1);
    expect(pitch()).toBe(0.1);
  });

  test("a software move changes range and pitch together", () => {
    setDeckRangePitch("A", 0.5, 0.3);
    expect(getMixer().fx.A.range).toBe(0.5);
    expect(getMixer().fx.A.pitch).toBe(0.3);
    setDeckRangePitch("A", NaN, 0.3);
    expect(getMixer().fx.A.range).toBe(0.5);
  });
});

describe("planRate", () => {
  test("stays in the current range when it fits, steps up otherwise, never down", () => {
    const fits = planRate(fx(0.08, 0), 1.04)!;
    expect([fits.range, +fits.pitch.toFixed(6)]).toEqual([0.08, 0.5]);
    expect(planRate(fx(0.08, 0), 1.12)!.range).toBe(0.16);
    expect(planRate(fx(0.08, 0), 1.3)!.range).toBe(0.5);
    expect(planRate(fx(0.5, 0), 1.01)!.range).toBe(0.5);
    expect(planRate(fx(0.16, 0), 1.01)!.range).toBe(0.16);
  });
  test("out of range or unusable rates have no plan", () => {
    expect(planRate(fx(0.08, 0), 1.6)).toBeNull();
    expect(planRate(fx(0.08, 0), 0.4)).toBeNull();
    expect(planRate(fx(0.08, 0), NaN)).toBeNull();
  });
});

describe("Sync", () => {
  const src = (bpm: number | null, engine = true, f: DeckFx = NEUTRAL_FX): SyncSource => ({ bpm, engine, fx: f });

  test("reference tempo: engine deck = bpm x fader rate (bend ignored), element deck = bpm x 1", () => {
    expect(referenceTempo(src(128, true, fx(0.08, 0.5)))).toBeCloseTo(133.12);
    expect(referenceTempo(src(128, true, { ...fx(0.08, 0.5), bend: { dir: 1, since: 0 } }))).toBeCloseTo(133.12);
    expect(referenceTempo(src(128, false, fx(0.08, 0.5)))).toBe(128);
    expect(referenceTempo(src(null))).toBeNull();
    expect(referenceTempo(src(0))).toBeNull();
  });

  test("in range: sets pitch within the current range", () => {
    const r = planSync(src(125), src(128));
    expect(r.ok && r.plan.range).toBe(0.08);
    expect(r.ok && r.plan.pitch).toBeCloseTo((128 / 125 - 1) / 0.08);
    const down = planSync(src(130), src(128));
    expect(down.ok && down.plan.pitch).toBeCloseTo((128 / 130 - 1) / 0.08);
  });

  test("uses the reference deck's current fader tempo", () => {
    const r = planSync(src(128), src(128, true, fx(0.08, 1)));
    expect(r.ok && r.plan.pitch).toBeCloseTo(1); // 138.24 / 128 = 1.08
  });

  test("steps the range up when the current one cannot reach it", () => {
    const r = planSync(src(100), src(112));
    expect(r.ok && r.plan.range).toBe(0.16);
    expect(r.ok && r.plan.pitch).toBeCloseTo(0.75);
    const wide = planSync(src(100), src(130));
    expect(wide.ok && wide.plan.range).toBe(0.5);
    // already on a wider range: stays there
    const stay = planSync(src(100, true, fx(0.16, 0)), src(104));
    expect(stay.ok && stay.plan.range).toBe(0.16);
  });

  test("out of range even at 50%", () => {
    expect(planSync(src(100), src(160))).toEqual({ ok: false, reason: "out-of-range" });
    expect(planSync(src(100), src(40))).toEqual({ ok: false, reason: "out-of-range" });
  });

  test("a missing BPM on either deck", () => {
    expect(planSync(src(null), src(128))).toEqual({ ok: false, reason: "no-bpm" });
    expect(planSync(src(128), src(null))).toEqual({ ok: false, reason: "no-bpm" });
  });

  test("element reference: its stored pitch is ignored (pinned at 1x)", () => {
    const r = planSync(src(120), src(128, false, fx(0.08, -1)));
    expect(r.ok && r.plan.pitch).toBeCloseTo((128 / 120 - 1) / 0.08);
  });

  test("the registry returns each deck's source and forgets it on unregister", () => {
    const off = registerSyncSource("A", () => src(99));
    expect(syncSourceOf("A")?.bpm).toBe(99);
    expect(syncSourceOf("B")).toBeNull();
    off();
    expect(syncSourceOf("A")).toBeNull();
  });
});
