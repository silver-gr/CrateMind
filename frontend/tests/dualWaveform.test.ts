import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { buildBeatGrid, timeAfterBars, type BeatGrid } from '../src/lib/beatGrid';
import type { DetailWaveform } from '../src/lib/detailWaveform';
import {
  audioToSource, audioToX, curveLevel, curvePolyline, hitTestWindow, laneBeats, laneColumns, nudgeInLane, playheadXs, rubberband,
  snapToBeat, snapWindow, sourceToAudio, stepBars, viewGeometry, windowAudioS, windowDescription, xToAudio,
} from '../src/lib/transitions/dualWaveform';

const straight = (bpm: number, anchor = 0): BeatGrid => buildBeatGrid({ bpm, straight: true, anchor_s: anchor, first_downbeat_index: 0, beats: null }, null, null)!;
const bar140 = 240 / 140;
const bar147 = 240 / 147;

describe('the shared audio axis', () => {
  test('audioToX and xToAudio round-trip with pxPerSec = width / (bars · barAudioS)', () => {
    const g = viewGeometry({ centerAudioS: 3, bars: 8 }, bar140, 1200);
    expect(g.pxPerSec).toBeCloseTo(1200 / (8 * bar140), 9);
    expect(audioToX(g, 3)).toBeCloseTo(600, 9);
    for (const a of [-5, 0, 2.5, 3, 11.7]) expect(xToAudio(g, audioToX(g, a))).toBeCloseTo(a, 9);
    for (const x of [0, 17, 600, 1199]) expect(audioToX(g, xToAudio(g, x))).toBeCloseTo(x, 9);
  });

  test('each lane maps source ↔ audio with its own anchor and rate', () => {
    const out = { anchorS: 60, rate: 1 };
    const inn = { anchorS: 12, rate: 0.9524 };
    expect(sourceToAudio(out, 60)).toBe(0);
    expect(sourceToAudio(out, 61.5)).toBeCloseTo(1.5, 9);
    expect(sourceToAudio(inn, 12)).toBe(0);
    // A bar of the incoming track spans barS / 0.9524 audio seconds.
    expect(sourceToAudio(inn, 12 + bar147)).toBeCloseTo(bar147 / 0.9524, 9);
    for (const a of [-3, 0, 4.2]) {
      expect(sourceToAudio(out, audioToSource(out, a))).toBeCloseTo(a, 9);
      expect(sourceToAudio(inn, audioToSource(inn, a))).toBeCloseTo(a, 9);
    }
  });

  test('bar lines of both lanes coincide at audio 0 and at every outgoing bar when rateIn equalises the tempos', () => {
    const outGrid = straight(140, 0.25), inGrid = straight(147, 0.4);
    const outStart = timeAfterBars(outGrid, 0.25, 20), inStart = timeAfterBars(inGrid, 0.4, 4);
    const rateIn = 140 / 147;
    const outBars = laneBeats({ grid: outGrid, anchorS: outStart, rate: 1 }, -0.01, 8 * bar140 + 0.01).filter(b => b.downbeat);
    const inBars = laneBeats({ grid: inGrid, anchorS: inStart, rate: rateIn }, -0.01, 8 * bar140 + 0.01).filter(b => b.downbeat);
    expect(outBars.length).toBe(9);
    expect(inBars.length).toBe(9);
    expect(outBars[0].audio).toBeCloseTo(0, 9);
    expect(inBars[0].audio).toBeCloseTo(0, 9);
    outBars.forEach((b, i) => expect(inBars[i].audio).toBeCloseTo(b.audio, 6));
    // At rate 1 the incoming bars drift apart from the outgoing ones.
    const unmatched = laneBeats({ grid: inGrid, anchorS: inStart, rate: 1 }, -0.01, 8 * bar140 + 0.01).filter(b => b.downbeat);
    expect(Math.abs(unmatched[4].audio - outBars[4].audio)).toBeGreaterThan(0.2);
  });

  test('playheads at unequal rates land on their own lane positions', () => {
    const g = viewGeometry({ centerAudioS: 0, bars: 8 }, bar140, 800);
    const out = { anchorS: 100, rate: 1.05 }, inn = { anchorS: 20, rate: 0.9 };
    const p = playheadXs(g, out, inn, { outS: 102.1, inS: 21.8 });
    expect(p.out).toBeCloseTo(audioToX(g, 2.1 / 1.05), 9);
    expect(p.in).toBeCloseTo(audioToX(g, 1.8 / 0.9), 9);
    expect(p.out).toBeCloseTo(p.in, 9); // both 2 s into the mix
  });

  test('the window spans its bars in source time divided by the outgoing rate', () => {
    expect(windowAudioS(straight(120), 10, 8, 1)).toBeCloseTo(16, 9);
    expect(windowAudioS(straight(120), 10, 8, 1.16)).toBeCloseTo(16 / 1.16, 9);
  });
});

describe('curves and hit testing', () => {
  test('curvePolyline maps 1 to the top and 0 to the bottom across [x0, x1]', () => {
    const pts = curvePolyline(new Float32Array([1, 0.5, 0]), 100, 300, 10, 50);
    expect(Array.from(pts)).toEqual([100, 10, 200, 30, 300, 50]);
    expect(Array.from(curvePolyline(new Float32Array([2, -1]), 0, 10, 0, 100))).toEqual([0, 0, 10, 100]);
  });

  test('curveLevel puts full volume, a flat EQ knob and an open filter at the top', () => {
    expect(curveLevel('volume', 1)).toBe(1);
    expect(curveLevel('volume', 0)).toBe(0);
    expect(curveLevel('eq', 0)).toBe(1);
    expect(curveLevel('eq', -1)).toBe(0);
    expect(curveLevel('eq', -0.5)).toBe(0.5);
    expect(curveLevel('filter', 0)).toBe(1);
    expect(curveLevel('filter', -1)).toBe(0);
    expect(curveLevel('filter', 0.5)).toBe(0.5);
  });

  test('hitTestWindow: ±10 px edges, body, outside', () => {
    expect(hitTestWindow(205, 200, 400)).toBe('start');
    expect(hitTestWindow(191, 200, 400)).toBe('start');
    expect(hitTestWindow(189, 200, 400)).toBeNull();
    expect(hitTestWindow(395, 200, 400)).toBe('end');
    expect(hitTestWindow(410, 200, 400)).toBe('end');
    expect(hitTestWindow(300, 200, 400)).toBe('body');
    expect(hitTestWindow(411, 200, 400)).toBeNull();
    // A narrow window: the nearer edge wins.
    expect(hitTestWindow(203, 200, 212)).toBe('start');
    expect(hitTestWindow(209, 200, 212)).toBe('end');
  });

  test('rubberband is monotone, keeps the sign and stays below the dimension', () => {
    let prev = 0;
    for (const o of [1, 5, 20, 100, 1000, 1e6]) {
      const r = rubberband(o, 300);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(300);
      expect(r).toBeLessThan(o);
      prev = r;
    }
    expect(rubberband(0, 300)).toBe(0);
    expect(rubberband(-50, 300)).toBeCloseTo(-rubberband(50, 300), 9);
  });
});

describe('snapping the window', () => {
  const outGrid = straight(120, 0.5); // 2 s bars
  const inGrid = straight(120, 0.25);
  const out = { grid: outGrid, duration: 200, rate: 1 };
  const inn = { grid: inGrid, duration: 180, rate: 1 };

  test('one incoming nudge direction for the buttons, Alt+arrows and the drag: → moves the lane right (entry a beat earlier)', () => {
    expect(nudgeInLane(inGrid, 10.25, 1)).toBeCloseTo(9.75, 9);
    expect(nudgeInLane(inGrid, 10.25, -1)).toBeCloseTo(10.75, 9);
    // A lane drawn from inStartS: a later source point sits further right when the entry is earlier.
    const x = (inStartS: number) => sourceToAudio({ anchorS: inStartS, rate: 1 }, 20);
    expect(x(nudgeInLane(inGrid, 10.25, 1))).toBeGreaterThan(x(10.25));
    const src = (f: string) => readFileSync(new URL(`../src/components/transitions/${f}`, import.meta.url), 'utf8');
    expect(src('TransitionWaveform.tsx')).toContain('nudgeInLane(P.in.grid, ws.inStartS, dir)');
    expect(src('TransitionEditorDialog.tsx')).toContain('nudgeInLane(grids.in, inStartS, dir)');
  });

  test('snapToBeat goes down, nearest and up on the grid', () => {
    expect(snapToBeat(outGrid, 10.2, 'down')).toBeCloseTo(10, 9);
    expect(snapToBeat(outGrid, 10.2, 'nearest')).toBeCloseTo(10, 9);
    expect(snapToBeat(outGrid, 10.3, 'nearest')).toBeCloseTo(10.5, 9);
    expect(snapToBeat(outGrid, 10.2, 'up')).toBeCloseTo(10.5, 9);
    expect(snapToBeat(outGrid, 10.5, 'up')).toBeCloseTo(10.5, 9);
  });

  test('the window start lands on a bar line and bars stay in 1..32', () => {
    const w = snapWindow({ outStartS: 101.2, bars: 8.4, inStartS: 30.1 }, out, inn);
    expect(w.outStartS).toBeCloseTo(100.5, 9);
    expect(w.bars).toBe(8);
    expect(w.inStartS).toBeCloseTo(30.25, 9); // incoming offset snaps to its own beats
    expect(snapWindow({ outStartS: 100, bars: 0, inStartS: 30 }, out, inn).bars).toBe(1);
    expect(snapWindow({ outStartS: 100, bars: 40, inStartS: 30 }, out, inn).bars).toBe(32);
  });

  test('beat units keep a beat-aligned start', () => {
    expect(snapWindow({ outStartS: 101.1, bars: 4, inStartS: 30.25 }, out, inn, 'beat').outStartS).toBeCloseTo(101, 9);
  });

  test('the window is pulled back inside the outgoing track (source time)', () => {
    const w = snapWindow({ outStartS: 195, bars: 8, inStartS: 0.25 }, out, inn);
    expect(timeAfterBars(outGrid, w.outStartS, w.bars)).toBeLessThanOrEqual(200 + 1e-9);
    expect(w.bars).toBe(8);
    expect(w.outStartS).toBeCloseTo(182.5, 9); // the last bar line that still fits 8 bars before 200 s
    const early = snapWindow({ outStartS: -7, bars: 8, inStartS: 0.25 }, out, inn);
    expect(early.outStartS).toBeCloseTo(0.5, 9);
  });

  test('the incoming lane is bounded in its own source time at its own rate', () => {
    const fast = { ...out, rate: 1.16 };
    const slowIn = { ...inn, rate: 0.9 };
    const w = snapWindow({ outStartS: 100.5, bars: 8, inStartS: 179 }, fast, slowIn);
    const span = windowAudioS(outGrid, w.outStartS, w.bars, 1.16) * 0.9;
    expect(w.inStartS + span).toBeLessThanOrEqual(180 + 1e-9);
    expect(w.inStartS).toBeGreaterThanOrEqual(0);
    expect(snapWindow({ outStartS: 100.5, bars: 8, inStartS: -4 }, out, inn).inStartS).toBeCloseTo(0.25, 9);
  });

  test('bars shrink when a track is shorter than the window', () => {
    const short = { grid: inGrid, duration: 5, rate: 1 };
    const w = snapWindow({ outStartS: 100.5, bars: 8, inStartS: 0 }, out, short);
    expect(w.bars).toBe(2);
    expect(w.inStartS + windowAudioS(outGrid, w.outStartS, w.bars, 1)).toBeLessThanOrEqual(5 + 1e-9);
  });

  test('stepBars walks 1, 2, 4, 8, 16, 32 and snaps odd values onto the ladder', () => {
    expect(stepBars(8, 1)).toBe(16);
    expect(stepBars(8, -1)).toBe(4);
    expect(stepBars(32, 1)).toBe(32);
    expect(stepBars(1, -1)).toBe(1);
    expect(stepBars(6, 1)).toBe(8);
    expect(stepBars(6, -1)).toBe(4);
  });

  test('windowDescription names the bars the window covers', () => {
    expect(windowDescription(outGrid, 100.5, 8)).toBe('μπάρες 51–58 · 8 bars');
    expect(windowDescription(outGrid, 100.5, 1)).toBe('μπάρα 51 · 1 bar');
  });
});

describe('lane columns', () => {
  const frames = 100;
  const detail: DetailWaveform = {
    version: 2, sampleRate: 100, hop: 10, win: 10, frames, duration: 10, digestHex: '',
    rms: Uint8Array.from({ length: frames }, (_, i) => (i < 50 ? 100 : 200)),
    peak: Uint8Array.from({ length: frames }, (_, i) => (i < 50 ? 150 : 250)),
    red: new Uint8Array(frames).fill(10), green: new Uint8Array(frames).fill(20), blue: new Uint8Array(frames).fill(30),
  };

  test('one [rms, peak, r, g, b] per column through sampleBands', () => {
    const cols = laneColumns(detail, 0, 10, 4);
    expect(cols.length).toBe(4);
    expect(cols[0][0]).toBeCloseTo(100, 6);
    expect(cols[0][1]).toBe(150);
    expect(cols[3][0]).toBeCloseTo(200, 6);
    expect(cols[3][1]).toBe(250);
    expect(cols[1].slice(2)).toEqual([10, 20, 30]);
  });

  test('columns outside the track are empty', () => {
    const cols = laneColumns(detail, -10, 20, 3);
    expect(cols[0]).toEqual([0, 0, 0, 0, 0]);
    expect(cols[2]).toEqual([0, 0, 0, 0, 0]);
    expect(cols[1][1]).toBe(250);
  });
});
