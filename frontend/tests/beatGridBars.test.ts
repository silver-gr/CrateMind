import { describe, expect, test } from 'bun:test';
import { barIndexAt, barSeconds, buildBeatGrid, snapToBar, timeAfterBars, type BeatGrid } from '../src/lib/beatGrid';

describe('bar helpers on a straight grid', () => {
  const grid = buildBeatGrid({ bpm: 140, straight: true, anchor_s: 0.5, first_downbeat_index: 0, beats: null }, null, null)!;
  const bar = 4 * 60 / 140;

  test('a bar is four beats', () => {
    expect(barSeconds(grid)).toBeCloseTo(1.7143, 4);
    expect(barSeconds(grid, 100)).toBeCloseTo(bar, 9);
  });
  test('snaps to the bar line down, nearest and up', () => {
    expect(snapToBar(grid, 10, 'down')).toBeCloseTo(0.5 + 5 * bar, 9);
    expect(snapToBar(grid, 10, 'nearest')).toBeCloseTo(0.5 + 6 * bar, 9);
    expect(snapToBar(grid, 9.5, 'nearest')).toBeCloseTo(0.5 + 5 * bar, 9);
    expect(snapToBar(grid, 10, 'up')).toBeCloseTo(0.5 + 6 * bar, 9);
  });
  test('a time on a bar line stays put in every direction', () => {
    const t = 0.5 + 5 * bar;
    for (const dir of ['down', 'nearest', 'up'] as const) expect(snapToBar(grid, t, dir)).toBeCloseTo(t, 9);
    expect(snapToBar(grid, 0, 'up')).toBeCloseTo(0.5, 9);
  });
  test('timeAfterBars adds whole bars', () => {
    expect(timeAfterBars(grid, 3, 8)).toBeCloseTo(3 + 8 * bar, 9);
    expect(timeAfterBars(grid, 3, 0)).toBeCloseTo(3, 9);
  });
  test('barIndexAt is 1-based and 0 before bar 1', () => {
    expect(barIndexAt(grid, 0.4)).toBe(0);
    expect(barIndexAt(grid, 0.5)).toBe(1);
    expect(barIndexAt(grid, 0.5 + bar - 0.01)).toBe(1);
    expect(barIndexAt(grid, 0.5 + 3 * bar)).toBe(4);
    expect(barIndexAt(grid, 0.5 + 3 * bar + 0.01)).toBe(4);
  });
});

describe('bar helpers on an irregular list grid', () => {
  // Downbeats at index 2 (1.0 s), 6 (3.0 s), 10 (4.8 s); bar 1 lasts 2.0 s, bar 2 lasts 1.8 s; the last period is 0.5 s.
  const times = [0, 0.5, 1.0, 1.5, 2.1, 2.6, 3.0, 3.45, 3.9, 4.35, 4.8, 5.3];
  const grid: BeatGrid = { kind: 'list', times, downIndex: 2, estimated: false, overridden: false };

  test('barSeconds is the length of the bar holding the time (the first bar by default)', () => {
    expect(barSeconds(grid)).toBeCloseTo(2.0, 9);
    expect(barSeconds(grid, 3.5)).toBeCloseTo(1.8, 9);
    expect(barSeconds(grid, 6.0)).toBeCloseTo(2.0, 9); // bar 3 runs past the list: 4.8 → 6.8
  });
  test('snaps land on the list downbeats', () => {
    expect(snapToBar(grid, 2.0, 'down')).toBeCloseTo(1.0, 9);
    expect(snapToBar(grid, 2.0, 'nearest')).toBeCloseTo(1.0, 9);
    expect(snapToBar(grid, 2.2, 'nearest')).toBeCloseTo(3.0, 9);
    expect(snapToBar(grid, 2.0, 'up')).toBeCloseTo(3.0, 9);
    expect(snapToBar(grid, 4.0, 'down')).toBeCloseTo(3.0, 9);
    expect(snapToBar(grid, 4.0, 'nearest')).toBeCloseTo(4.8, 9);
    expect(snapToBar(grid, 4.8, 'up')).toBeCloseTo(4.8, 9);
    expect(snapToBar(grid, 0.2, 'up')).toBeCloseTo(1.0, 9);
  });
  test('timeAfterBars walks 4·bars beats and extrapolates with the last period', () => {
    expect(timeAfterBars(grid, 1.0, 1)).toBeCloseTo(3.0, 9);
    expect(timeAfterBars(grid, 1.0, 2)).toBeCloseTo(4.8, 9);
    expect(timeAfterBars(grid, 3.0, 2)).toBeCloseTo(6.8, 9); // index 14 = 5.3 + 3 × 0.5
    expect(timeAfterBars(grid, 2.2, 1)).toBeCloseTo(3.9 + 0.2 * 0.45, 9); // beat 4.2 → 8.2: 3.9 + 0.2 × 0.45
  });
  test('barIndexAt counts bars from the downbeat index', () => {
    expect(barIndexAt(grid, 0.5)).toBe(0);
    expect(barIndexAt(grid, 1.0)).toBe(1);
    expect(barIndexAt(grid, 2.99)).toBe(1);
    expect(barIndexAt(grid, 3.0)).toBe(2);
    expect(barIndexAt(grid, 4.8)).toBe(3);
    expect(barIndexAt(grid, 6.8)).toBe(4);
  });
});
