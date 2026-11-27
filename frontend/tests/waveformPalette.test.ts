import { describe, expect, test } from 'bun:test';
import { renderDensityTileRGBA, tileKey, tileKeyPrefix } from '../src/lib/deckScroll';
import { renderOverviewRGBA } from '../src/lib/overviewWaveform';
import { CRATEMIND_DARK, CRATEMIND_LIGHT, fitChroma, oklchToSrgb, paletteAt, paletteColor, waveformColor, wavePaletteId, type WavePaletteId } from '../src/lib/wavePalette';
import type { DetailWaveform } from '../src/lib/detailWaveform';

/** OKLab of sRGB bytes, written here on its own so the module's conversion is checked against a second one. */
function oklab([r, g, b]: number[]): [number, number, number] {
  const lin = (x: number) => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(.4122214708 * R + .5363325363 * G + .0514459929 * B);
  const m = Math.cbrt(.2119034982 * R + .6806995451 * G + .1073969566 * B);
  const s = Math.cbrt(.0883024619 * R + .2817188376 * G + .6299787005 * B);
  return [.2104542553 * l + .7936177850 * m - .0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .8086757660 * s];
}
const hueOf = (rgb: number[]) => { const [, a, b] = oklab(rgb); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360; };
const distance = (x: number[], y: number[]) => { const a = oklab(x), b = oklab(y); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// The stored (djay model) colours of the three bands and of the two common mixes, at full level and saturation.
const LOW = [255, 0, 0], MID = [0, 255, 102], HIGH = [0, 40, 255], KICK_AND_HATS = [255, 0, 255], LOW_MID = [255, 255, 0];
const IDS: WavePaletteId[] = ['frequency', 'cratemind-dark', 'cratemind-light'];

describe('palette ids', () => {
  test('the pref and the app theme give three different ids; the frequency colours ignore the theme', () => {
    expect(wavePaletteId('theme', 'dark')).toBe('cratemind-dark');
    expect(wavePaletteId('theme', 'light')).toBe('cratemind-light');
    expect(wavePaletteId('frequency', 'dark')).toBe('frequency');
    expect(wavePaletteId('frequency', 'light')).toBe('frequency');
  });
  test('a lane tile key carries the palette id, so no two palettes share a tile', () => {
    const keys = IDS.map(id => tileKey(7, 'abc', id, 256, 200, 2, 3));
    expect(new Set(keys).size).toBe(3);
    for (const [i, id] of IDS.entries()) {
      expect(keys[i].startsWith(tileKeyPrefix(7, 'abc', id))).toBe(true);
      for (const other of IDS) if (other !== id) expect(keys[i].startsWith(tileKeyPrefix(7, 'abc', other))).toBe(false);
    }
  });
});

describe('frequency colours', () => {
  test('stay the measured RGB', () => {
    for (const rgb of [[0, 0, 0], [51, 51, 51], [120, 80, 65], [35, 60, 100], LOW, HIGH]) expect(waveformColor(rgb[0], rgb[1], rgb[2], 'frequency')).toEqual(rgb as [number, number, number]);
  });
});

describe("CrateMind's colours", () => {
  test('conversion: an OKLCH colour inside sRGB comes back as itself', () => {
    for (const [l, c, h] of [[.7, .1, 30], [.64, .2, 298], [.87, .15, 124], [.5, .05, 200]]) {
      const [L, a, b] = oklab(oklchToSrgb(l, fitChroma(l, c, h), h));
      expect(L).toBeCloseTo(l, 2);
      expect(Math.hypot(a, b)).toBeCloseTo(fitChroma(l, c, h), 2);
    }
    expect(fitChroma(.64, .4, 298)).toBeLessThan(.4);   // lowered to fit
    expect(fitChroma(.64, .05, 298)).toBe(.05);
  });
  test('each band has its own hue: violet lows, lime mids, amber highs, rose where kick and hats meet', () => {
    for (const id of ['cratemind-dark', 'cratemind-light'] as const) {
      const hue = (rgb: number[]) => hueOf(waveformColor(rgb[0], rgb[1], rgb[2], id));
      expect(hueGap(hue(LOW), 298)).toBeLessThan(12);
      expect(hueGap(hue(MID), 109)).toBeLessThan(12);
      expect(hueGap(hue(HIGH), 56)).toBeLessThan(14);
      expect(hueGap(hue(KICK_AND_HATS), 14)).toBeLessThan(14);
      const bands = [LOW, MID, HIGH, KICK_AND_HATS, LOW_MID].map(rgb => waveformColor(rgb[0], rgb[1], rgb[2], id));
      for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length; j++) expect(distance(bands[i], bands[j])).toBeGreaterThan(.12);
    }
  });
  test('differ clearly from the frequency colours, on all but two narrow stretches of the stored wheel', () => {
    // The old theme map moved real music's colours by about 0.04 (OKLab) and 7° of hue: the two settings looked the same.
    // This map runs the other way round the wheel, so it must meet the stored hue at two points (near stored 0.90 and
    // 0.26); everywhere else it is far from it.
    const stored = (hue: number) => { const h6 = (hue % 1) * 6, x = 255 * (1 - Math.abs(h6 % 2 - 1));
      return h6 < 1 ? [255, x, 0] : h6 < 2 ? [x, 255, 0] : h6 < 3 ? [0, 255, x] : h6 < 4 ? [0, x, 255] : h6 < 5 ? [x, 0, 255] : [255, 0, x]; };
    for (const id of ['cratemind-dark', 'cratemind-light'] as const) {
      let near = 0;
      for (let i = 0; i < 400; i++) {
        const from = stored(i / 400), ours = waveformColor(from[0], from[1], from[2], id);
        if (hueGap(hueOf(from), hueOf(ours)) < 25) near++;
      }
      expect(near / 400).toBeLessThan(.14);
      // The band centres: lows, mids, highs, and kick with hats.
      for (const hue of [0, .02, .4, .65, .7, .83, .97]) {
        const from = stored(hue), ours = waveformColor(from[0], from[1], from[2], id);
        expect(hueGap(hueOf(from), hueOf(ours))).toBeGreaterThan(35);
        expect(distance(from, ours)).toBeGreaterThan(.1);
      }
    }
  });
  test('the bands keep away from the deck rails and playhead (cyan 205°, green 142°) on the dark screen', () => {
    for (const rgb of [LOW, HIGH, KICK_AND_HATS]) {
      const hue = hueOf(waveformColor(rgb[0], rgb[1], rgb[2], 'cratemind-dark'));
      expect(hueGap(hue, 205)).toBeGreaterThan(60);
      expect(hueGap(hue, 142)).toBeGreaterThan(60);
    }
    expect(hueGap(hueOf(waveformColor(MID[0], MID[1], MID[2], 'cratemind-dark')), 205)).toBeGreaterThan(60);
  });
  test('the map is continuous round the hue circle and every stop fits sRGB', () => {
    for (const spec of [CRATEMIND_DARK, CRATEMIND_LIGHT]) {
      let previous = paletteColor(255, 0, 0, spec).slice();
      for (let i = 1; i <= 720; i++) {
        const h6 = (i / 720) * 6 % 6, x = 255 * (1 - Math.abs(h6 % 2 - 1));
        const rgb = h6 < 1 ? [255, x, 0] : h6 < 2 ? [x, 255, 0] : h6 < 3 ? [0, 255, x] : h6 < 4 ? [0, x, 255] : h6 < 5 ? [x, 0, 255] : [255, 0, x];
        const colour = paletteColor(rgb[0], rgb[1], rgb[2], spec);
        expect(colour.every(v => v >= 0 && v <= 255)).toBe(true);
        expect(distance(previous, colour)).toBeLessThan(.04);
        previous = colour.slice();
      }
      expect(paletteAt(spec, 0)).toEqual(paletteAt(spec, 1));
    }
  });
  test('grey stays grey, silence is the floor, and a quieter column is nearer the floor', () => {
    for (const grey of [51, 128, 255]) {
      const dark = waveformColor(grey, grey, grey, 'cratemind-dark'), light = waveformColor(grey, grey, grey, 'cratemind-light');
      expect(Math.max(...dark) - Math.min(...dark)).toBeLessThan(1e-6);
      expect(Math.max(...light) - Math.min(...light)).toBeLessThan(1e-6);
    }
    expect(waveformColor(0, 0, 0, 'cratemind-dark')).toEqual([0, 0, 0]);
    expect(waveformColor(0, 0, 0, 'cratemind-light')).toEqual([CRATEMIND_LIGHT.floor, CRATEMIND_LIGHT.floor, CRATEMIND_LIGHT.floor]);
    const lightness = (rgb: number[], id: WavePaletteId) => oklab(waveformColor(rgb[0], rgb[1], rgb[2], id))[0];
    // Dark screen: louder is lighter. Light screen: louder is deeper, quiet fades into the paper.
    expect(lightness([255, 0, 0], 'cratemind-dark')).toBeGreaterThan(lightness([100, 0, 0], 'cratemind-dark'));
    expect(lightness([255, 0, 0], 'cratemind-light')).toBeLessThan(lightness([100, 0, 0], 'cratemind-light'));
  });
  test('a broadband column keeps its hue but loses chroma', () => {
    const pure = oklab(waveformColor(255, 0, 0, 'cratemind-dark')), mixed = oklab(waveformColor(255, 150, 150, 'cratemind-dark'));
    expect(Math.hypot(mixed[1], mixed[2])).toBeLessThan(Math.hypot(pure[1], pure[2]));
    expect(Math.hypot(mixed[1], mixed[2])).toBeGreaterThan(.05);
    expect(hueGap(hueOf(waveformColor(255, 150, 150, 'cratemind-dark')), hueOf(waveformColor(255, 0, 0, 'cratemind-dark')))).toBeLessThan(10);
  });
  test('the out buffer is reused, so a tile allocates no array per column', () => {
    const out: [number, number, number] = [0, 0, 0];
    for (const id of IDS) expect(waveformColor(10, 200, 30, id, out)).toBe(out);
  });
});

describe('the three renderers draw each palette differently from the same detail waveform', () => {
  const frames = 4000;
  const detail: DetailWaveform = { sampleRate: 44100, hop: 40, win: 40, frames, duration: frames * 40 / 44100, digestHex: 'd',
    rms: new Uint8Array(frames).fill(150), peak: new Uint8Array(frames).fill(220),
    red: new Uint8Array(frames).fill(255), green: new Uint8Array(frames).fill(20), blue: new Uint8Array(frames).fill(40) } as DetailWaveform;
  test('lane tiles', () => {
    const tile = { width: 8, height: 4, startSeconds: 0, pixelsPerSecond: 64, dpr: 1, alpha: new Uint8Array(32).fill(200) };
    const [f, d, l] = IDS.map(id => Array.from(renderDensityTileRGBA(detail, tile as never, id).slice(0, 4)));
    expect(f).toEqual([255, 20, 40, 200]);
    expect(distance(f, d)).toBeGreaterThan(.1); expect(distance(f, l)).toBeGreaterThan(.1); expect(distance(d, l)).toBeGreaterThan(.1);
    expect(d[3]).toBe(200); expect(l[3]).toBe(200);
  });
  test('overviews', () => {
    const centre = (id: WavePaletteId) => { const px = renderOverviewRGBA(detail, 40, 40, id), i = (19 * 40 + 20) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const [f, d, l] = IDS.map(centre);
    expect(distance(f, d)).toBeGreaterThan(.08); expect(distance(f, l)).toBeGreaterThan(.08); expect(distance(d, l)).toBeGreaterThan(.08);
  });
});
