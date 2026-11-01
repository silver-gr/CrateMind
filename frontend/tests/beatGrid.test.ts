import { describe, expect, test } from 'bun:test';
import { beatsInRange, buildBeatGrid, fillBeatGaps, gridBarPhase } from '../src/lib/beatGrid';

describe('straight grid', () => {
  const grid = buildBeatGrid({ bpm: 120, straight: true, anchor_s: 1, first_downbeat_index: 0, beats: null }, 99, 0)!;
  test('beats are anchor + k*period, downbeats every 4, bar 1 is the anchor', () => {
    const beats = beatsInRange(grid, 1, 5);
    expect(beats.map(b => b.time)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    expect(beats.filter(b => b.downbeat).map(b => [b.time, b.bar])).toEqual([[1, 1], [3, 2], [5, 3]]);
    expect(grid.estimated).toBe(false);
  });
  test('beats before the anchor are drawn but have no bar number', () => {
    const early = beatsInRange(grid, -1, 1.2);
    expect(early.map(b => b.time)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(early[0]).toMatchObject({ downbeat: true, bar: null });
  });
  test('bar phase follows the anchor and wraps', () => {
    expect(gridBarPhase(grid, 1)).toBe(0);
    expect(gridBarPhase(grid, 2)).toBeCloseTo(0.5);
    expect(gridBarPhase(grid, 0.5)).toBeCloseTo(0.75);
  });
});

describe('non-straight grid', () => {
  test('a gap is rounded to whole beats and filled evenly', () => {
    const filled = fillBeatGaps([0, 0.5, 1, 2, 2.5], 0);
    expect(filled.times).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
  });
  test('first downbeat index follows the fill; bars count from it', () => {
    const grid = buildBeatGrid({ bpm: 120, straight: false, anchor_s: null, first_downbeat_index: 3, beats: [0, 0.5, 1, 2, 2.5, 3, 3.5, 4, 4.5] }, null, null)!;
    expect(grid.kind).toBe('list');
    const downs = beatsInRange(grid, 0, 5).filter(b => b.downbeat);
    // raw index 3 (t=2) -> filled index 4 (t=2): downbeat, bar 1; the next downbeat is 4 beats later
    expect(downs.map(b => [b.time, b.bar])).toEqual([[0, null], [2, 1], [4, 2]]);
    expect(gridBarPhase(grid, 2)).toBe(0);
    expect(gridBarPhase(grid, 3)).toBeCloseTo(0.5);
    expect(gridBarPhase(grid, 99)).toBe(-1);
  });
});

describe('fallback estimate', () => {
  test('without an imported grid, BPM + entry cue is drawn as an estimate', () => {
    const grid = buildBeatGrid(null, 120, 10)!;
    expect(grid).toMatchObject({ kind: 'straight', anchor: 10, period: 0.5, estimated: true });
    expect(gridBarPhase(grid, 10)).toBe(-1); // controllers keep the existing barPhase for estimates
  });
  test('no entry cue anchors at 0; no tempo means no grid', () => {
    expect(buildBeatGrid(null, 128, null)).toMatchObject({ anchor: 0, estimated: true });
    expect(buildBeatGrid(null, null, 5)).toBeNull();
  });
  test('an unusable imported grid falls back to the estimate', () => {
    expect(buildBeatGrid({ bpm: 120, straight: false, anchor_s: null, first_downbeat_index: 0, beats: null }, 100, 1)?.estimated).toBe(true);
  });
});
