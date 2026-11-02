import { describe, expect, test } from 'bun:test';
import type { DetailWaveform } from '../src/lib/detailWaveform';
import { renderOverviewRGBA } from '../src/lib/overviewWaveform';

function wave(rms: number[], peak = rms, rgb: [number, number, number] = [255, 0, 0], duration = 10): DetailWaveform {
  return { version: 2, sampleRate: 44100, hop: 40, win: 40, frames: rms.length, duration, digestHex: 'synthetic',
    rms: Uint8Array.from(rms), peak: Uint8Array.from(peak),
    red: Uint8Array.from(rms, () => rgb[0]), green: Uint8Array.from(rms, () => rgb[1]), blue: Uint8Array.from(rms, () => rgb[2]) };
}
function pixel(rgba: Uint8ClampedArray, width: number, x: number, y: number) {
  return Array.from(rgba.slice((y * width + x) * 4, (y * width + x + 1) * 4));
}
function extent(rgba: Uint8ClampedArray, width: number, height: number, x: number) {
  let count = 0;
  for (let y = 0; y < height; y++) if (rgba[(y * width + x) * 4 + 3]) count++;
  return count;
}

describe('continuous spectral overview', () => {
  test('true silence is transparent even when colour bytes contain gray', () => {
    const result = renderOverviewRGBA(wave([0, 0, 0], [0, 0, 0], [51, 51, 51]), 45, 40, 'frequency');
    expect(result.length).toBe(45 * 40 * 4);
    expect(result.every(value => value === 0)).toBe(true);
  });
  test('every column of constant audio is continuous and has the same actual colour', () => {
    const result = renderOverviewRGBA(wave(Array(37).fill(180)), 80, 40, 'frequency');
    const center = pixel(result, 80, 0, 19);
    for (let x = 0; x < 80; x++) {
      expect(extent(result, 80, 40, x)).toBeGreaterThan(0);
      expect(pixel(result, 80, x, 19)).toEqual(center);
    }
    expect(center[0]).toBeGreaterThan(center[2] + 70);
  });
  test('frequency content changes colour at fixed time and amplitude', () => {
    const red = renderOverviewRGBA(wave(Array(16).fill(200), undefined, [255, 0, 0]), 16, 40, 'frequency');
    const blue = renderOverviewRGBA(wave(Array(16).fill(200), undefined, [0, 0, 255]), 16, 40, 'frequency');
    expect(pixel(red, 16, 8, 19)[0]).toBeGreaterThan(pixel(red, 16, 8, 19)[2] + 70);
    expect(pixel(blue, 16, 8, 19)[2]).toBeGreaterThan(pixel(blue, 16, 8, 19)[0] + 70);
    expect(extent(red, 16, 40, 8)).toBe(extent(blue, 16, 40, 8));
  });
  test('short first and partial final transients survive all reduction ratios', () => {
    const rms = Array(103).fill(0), peak = [...rms];
    rms[0] = rms[102] = 40; peak[0] = peak[102] = 255;
    const input = wave(rms, peak);
    input.duration = (102 * 40 + 1) / 44100;
    for (const width of [1, 2, 7, 206]) {
      const result = renderOverviewRGBA(input, width, 80, 'frequency');
      expect(extent(result, width, 80, 0)).toBeGreaterThan(30);
      expect(extent(result, width, 80, width - 1)).toBeGreaterThan(30);
    }
  });
  test('peak max preserves an isolated transient even in one broad column', () => {
    const rms = Array(1000).fill(0), peak = [...rms];
    rms[999] = 40; peak[999] = 255;
    const result = renderOverviewRGBA(wave(rms, peak), 1, 80, 'frequency');
    expect(extent(result, 1, 80, 0)).toBe(60);
  });
  test('shared linear amplitude keeps quiet sections smaller without display renormalization', () => {
    const result = renderOverviewRGBA(wave([...Array(16).fill(25), ...Array(16).fill(255)], undefined, [255, 0, 0], 100), 32, 80, 'frequency');
    const quiet = extent(result, 32, 80, 5), loud = extent(result, 32, 80, 25);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(loud / 5);
    expect(loud).toBe(60);
  });
  test('instant rise and bounded release retain a falloff without preceding the attack', () => {
    const levels = [...Array(20).fill(0), ...Array(3).fill(255), ...Array(57).fill(0)];
    const result = renderOverviewRGBA(wave(levels, undefined, [255, 0, 0], .08), 80, 80, 'frequency');
    expect(extent(result, 80, 80, 17)).toBe(0);
    expect(extent(result, 80, 80, 20)).toBe(60);
    expect(extent(result, 80, 80, 25)).toBeGreaterThan(0);
    expect(extent(result, 80, 80, 25)).toBeLessThan(60);
    expect(extent(result, 80, 80, 79)).toBeLessThan(extent(result, 80, 80, 25));
  });
  test('detail gray and low-brightness quantization never invent a saturated hue', () => {
    for (const rgb of [[51, 51, 51], [52, 51, 50], [0, 0, 0]] as [number, number, number][]) {
      for (const palette of ['theme', 'frequency'] as const) {
        const result = renderOverviewRGBA(wave(Array(4).fill(80), undefined, rgb), 20, 40, palette);
        const [r, g, b] = pixel(result, 20, 10, 19);
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
      }
    }
  });
  test('known detail gray blend recovers chroma with energy-dependent overview brightness', () => {
    const result = renderOverviewRGBA(wave(Array(8).fill(128), undefined, [153, 26, 26]), 8, 60, 'frequency');
    const [r, g, b] = pixel(result, 8, 4, 29);
    expect(r - g).toBeGreaterThan(80);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    expect(r).toBeLessThan(220);
  });
  test('mirrored geometry and center glow stay within all requested dimensions', () => {
    for (const height of [1, 2, 3, 39, 40, 512]) {
      const result = renderOverviewRGBA(wave([90, 255, 80]), 7, height, 'frequency');
      expect(result.length).toBe(7 * height * 4);
      for (let x = 0; x < 7; x++) for (let y = 0; y < height; y++) {
        expect(pixel(result, 7, x, y)).toEqual(pixel(result, 7, x, height - 1 - y));
      }
    }
  });
  test('canvas allocation rejects invalid or excessive dimensions', () => {
    for (const [width, height] of [[0, 40], [-1, 40], [NaN, 40], [Infinity, 40], [4097, 40], [80, 513], [80.5, 40]]) {
      expect(() => renderOverviewRGBA(wave([255]), width, height, 'frequency')).toThrow();
    }
  });
});

describe('bounded overview preprocessing cache', () => {
  test('resize and palette changes reuse one scan of immutable detail bytes', () => {
    const input = wave(Array(9001).fill(120));
    let reads = 0;
    const observed = (bytes: Uint8Array) => new Proxy(bytes, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, target);
      },
    });
    for (const name of ['rms', 'peak', 'red', 'green', 'blue'] as const) input[name] = observed(input[name]);
    renderOverviewRGBA(input, 64, 40, 'frequency');
    const firstScan = reads;
    expect(firstScan).toBeGreaterThan(input.frames);
    renderOverviewRGBA(input, 200, 80, 'theme');
    renderOverviewRGBA(input, 80, 30, 'frequency');
    expect(reads).toBe(firstScan);
  });
  test('a new detail object and source digest rebuild the spectral summary', () => {
    const input = wave(Array(9001).fill(160));
    const red = renderOverviewRGBA(input, 80, 40, 'frequency');
    const next = { ...input, digestHex: 'new-source-revision', red: new Uint8Array(input.frames),
      blue: new Uint8Array(input.frames).fill(255) };
    const blue = renderOverviewRGBA(next, 80, 40, 'frequency');
    expect(pixel(red, 80, 40, 19)[0]).toBeGreaterThan(pixel(red, 80, 40, 19)[2] + 70);
    expect(pixel(blue, 80, 40, 19)[2]).toBeGreaterThan(pixel(blue, 80, 40, 19)[0] + 70);
  });
  test('4096-bin reduction preserves first, isolated middle and last peak maxima', () => {
    const levels = Array(20003).fill(0), peaks = [...levels];
    for (const index of [0, 10001, 20002]) { levels[index] = 20; peaks[index] = 255; }
    const input = wave(levels, peaks, [255, 0, 0], 480);
    const result = renderOverviewRGBA(input, 128, 80, 'frequency');
    expect(extent(result, 128, 80, 0)).toBe(60);
    expect(extent(result, 128, 80, 64)).toBe(60);
    expect(extent(result, 128, 80, 127)).toBe(60);
  });
  test('large constant input retains the same linear dynamics and colour after reduction', () => {
    const short = renderOverviewRGBA(wave(Array(32).fill(100), undefined, [153, 26, 26], 480), 32, 64, 'frequency');
    const long = renderOverviewRGBA(wave(Array(32003).fill(100), undefined, [153, 26, 26], 480), 32, 64, 'frequency');
    expect(long).toEqual(short);
  });
});
