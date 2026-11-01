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

const pixelAt = (px: Uint8ClampedArray, width: number) => (x: number, y: number) => Array.from(px.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe('tile rendering', () => {
  const w = wave([255, 255, 0, 255], [255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 0, 255]); // frame i centred at (i*100+50)/1000 s
  test('bands map to R/G/B, height from the full band, silence stays transparent', () => {
    // 10 px/s: column x covers [x/10, (x+1)/10) s = exactly one frame
    const at = pixelAt(renderTileRGBA(w, 0, 10, 4, 8), 4);
    expect(at(0, 4)).toEqual([255, 0, 0, 255]);
    expect(at(1, 4)).toEqual([0, 255, 0, 255]);
    expect(at(2, 4)[3]).toBe(0);
    expect(at(3, 4)).toEqual([0, 0, 255, 255]);
    expect(at(0, 0)[3]).toBe(255); // full height at the reference level
  });
  test('theme palette: lows magenta, highs cyan, mids differ from both', () => {
    const at = pixelAt(renderTileRGBA(w, 0, 10, 4, 8, 'theme'), 4);
    const [lr, lg, lb] = at(0, 4), [mr, mg, mb] = at(1, 4), [hr, hg, hb] = at(3, 4);
    expect(lr).toBeGreaterThan(200);
    expect(lg).toBeLessThan(lr - 80);
    expect(lg).toBeLessThan(lb - 80);
    expect(hr).toBeLessThan(60);
    expect(hg).toBeGreaterThan(190);
    expect(hb).toBeGreaterThan(190);
    expect(mb).toBeGreaterThan(240);
    expect(mr).toBeLessThan(lr - 40);
    expect(mg).toBeLessThan(hg - 40);
    expect(at(2, 4)[3]).toBe(0);
  });
  test('theme palette: a balanced column is lighter than single-band columns', () => {
    const bw = wave([255, 255, 255, 255], [255, 0, 0, 255], [0, 0, 0, 255], [0, 0, 255, 255]);
    const at = pixelAt(renderTileRGBA(bw, 0, 10, 4, 8, 'theme'), 4);
    const minCh = (c: number[]) => Math.min(c[0], c[1], c[2]);
    expect(minCh(at(3, 4))).toBeGreaterThan(minCh(at(0, 4)) + 60);
    expect(minCh(at(3, 4))).toBeGreaterThan(minCh(at(2, 4)) + 60);
  });
  test('narrower than a frame takes the nearest frame (no interpolation); wider takes the max and the linear mean', () => {
    expect(sampleBands(w, 0.2, 0.2)[0]).toBe(0); // frame position 1.5 rounds up to frame 2
    expect(sampleBands(w, 0.14, 0.14)[0]).toBe(255); // position 0.9 -> frame 1
    expect(sampleBands(w, 0.14, 0.14)[4]).toBe(1);
    const wide = sampleBands(wave([255, 128, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 0, 0.2); // frames 0..1
    expect(wide[0]).toBe(255);
    expect(wide[4]).toBeCloseTo((1 + (128 / 255) ** 2) / 2);
    expect(sampleBands(w, 5, 6)).toEqual([0, 0, 0, 0, 0]); // outside the track
  });
  test('half-open bins: a frame on a column boundary is counted in exactly one column', () => {
    const e = wave([0, 0, 255, 0, 0, 0], [0, 0, 255, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]);
    // t = 0.25 s is frame position exactly 2: [0, 0.25) covers frames 0..1, [0.25, 0.45) covers frames 2..3
    expect(sampleBands(e, 0, 0.25)[0]).toBe(0);
    expect(sampleBands(e, 0.25, 0.45)[0]).toBe(255);
  });
  test('two-tone body: translucent outline at the peak, opaque core at the mean energy', () => {
    const alt = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0 : 255)); // columns of 2 frames: max 1, mean 0.5
    const at = pixelAt(renderTileRGBA(wave(alt, alt, alt.map(() => 0), alt.map(() => 0)), 0, 5, 4, 16), 4);
    expect(at(0, 0)).toEqual([255, 0, 0, 140]);
    expect(at(0, 3)[3]).toBe(140);
    expect(at(0, 4)).toEqual([255, 0, 0, 255]);
    expect(at(0, 11)[3]).toBe(255);
    expect(at(0, 12)[3]).toBe(140);
    expect(at(0, 15)[3]).toBe(140);
  });
  test('outline and core rows match the independently computed heights (random waveforms)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const H = 16, W = 16, mid = H / 2;
    for (let n = 0; n < 60; n++) {
      const arr = () => Array.from({ length: 40 }, () => Math.floor(rnd() * 256));
      const full = arr();
      const wv = wave(full, arr(), arr(), arr());
      const pps = 4 + rnd() * 20;
      const px = renderTileRGBA(wv, 0, pps, W, H);
      // independent p99.5 reference (sorted), same fallbacks as the renderer
      const sorted = [...full].sort((x, y) => x - y);
      let refFull = sorted[Math.ceil(full.length * 0.995) - 1];
      if (refFull === 0) refFull = sorted[sorted.length - 1];
      refFull = Math.max(refFull, 1);
      const fullRef = (refFull / 255) ** 2;
      for (let x = 0; x < W; x++) {
        const b = sampleBands(wv, x / pps, (x + 1) / pps);
        const o = Math.min(1, b[0] / 255 / Math.sqrt(fullRef));
        const outline = Math.round(o * mid);
        const silent = b[4] / fullRef < 0.02;
        const core = silent ? 0 : Math.round(Math.min(Math.min(1, b[4] / fullRef), o) * mid);
        const alphas = Array.from({ length: H }, (_, y) => px[(y * W + x) * 4 + 3]);
        expect(alphas.filter((a) => a > 0).length).toBe(2 * outline);
        expect(alphas.filter((a) => a === 255).length).toBe(2 * core);
        expect(2 * core).toBeLessThanOrEqual(2 * outline);
        // rows read outline -> core -> outline: 255 only inside the centred core band
        alphas.forEach((a, y) => {
          const inCore = y >= mid - core && y < mid + core, inOutline = y >= mid - outline && y < mid + outline;
          expect(a).toBe(inCore ? 255 : inOutline ? (silent ? 100 : 140) : 0);
        });
      }
    }
  });
  test('band leakage in a high-only column does not turn the colour white', () => {
    // full 255 everywhere: the leakage floor is 10% of the reference (25.5), so low 10 / mid 11 stay well under it
    const n = 100;
    const fill = (v: number) => Array.from({ length: n }, () => v);
    const lw = wave(fill(255), fill(10), fill(11), fill(200));
    const f = Array.from(renderTileRGBA(lw, 0, 10, 4, 8).slice(4 * 4, 4 * 4 + 4));
    expect(f[2]).toBeGreaterThan(2 * f[0]);
    expect(f[2]).toBeGreaterThan(2 * f[1]);
    const t = Array.from(renderTileRGBA(lw, 0, 10, 4, 8, 'theme').slice(4 * 4, 4 * 4 + 4));
    const dist = (c: number[], ref: number[]) => Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]);
    expect(dist(t, [0, 224, 245])).toBeLessThan(dist(t, [252, 91, 209]));
  });
  test('silence gate: a near-silent column is a dim neutral outline with no core', () => {
    const full = Array.from({ length: 20 }, (_, i) => (i === 5 ? 30 : 255));
    const px = renderTileRGBA(wave(full, full, full, full), 0, 10, 8, 16);
    const at = pixelAt(px, 8);
    expect(at(5, 7)).toEqual([150, 150, 165, 100]);
    for (let y = 0; y < 16; y++) expect(at(5, y)[3]).not.toBe(255);
    expect(at(4, 8)[3]).toBe(255);
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
