import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DB_FLOOR } from "../src/lib/deckTelemetry";
import { FALL_DB_PER_S, LIM_HOLD_MS, PEAK_HOLD_MS, SILENT_CHANNEL, limUntil, meterShare, peakDb, stepChannel } from "../src/lib/masterMeter";

test("peaks map to dBFS and to the filled share of the meter", () => {
  expect(peakDb(1)).toBe(0);
  expect(peakDb(0.5)).toBeCloseTo(-6.02, 2);
  expect(peakDb(0)).toBe(DB_FLOOR);
  expect(peakDb(1e-9)).toBe(DB_FLOOR);
  expect(meterShare(0)).toBe(1);
  expect(meterShare(3)).toBe(1);
  expect(meterShare(DB_FLOOR)).toBe(0);
  expect(meterShare(DB_FLOOR / 2)).toBe(0.5);
});

test("the bar jumps up and falls at its rate; the marker holds the peak, then falls, never below the bar", () => {
  const hit = stepChannel(SILENT_CHANNEL, 1, 1000, 16);
  expect(hit).toEqual({ db: 0, holdDb: 0, holdUntil: 1000 + PEAK_HOLD_MS });
  const quiet = stepChannel(hit, 0, 1500, 500);
  expect(quiet.db).toBeCloseTo(-FALL_DB_PER_S / 2, 6);
  expect(quiet.holdDb).toBe(0); // still held
  const released = stepChannel(quiet, 0, 2500, 1000);
  expect(released.db).toBeCloseTo(-FALL_DB_PER_S * 1.5, 6);
  expect(released.holdDb).toBeCloseTo(-FALL_DB_PER_S, 6);
  const floor = stepChannel(released, 0, 10_000, 7500);
  expect(floor).toEqual({ db: DB_FLOOR, holdDb: DB_FLOOR, holdUntil: released.holdUntil });
  // A new, higher peak resets the hold.
  const again = stepChannel(quiet, 1, 1600, 100);
  expect(again.holdUntil).toBe(1600 + PEAK_HOLD_MS);
});

test("the «LIM» light stays on a moment after the limiter last worked", () => {
  const off = limUntil(0, true, 100);
  expect(off).toBe(100 + LIM_HOLD_MS);
  expect(limUntil(off, false, 200)).toBe(off);
  expect(limUntil(off, true, 300)).toBe(300 + LIM_HOLD_MS);
});

test("the master meter lives in the top bar alone, and draws without React state", () => {
  // Stage 2 of the deck layout: the meter, «LIM», «MAX» and REC left the mixer for the top bar.
  const dock = readFileSync(new URL("../src/components/DeckDock.tsx", import.meta.url), "utf8");
  for (const gone of ["MasterMeter", "RecordChip", "Maximizer"]) expect(dock).not.toContain(gone);
  const loudness = readFileSync(new URL("../src/components/layout/AppearanceControls.tsx", import.meta.url), "utf8");
  expect(loudness).toContain("<MasterMeterBar live outside={outside}");
  expect(loudness).toContain("MAX<MaximizerReductionBar");
  // The Maximizer's controls are the «Ένταση ακρόασης» popover's second column (personal builds).
  expect(loudness).toMatch(/if \(!MAXIMIZER_BUILT\) return main;[\s\S]{0,200}<MaximizerControls \/>/);
  const meter = readFileSync(new URL("../src/components/MasterMeter.tsx", import.meta.url), "utf8");
  expect(meter).not.toContain("useState");
  expect(meter).toContain("requestAnimationFrame");
});
