import { beforeEach, describe, expect, test } from "bun:test";
import { deckGain, getMixer, isTwoDeck, resetMixer, setCrossfader, setMidiConnected, setMixerVolume, type MixerState } from "../src/lib/mixer";

const mix = (crossfader: number, a = 1, b = 1): MixerState => ({ volume: { A: a, B: b }, crossfader, midiConnected: false });

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
    expect(getMixer()).toEqual({ volume: { A: 1, B: 0 }, crossfader: 1, midiConnected: true });
  });
  test("two-deck mode: controller connected or Deck B loaded", () => {
    expect(isTwoDeck(false, null)).toBe(false);
    expect(isTwoDeck(true, null)).toBe(true);
    expect(isTwoDeck(false, { id: 1 })).toBe(true);
  });
});
