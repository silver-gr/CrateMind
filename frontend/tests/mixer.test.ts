import { beforeEach, describe, expect, test } from "bun:test";
import {
  BEND_MAX, BEND_RAMP_S, FILTER_Q_DB, NEUTRAL_FX, bendAmount, ccToBipolar, deckGain, deckRate, eqDb, filterParams, getMixer, isTwoDeck,
  releaseBends, resetMixer, setCrossfader, setDeckBend, setDeckEq, setDeckFilter, setDeckPitch, setMidiConnected, setMixerVolume, toggleKeylock,
  type MixerState,
} from "../src/lib/mixer";

const mix = (crossfader: number, a = 1, b = 1, master = 1): MixerState => ({ volume: { A: a, B: b }, crossfader, midiConnected: false, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master });

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
    expect(getMixer()).toEqual({ volume: { A: 1, B: 0 }, crossfader: 1, midiConnected: true, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master: 1 });
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
