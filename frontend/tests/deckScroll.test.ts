import { describe, expect, test } from 'bun:test';
import { clampZoom, displayPosition, drawScale, evictLru, renderTileRGBA, sampleBands, tileBytes, tileDensity, tileDest, tileSeconds, tilesNeeded, viewPxPerSec, zoomByWheel, TILE_WIDTH_PX } from '../src/lib/deckScroll';
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

const wave = (full: number[], low: number[], mid: number[], high: number[]): DetailWaveform => ({
  version: 1, sampleRate: 1000, hop: 100, win: 100, frames: full.length, duration: full.length / 10,
  digestHex: '', full: Uint8Array.from(full), low: Uint8Array.from(low), mid: Uint8Array.from(mid), high: Uint8Array.from(high),
});

describe('tile rendering', () => {
  const w = wave([255, 255, 0, 255], [255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 0, 255]); // frame i centred at (i*100+50)/1000 s
  test('bands map to R/G/B, height from the full band, silence stays transparent', () => {
    // 10 px/s: column x covers [x/10, (x+1)/10) s ~ one frame
    const px = renderTileRGBA(w, 0, 10, 4, 8);
    const at = (x: number, y: number) => Array.from(px.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    expect(at(0, 4)).toEqual([255, 0, 0, 255]);
    expect(at(1, 4)).toEqual([0, 255, 0, 255]);
    expect(at(2, 4)[3]).toBe(0);
    expect(at(3, 4)).toEqual([0, 0, 255, 255]);
    expect(at(0, 0)[3]).toBe(255); // full height at 255
  });
  test('narrower than a frame interpolates; wider takes the max', () => {
    expect(sampleBands(w, 0.2, 0.2)[0]).toBeCloseTo(127.5, 1);
    expect(sampleBands(w, 0, 0.4)[0]).toBe(255);
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
