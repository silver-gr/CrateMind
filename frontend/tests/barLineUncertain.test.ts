import { describe, expect, test } from 'bun:test';
import { BAR_LINE_CONFIDENCE_MIN, barLineUncertain, beatsInRange, buildBeatGrid, gridBarPhase } from '../src/lib/beatGrid';
import { barsBetween } from '../src/lib/barsFromPlayhead';
import type { BeatGridDto } from '../src/lib/types';

const own = (downbeat_confidence: number | null | undefined, extra: Partial<BeatGridDto> = {}): BeatGridDto =>
  ({ bpm: 120, straight: true, anchor_s: 1, first_downbeat_index: 0, beats: null, source: 'cratemind', downbeat_confidence, ...extra });

describe('bar line uncertain', () => {
  test('the threshold is a majority of the bar vote', () => {
    expect(BAR_LINE_CONFIDENCE_MIN).toBe(0.5);
  });
  test("only CrateMind's own grid with a low bar-line confidence is marked", () => {
    expect(barLineUncertain(buildBeatGrid(own(0.42), 120, 0))).toBe(true);
    expect(barLineUncertain(buildBeatGrid(own(0.49), 120, 0))).toBe(true);
    expect(barLineUncertain(buildBeatGrid(own(0.5), 120, 0))).toBe(false);
    expect(barLineUncertain(buildBeatGrid(own(0.8), 120, 0))).toBe(false);
  });
  test('a row without a stored confidence, a djay grid, an estimate and no grid are never marked', () => {
    expect(barLineUncertain(buildBeatGrid(own(null), 120, 0))).toBe(false);
    expect(barLineUncertain(buildBeatGrid(own(undefined), 120, 0))).toBe(false);
    expect(barLineUncertain(buildBeatGrid(own(0.3, { source: 'djay' }), 120, 0))).toBe(false);
    expect(barLineUncertain(buildBeatGrid(null, 120, 0))).toBe(false);
    expect(barLineUncertain(null)).toBe(false);
  });
  test("a beat list of CrateMind's is marked the same way", () => {
    const list = own(0.3, { straight: false, beats: [1, 1.5, 2, 2.5, 3, 3.5], first_downbeat_index: 1 });
    expect(barLineUncertain(buildBeatGrid(list, 120, 0))).toBe(true);
  });
  test("the user's downbeat always clears the mark", () => {
    expect(barLineUncertain(buildBeatGrid(own(0.3), 120, 0, 1.5))).toBe(false);
    const list = own(0.3, { straight: false, beats: [1, 1.5, 2, 2.5, 3, 3.5], first_downbeat_index: 1 });
    expect(barLineUncertain(buildBeatGrid(list, 120, 0, 2))).toBe(false);
  });
  test('the mark changes nothing that counts bars', () => {
    const sure = buildBeatGrid(own(0.9), 120, 0)!;
    const guess = buildBeatGrid(own(0.3), 120, 0)!;
    expect(beatsInRange(guess, 0, 20)).toEqual(beatsInRange(sure, 0, 20));
    expect(gridBarPhase(guess, 7.3)).toBe(gridBarPhase(sure, 7.3));
    expect(barsBetween(guess, 3, 35)).toBe(barsBetween(sure, 3, 35));
    expect({ ...guess, barConfidence: undefined }).toEqual({ ...sure, barConfidence: undefined });
  });
});
