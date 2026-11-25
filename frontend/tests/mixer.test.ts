import { beforeEach, describe, expect, test } from "bun:test";
import {
  BEND_MAX, BEND_RAMP_S, FILTER_Q_DB, LOW_KILL_Q_DB, LOW_KILL_START, NEUTRAL_FX, bendAmount, lowKillHz, ccToBipolar, deckGain, deckRate, eqDb, filterParams, getMixer, isTwoDeck,
  releaseBends, resetMixer, setCrossfader, setCueGain, setCueMix, setDeckBend, setDeckEq, setDeckFilter, setDeckKeylock, setDeckPitch, setMidiConnected, setMixerVolume, toggleKeylock,
  type MixerState,
} from "../src/lib/mixer";

const mix = (crossfader: number, a = 1, b = 1, master = 1): MixerState => ({ volume: { A: a, B: b }, crossfader, midiConnected: false, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master, cueGain: 0.5, cueMix: 0.5, syncLock: null });

describe("deckGain", () => {
  test("both decks are at full gain in the centre", () => {
    expect(deckGain("A", mix(0))).toBe(1);
    expect(deckGain("B", mix(0))).toBe(1);
  });
  test("hard left/right mutes the opposite deck", () => {
    expect(deckGain("A", mix(-1))).toBe(1);
    expect(deckGain("B", mix(-1))).toBe(0);
    expect(deckGain("A", mix(1))).toBe(0);
    expect(deckGain("B", mix(1))).toBe(1);
  });
  test("volume is squared", () => {
    expect(deckGain("A", mix(0, 0.5))).toBeCloseTo(0.25);
    expect(deckGain("B", mix(0.5, 1, 0.5))).toBeCloseTo(0.25);
    expect(deckGain("A", mix(0.5))).toBeCloseTo(0.5);
  });
});

describe("mixer store", () => {
  beforeEach(resetMixer);
  test("clamps writes and tracks connection", () => {
    setMixerVolume("A", 2);
    setMixerVolume("B", -1);
    setCrossfader(5);
    setMidiConnected(true);
    expect(getMixer()).toEqual({ volume: { A: 1, B: 0 }, crossfader: 1, midiConnected: true, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master: 1, cueGain: 0.5, cueMix: 0.5, syncLock: null });
  });
  test("headphone knobs: 0.5 each by default, clamped to 0..1, and they never change a deck's gain", () => {
    const before = [deckGain("A", getMixer()), deckGain("B", getMixer())];
    setCueGain(2);
    setCueMix(-1);
    setCueMix(Number.NaN);
    expect([getMixer().cueGain, getMixer().cueMix]).toEqual([1, 0]);
    expect([deckGain("A", getMixer()), deckGain("B", getMixer())]).toEqual(before);
  });
  test("two-deck mode: controller connected or Deck B loaded", () => {
    expect(isTwoDeck(false, null)).toBe(false);
    expect(isTwoDeck(true, null)).toBe(true);
    expect(isTwoDeck(false, { id: 1 })).toBe(true);
  });
});

describe("deck fx store", () => {
  beforeEach(resetMixer);
  test("setters clamp and ignore non-finite values", () => {
    setDeckEq("A", "hi", 3);
    setDeckEq("A", "lo", -3);
    setDeckEq("A", "mid", NaN);
    setDeckFilter("B", -9);
    setDeckPitch("B", 9);
    setDeckPitch("B", NaN);
    expect(getMixer().fx.A.eq).toEqual({ hi: 1, mid: 0, lo: -1 });
    expect(getMixer().fx.B.filter).toBe(-1);
    expect(getMixer().fx.B.pitch).toBe(1);
  });
  test("slices keep their identity across updates to the other deck and no-op writes", () => {
    setDeckEq("A", "hi", 0.5);
    const a = getMixer().fx.A;
    setDeckEq("B", "lo", -0.5);
    setDeckFilter("B", 0.4);
    toggleKeylock("B");
    setDeckEq("A", "hi", 0.5);
    expect(getMixer().fx.A).toBe(a);
    expect(getMixer().fx.B).not.toBe(NEUTRAL_FX);
    setMixerVolume("A", 0.3);
    expect(getMixer().fx.A).toBe(a);
  });
  test("setDeckKeylock sets one deck's key lock and a repeated value is a no-op", () => {
    setDeckKeylock("A", true);
    const a = getMixer().fx.A;
    expect(a.keylock).toBe(true);
    expect(getMixer().fx.B.keylock).toBe(false);
    setDeckKeylock("A", true);
    expect(getMixer().fx.A).toBe(a);
    setDeckKeylock("A", false);
    expect(getMixer().fx.A.keylock).toBe(false);
  });
  test("neutral decks share NEUTRAL_FX and a release returns to it", () => {
    expect(getMixer().fx.A).toBe(NEUTRAL_FX);
    setDeckBend("A", 1, 100);
    expect(getMixer().fx.A.bend).toEqual({ dir: 1, since: 100 });
    setDeckBend("A", 0, 200);
    expect(getMixer().fx.A.bend.dir).toBe(0);
  });
  test("re-pressing the held direction keeps the ramp start", () => {
    setDeckBend("A", -1, 100);
    setDeckBend("A", -1, 900);
    expect(getMixer().fx.A.bend).toEqual({ dir: -1, since: 100 });
  });
  test("bends are released on disconnect and releaseBends; knob values persist", () => {
    setMidiConnected(true);
    setDeckBend("A", 1, 0);
    setDeckBend("B", -1, 0);
    setDeckPitch("A", 0.5);
    setMidiConnected(false);
    expect(getMixer().fx.A.bend.dir).toBe(0);
    expect(getMixer().fx.B.bend.dir).toBe(0);
    expect(getMixer().fx.A.pitch).toBe(0.5);
    setDeckBend("B", 1, 0);
    releaseBends();
    expect(getMixer().fx.B.bend.dir).toBe(0);
  });
});

describe("fx helpers", () => {
  test("ccToBipolar", () => {
    expect(ccToBipolar(64)).toBe(0);
    expect(ccToBipolar(0)).toBe(-1);
    expect(ccToBipolar(127)).toBe(1);
  });
  test("bendAmount: +1% at once, BEND_MAX at the ramp end, constant after, mirrored", () => {
    const bend = { dir: 1 as const, since: 1000 };
    expect(bendAmount({ dir: 0, since: 0 }, 5000)).toBe(0);
    expect(bendAmount(bend, 1000)).toBeCloseTo(0.01);
    expect(bendAmount(bend, 1000 + BEND_RAMP_S * 500)).toBeCloseTo((0.01 + BEND_MAX) / 2);
    expect(bendAmount(bend, 1000 + BEND_RAMP_S * 1000)).toBeCloseTo(BEND_MAX);
    expect(bendAmount(bend, 99999)).toBeCloseTo(BEND_MAX);
    expect(bendAmount({ dir: -1, since: 1000 }, 99999)).toBeCloseTo(-BEND_MAX);
  });
  test("deckRate: +-8% fader, bend adds, clamped 0.5..1.5", () => {
    expect(deckRate(NEUTRAL_FX, 0)).toBe(1);
    expect(deckRate({ ...NEUTRAL_FX, pitch: 1 }, 0)).toBeCloseTo(1.08);
    expect(deckRate({ ...NEUTRAL_FX, pitch: -1, bend: { dir: -1, since: 0 } }, 99999)).toBeCloseTo(0.82);
    expect(deckRate({ ...NEUTRAL_FX, pitch: 100 }, 0)).toBe(1.5);
    expect(deckRate({ ...NEUTRAL_FX, pitch: -100 }, 0)).toBe(0.5);
  });
  test("eqDb: -26..0..+6", () => {
    expect(eqDb(-1)).toBe(-26);
    expect(eqDb(0)).toBe(0);
    expect(eqDb(1)).toBe(6);
    expect(eqDb(-0.5)).toBe(-13);
  });
  test("filterParams: dead zone is flat, endpoints, Q in dB", () => {
    expect(filterParams(0, 48000)).toEqual({ neutral: true, lpHz: 24000, hpHz: 0 });
    expect(filterParams(0.029, 44100)).toEqual({ neutral: true, lpHz: 22050, hpHz: 0 });
    expect(filterParams(-1, 48000)).toMatchObject({ neutral: false, hpHz: 0 });
    expect(filterParams(-1, 48000).lpHz).toBeCloseTo(60);
    expect(filterParams(-0.031, 48000).lpHz).toBeGreaterThan(19000);
    expect(filterParams(1, 48000).hpHz).toBeCloseTo(8000);
    expect(filterParams(0.031, 48000).hpHz).toBeCloseTo(20, 0);
    expect(filterParams(1, 48000).lpHz).toBe(24000);
    expect(FILTER_Q_DB).toBe(-3.0103);
  });
});

describe("LOW kill zone", () => {
  test("lowKillHz: neutral above -0.85, 20 Hz there, 200 Hz fully left, monotonic, clamped", () => {
    for (const v of [1, 0, -0.5, -0.84, -0.8499]) expect(lowKillHz(v)).toBe(0);
    expect(LOW_KILL_START).toBe(-0.85);
    expect(lowKillHz(-0.85)).toBeCloseTo(20, 9);
    expect(lowKillHz(-1)).toBeCloseTo(200, 9);
    expect(lowKillHz(-0.925)).toBeCloseTo(Math.sqrt(20 * 200), 6); // logarithmic: the geometric mean halfway
    expect(lowKillHz(-5)).toBe(lowKillHz(-1));
    expect(lowKillHz(5)).toBe(0);
    for (let i = 0; i < 15; i++) expect(lowKillHz(-0.86 - i / 100)).toBeGreaterThan(lowKillHz(-0.85 - i / 100));
    // The shelf itself is unchanged everywhere.
    expect(eqDb(-0.85)).toBeCloseTo(-22.1, 9);
    expect(eqDb(-1)).toBe(-26);
    // Two Q 0.7071 sections (Linkwitz-Riley), in dB.
    expect(LOW_KILL_Q_DB[0]).toBeCloseTo(-3.0103, 4);
    expect(LOW_KILL_Q_DB[1]).toBeCloseTo(-3.0103, 4);
  });

  // Web Audio biquad formulas (spec "BiquadFilterNode": lowshelf with S = 1, highpass with Q in dB; Chromium passes a
  // 0 Hz high-pass through flat), evaluated at 48 kHz for the deck's LOW path: shelf 250 Hz, then the two high-passes.
  const SR = 48000;
  type Coeffs = [number, number, number, number, number, number];
  const lowshelf = (gainDb: number): Coeffs => {
    const w0 = (2 * Math.PI * 250) / SR, A = 10 ** (gainDb / 40), c = Math.cos(w0), alpha = (Math.sin(w0) / 2) * Math.SQRT2, k = 2 * alpha * Math.sqrt(A);
    return [A * (A + 1 - (A - 1) * c + k), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - k),
      A + 1 + (A - 1) * c + k, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - k];
  };
  const highpass = (hz: number, qDb: number): Coeffs => {
    if (hz === 0) return [1, 0, 0, 1, 0, 0];
    const w0 = (2 * Math.PI * hz) / SR, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
    return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha];
  };
  const db = (filters: Coeffs[], f: number) => {
    const w = (2 * Math.PI * f) / SR;
    let mag = 1;
    for (const [b0, b1, b2, a0, a1, a2] of filters) {
      const num = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), b1 * Math.sin(w) + b2 * Math.sin(2 * w));
      const den = Math.hypot(a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), a1 * Math.sin(w) + a2 * Math.sin(2 * w));
      mag *= num / den;
    }
    return 20 * Math.log10(mag);
  };
  const lowPath = (knob: number) => [lowshelf(eqDb(knob)), ...LOW_KILL_Q_DB.map(q => highpass(lowKillHz(knob), q))];

  test("fully left the chain reproduces the proposal's figures", () => {
    for (const [f, want] of [[60, -67.6], [100, -48.8], [250, -16.0], [40, -81.9], [150, -32.9], [500, -3.7]]) {
      expect(Math.abs(db(lowPath(-1), f) - want)).toBeLessThan(1);
    }
    // The pair is a 24 dB/octave Linkwitz-Riley: -6 dB at its cutoff, before the shelf.
    expect(db(LOW_KILL_Q_DB.map(q => highpass(200, q)), 200)).toBeCloseTo(-6.02, 1);
  });

  test("just outside the zone the response is today's shelf alone", () => {
    for (const f of [20, 40, 60, 100, 150, 250, 500, 1000, 4000]) {
      expect(db(lowPath(-0.84), f)).toBe(db([lowshelf(-0.84 * 26)], f));
    }
  });
});
