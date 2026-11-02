import { describe, expect, test } from 'bun:test';
import { clampZoom, displayPosition, drawScale, evictLru, sampleBands, tileBytes, tileDensity, tileDest, tileSeconds, tilesNeeded, viewPxPerSec, zoomByWheel, TILE_WIDTH_PX } from '../src/lib/deckScroll';
import { combinedPlayerHeight, deckViewHeight, deckViewMode, DECK_HEADER_HEIGHT } from '../src/lib/deckView';
import type { DetailWaveform } from '../src/lib/detailWaveform';

describe('position and latency', () => {
  test('position is the media currentTime unchanged by default (no extrapolation)', () => {
    expect(displayPosition(12.5, 0.05, 1.08)).toBe(12.5);
  });
  test('latency compensation is in source-time units: latency x rate', () => {
    expect(displayPosition(10, 0.05, 1.1, true)).toBeCloseTo(10 - 0.055);
    expect(displayPosition(10, 0.05, 0, true)).toBeCloseTo(10 - 0.05);
    expect(displayPosition(10, NaN, 1, true)).toBe(10);
  });
});

describe('zoom and scale', () => {
  test('zoom clamps to 2..32 bars; wheel down widens', () => {
    expect(clampZoom(1)).toBe(2); expect(clampZoom(99)).toBe(32); expect(clampZoom(NaN)).toBe(8);
    expect(zoomByWheel(8, 100)).toBeGreaterThan(8); expect(zoomByWheel(8, -100)).toBeLessThan(8);
    expect(zoomByWheel(31, 1e6)).toBe(32);
  });
  test('8 bars at 120 BPM across 1600 px is 16 s: 100 px/s; beat spacing is rate-independent', () => {
    expect(viewPxPerSec(1600, 8, 120)).toBeCloseTo(100);
    // a synced pair: 120 BPM at rate 1 vs 110 BPM at rate 120/110 -> same px between beats
    expect(viewPxPerSec(1600, 8, 110) * 60 / 110).toBeCloseTo(viewPxPerSec(1600, 8, 120) * 60 / 120);
  });
  test('tiles are rastered at half-octave steps and x-scaled to the exact density', () => {
    expect(tileDensity(100)).toBeCloseTo(2 ** 6.5);
    const d = tileDensity(100);
    expect(drawScale(100, d)).toBeCloseTo(100 / d);
    expect(drawScale(d * 1.3, d)).toBeGreaterThan(1);
    expect(tileSeconds(d)).toBeCloseTo(TILE_WIDTH_PX / d);
  });
  test('invalid tempo cannot expand the visible range to the entire track', () => {
    for (const bpm of [0, -1, NaN, Infinity]) expect(viewPxPerSec(1600, 8, bpm)).toBe(100);
  });
});

describe('tile math', () => {
  test('visible range plus one neighbour either side, clamped to the track', () => {
    expect(tilesNeeded(50, 10, 20, 200)).toEqual({ visible: [2, 3], keep: [1, 4] });
    expect(tilesNeeded(1, 10, 20, 200)).toEqual({ visible: [0, 0], keep: [0, 1] });
    expect(tilesNeeded(199, 50, 20, 200).keep[1]).toBe(9);
  });
  test('device-pixel snapping: integer edges, neighbours abut without gaps', () => {
    const a = tileDest(3, 20.3, 55.123, 800, 77.7);
    const b = tileDest(4, 20.3, 55.123, 800, 77.7);
    expect(Number.isInteger(a.x) && Number.isInteger(a.w)).toBe(true);
    expect(a.x + a.w).toBe(b.x);
  });
  test('LRU eviction honours the byte ceiling and never evicts protected tiles', () => {
    const one = tileBytes(2048, 256);
    const m = new Map([['a', { bytes: one }], ['b', { bytes: one }], ['c', { bytes: one }], ['d', { bytes: one }]]);
    expect(evictLru(m, new Set(), one * 4)).toEqual([]);
    expect(evictLru(m, new Set(), one * 2)).toEqual(['a', 'b']);
    expect(evictLru(m, new Set(['a', 'b']), one * 2)).toEqual(['c', 'd']);
    expect(tileBytes(2048, 240 * 2)).toBeLessThan(32 * 1024 * 1024 / 4); // >4 tiles fit per deck at DPR 2
  });
});

const wave = (rms: number[], peak: number[] = rms, red: number[] = rms.map(() => 255), green: number[] = rms.map(() => 0), blue: number[] = rms.map(() => 0)): DetailWaveform => ({
  version: 2, sampleRate: 1000, hop: 100, win: 100, frames: rms.length, duration: rms.length / 10,
  digestHex: '', rms: Uint8Array.from(rms), peak: Uint8Array.from(peak), red: Uint8Array.from(red), green: Uint8Array.from(green), blue: Uint8Array.from(blue),
});

describe('sample aggregation', () => {
  test('column RMS combines mean squares; peak is an independent maximum', () => {
    const w = wave([255, 0, 0], [255, 128, 0]);
    const column = sampleBands(w, 0, .2);
    expect(column[0]).toBeCloseTo(255 / Math.sqrt(2));
    expect(column[1]).toBe(255);
    expect(sampleBands(w, .14, .14)[1]).toBe(128);
    expect(sampleBands(w, 5, 6)).toEqual([0, 0, 0, 0, 0]);
    expect(sampleBands(w, -.2, -.1)).toEqual([0, 0, 0, 0, 0]);
  });
  test('colour aggregation averages complete colours instead of unrelated channel maxima', () => {
    const w = wave([200, 200], [255, 255], [240, 0], [0, 200], [0, 0]);
    expect(sampleBands(w, 0, .2).slice(2)).toEqual([120, 100, 0]);
  });
  test('a frame on a column boundary contributes to exactly one wide column', () => {
    const w = wave([0, 0, 30, 0, 0], [0, 0, 255, 0, 0]);
    expect(sampleBands(w, 0, .25)[1]).toBe(0);
    expect(sampleBands(w, .25, .45)[1]).toBe(255);
  });
  test('first and partial final frames remain visible at track edges', () => {
    const w = wave([10, 20], [255, 255]);
    w.duration = .101;
    expect(sampleBands(w, 0, .01)[1]).toBe(255);
    expect(sampleBands(w, 0, w.duration)[1]).toBe(255);
    expect(sampleBands(w, .1, .101)[0]).toBe(20);
  });
});

describe('panel height', () => {
  test('full = both header rows + both waveforms; headers-only drops the waveforms; hidden is 0', () => {
    expect(deckViewHeight('full', 88)).toBe(2 * (DECK_HEADER_HEIGHT + 88));
    expect(deckViewHeight('headers', 88)).toBe(2 * DECK_HEADER_HEIGHT);
    expect(deckViewHeight('hidden', 88)).toBe(0);
  });
  test('the combined height feeds the CSS variable and the Toaster offset', () => {
    expect(combinedPlayerHeight(240, deckViewHeight('full', 88))).toBe(240 + 2 * (DECK_HEADER_HEIGHT + 88));
    expect(combinedPlayerHeight(240, 0)).toBe(240);
  });
  test('short windows collapse to headers, then hide', () => {
    expect(deckViewMode(1100, 240, 88)).toBe('full');
    expect(deckViewMode(700, 240, 88)).toBe('headers');
    expect(deckViewMode(520, 240, 88)).toBe('hidden');
  });
});
