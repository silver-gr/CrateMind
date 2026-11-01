import { describe, expect, test } from 'bun:test';
import { beatsInRange, buildBeatGrid, downbeatAfter, fillBeatGaps, gridBarPhase } from '../src/lib/beatGrid';

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

describe('downbeat override', () => {
  const dto = (anchor: number) => ({ bpm: 120, straight: true, anchor_s: anchor, first_downbeat_index: 0, beats: null });
  const downs = (g: NonNullable<ReturnType<typeof buildBeatGrid>>, a: number, b: number) => beatsInRange(g, a, b).filter(x => x.downbeat).map(x => [x.time, x.bar]);

  test('null leaves the grid unchanged', () => {
    expect(buildBeatGrid(dto(1), 99, 0, null)).toEqual({ ...buildBeatGrid(dto(1), 99, 0)!, overridden: false });
    expect(buildBeatGrid(null, 120, 2, null)).toMatchObject({ anchor: 2, estimated: true, overridden: false });
  });
  test('on an estimate the value is the exact phase reference, nearest the original anchor, no renumbering', () => {
    const g = buildBeatGrid(null, 120, 0, 0.3)!;
    expect(g).toMatchObject({ kind: 'straight', anchor: 0.3, estimated: true, overridden: true });
    expect((buildBeatGrid(null, 120, 0, 2.3) as { anchor: number }).anchor).toBeCloseTo(0.3); // 2.3 - 2 = 0.3, nearest 0 is 0.3 (not -1.7)
    expect((buildBeatGrid(null, 120, 10, 3.3) as { anchor: number }).anchor).toBeCloseTo(9.3);
    expect(downs(g, 0, 3)).toEqual([[0.3, 1], [2.3, 2]]);
  });
  test('a Set on a downbeat that is already right changes nothing visible', () => {
    const g = buildBeatGrid(dto(1), null, null, 5)!;
    expect(downs(g, 0, 7)).toEqual(downs(buildBeatGrid(dto(1), null, null)!, 0, 7));
  });
  test('repeated Set on an estimate keeps refining', () => {
    const a = buildBeatGrid(null, 120, 0, 0.31)!;
    const b = buildBeatGrid(null, 120, 0, downbeatAfter(a, 0.37, 'set'))!;
    expect(b).toMatchObject({ anchor: 0.37, overridden: true });
  });
  test('an off-beat value on an imported straight grid keeps djay beat times', () => {
    const g = buildBeatGrid(dto(1), null, null, 3.37)!;
    expect(g).toMatchObject({ estimated: false, overridden: true });
    expect(beatsInRange(g, 0, 4).map(b => b.time)).toEqual(beatsInRange(buildBeatGrid(dto(1), null, null)!, 0, 4).map(b => b.time));
    expect(downs(g, 0, 4)).toEqual([[1.5, 1], [3.5, 2]]); // 3.37 snaps to beat 3.5; nearest in-phase downbeat to the old anchor 1
  });
  test('list grid downIndex follows the nearest beat, in phase, nearest the original', () => {
    const raw = { bpm: 120, straight: false, anchor_s: null, first_downbeat_index: 0, beats: Array.from({ length: 40 }, (_, i) => i * 0.5) };
    expect(buildBeatGrid(raw, null, null, 3.0)).toMatchObject({ kind: 'list', downIndex: 2, overridden: true }); // index 6, nearest to 0 is 2
    expect(buildBeatGrid(raw, null, null, 0.5)).toMatchObject({ downIndex: 1 });
    expect(buildBeatGrid(raw, null, null, 1.5)).toMatchObject({ downIndex: 3 });
    expect(buildBeatGrid(raw, null, null, 1.5)!.kind).toBe('list');
  });
  test('arrows move one beat, wrap to stay in range, and four presses cycle the phase', () => {
    let g = buildBeatGrid(null, 120, 0, 0)!; // downbeats at 0, 2, 4 ...
    expect(downbeatAfter(g, 0, 'next')).toBeCloseTo(0.5);
    expect(downbeatAfter(g, 0, 'prev')).toBeCloseTo(1.5); // -0.5 + 2
    expect(downbeatAfter(g, 9.9, 'next', 10)).toBeCloseTo(8.5); // 10.5 > 10 -> -2
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const v = downbeatAfter(g, 4, 'next');
      seen.push(v);
      g = buildBeatGrid(null, 120, 0, v)!;
    }
    expect(seen[3] % 2).toBeCloseTo(0); // original phase again after four beats
    const list = buildBeatGrid({ bpm: 120, straight: false, anchor_s: null, first_downbeat_index: 0, beats: Array.from({ length: 10 }, (_, i) => i * 0.5) }, null, null)!;
    expect(downbeatAfter(list, 0, 'prev')).toBeCloseTo(1.5);
    expect(downbeatAfter(list, 4.5, 'next')).toBeLessThanOrEqual(4.5);
    expect(downbeatAfter(list, 2, 'next')).toBeCloseTo(2.5);
  });
  test('gridBarPhase: -1 for a plain estimate, live after an override, -1 again after reset', () => {
    expect(gridBarPhase(buildBeatGrid(null, 120, 0), 1)).toBe(-1);
    expect(gridBarPhase(buildBeatGrid(null, 120, 0, 0.5), 1.5)).toBeCloseTo(0.5);
    expect(gridBarPhase(buildBeatGrid(null, 120, 0, null), 1)).toBe(-1);
  });
  test('a djay anchor a few ms before 0:00 keeps its bar numbers after a Set on it', () => {
    const before = beatsInRange(buildBeatGrid(dto(-0.002), null, null)!, 0, 4).filter(b => b.downbeat).map(b => b.bar);
    const after = beatsInRange(buildBeatGrid(dto(-0.002), null, null, -0.002 + 2)!, 0, 4).filter(b => b.downbeat).map(b => b.bar);
    expect(after).toEqual(before);
  });
  test('Set is clamped to the known duration', () => {
    const est = buildBeatGrid(null, 120, 0)!;
    expect(downbeatAfter(est, 200.004, 'set', 200)).toBe(200);
    expect(downbeatAfter(est, 12.3, 'set', 200)).toBe(12.3);
  });
});
