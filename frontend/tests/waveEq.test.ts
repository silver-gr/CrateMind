import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderDensityTileRGBA } from '../src/lib/deckScroll';
import type { DetailWaveform } from '../src/lib/detailWaveform';
import { LOW_KILL_START, eqDb } from '../src/lib/mixer';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { BAND_ANGLES, BAND_HUES, EQ_FLAT_KEY, GREY, LEVEL_FLOOR_DB, LEVEL_KNEE_DB, LEVEL_SPAN_DB, QUIET_LEVEL, SAT_FLOOR, SCORE_POWER, bandShares, eqColor, eqKey, eqKeyGains, eqStripRGBA, type EqGains } from '../src/lib/waveEq';
import type { WavePaletteId } from '../src/lib/wavePalette';

const TAU = 2 * Math.PI;
const FLAT: EqGains = { lo: 1, mid: 1, hi: 1 };

/** `mix_colors` and the last line of `analyze` in waveform_color.py, written again here: weights per hue, a level, bytes out. */
function stored(weights: number[], hues: readonly number[], level: number, round = true): [number, number, number] {
  let x = 0, y = 0, sum = 0;
  weights.forEach((w, k) => { x += w * Math.cos(TAU * hues[k]); y += w * Math.sin(TAU * hues[k]); sum += w; });
  const hue = ((Math.atan2(y, x) / TAU) % 1 + 1) % 1, sat = SAT_FLOOR + (1 - SAT_FLOOR) * Math.hypot(x, y) / sum;
  const sector = hue * 6, f = sector - Math.floor(sector), p = 1 - sat, q = 1 - sat * f, t = 1 - sat * (1 - f);
  const rgb = [[1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q]][Math.floor(sector) % 6];
  return rgb.map(c => { const v = 255 * (level * c + GREY * (1 - level)); return round ? Math.round(v) : v; }) as [number, number, number];
}
const BAND_HUE = BAND_ANGLES.map(a => a / TAU);
const SHARES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [.5, 0, .5], [0, .5, .5], [.6, .3, .1], [.2, .2, .6], [.1, .8, .1], [1 / 3, 1 / 3, 1 / 3], [.45, .1, .45]];

describe('the constants shared with waveform_color.py', () => {
  const py = readFileSync(new URL('../../backend/app/services/waveform_color.py', import.meta.url), 'utf8');
  const num = (s: string) => Number(s.trim());
  test('the six band hues', () => {
    const hues = /_HUES = np\.array\(\[([^\]]+)\]\)/.exec(py)![1].split(',').map(num);
    expect(hues).toEqual([...BAND_HUES]);
  });
  test('score power, saturation floor and the grey blend', () => {
    expect(num(/weights = scores \*\* ([\d.]+)/.exec(py)![1])).toBe(SCORE_POWER);
    const sat = /saturation = ([\d.]+) \+ ([\d.]+) \* np\.hypot/.exec(py)!;
    expect([num(sat[1]), num(sat[2])]).toEqual([SAT_FLOOR, 1 - SAT_FLOOR]);
    expect(num(/return level \* hue_rgb \+ ([\d.]+) \* \(1 - level\)/.exec(py)![1])).toBe(GREY);
  });
  test('the level scale: knee, floor and span in dB', () => {
    const m = /np\.where\(db < (-?[\d.]+), ([\d.]+) \* \(db \+ ([\d.]+)\) \/ ([\d.]+), ([\d.]+) \+ ([\d.]+) \* \(db \+ ([\d.]+)\) \/ ([\d.]+)\)/.exec(py)!;
    const [knee, lowGain, floor, lowSpan, base, highGain, knee2, span] = m.slice(1).map(num);
    expect(knee).toBe(LEVEL_KNEE_DB);
    expect(-floor).toBe(LEVEL_FLOOR_DB);
    expect(lowSpan).toBe(LEVEL_KNEE_DB - LEVEL_FLOOR_DB);
    expect([lowGain, base]).toEqual([GREY, GREY]);
    expect(highGain).toBeCloseTo(1 - GREY, 12);
    expect(-knee2).toBe(LEVEL_KNEE_DB);
    expect(span).toBe(LEVEL_SPAN_DB);
  });
});

describe('band shares read back from a stored colour', () => {
  test('three-direction colours stored as bytes come back within 0.03 of their shares, at any level from 0.1', () => {
    let worst = 0;
    for (const level of [.1, .2, .5, .8, 1]) for (const p of SHARES) {
      const s = bandShares(...stored(p, BAND_HUE, level));
      worst = Math.max(worst, Math.abs(s.lo - p[0]), Math.abs(s.mid - p[1]), Math.abs(s.hi - p[2]));
      expect(Math.abs(s.level - level)).toBeLessThan(.004);
    }
    expect(worst).toBeLessThan(.03);
  });
  test('unrounded, the same colours come back exactly', () => {
    for (const p of SHARES) {
      const s = bandShares(...stored(p, BAND_HUE, .7, false));
      expect(s.lo).toBeCloseTo(p[0], 9); expect(s.mid).toBeCloseTo(p[1], 9); expect(s.hi).toBeCloseTo(p[2], 9);
    }
  });
  test("the backend's six filters, folded in pairs, come back within 0.03 for an even pair, 0.1 for a 3:1 pair and 0.19 for one filter alone", () => {
    for (const [splits, tolerance] of [[[.5], .03], [[.25, .75], .1], [[0, 1], .19]] as const) folded(splits, tolerance);
  });
  function folded(splits: readonly number[], tolerance: number) {
    let worst = 0;
    for (const p of SHARES) for (const split of splits) {
      const six = [p[0] * split, p[0] * (1 - split), p[1] * split, p[1] * (1 - split), p[2] * split, p[2] * (1 - split)];
      const s = bandShares(...stored(six, BAND_HUES, .8));
      worst = Math.max(worst, Math.abs(s.lo - p[0]), Math.abs(s.mid - p[1]), Math.abs(s.hi - p[2]));
    }
    expect(worst).toBeLessThan(tolerance);
  }
  test('quiet and dark colours carry no shares', () => {
    for (const c of [[0, 0, 0], [51, 51, 51], [60, 55, 52], [NaN, 0, 0]]) expect(bandShares(c[0], c[1], c[2]).level).toBe(0);
    expect(bandShares(...stored([1, 0, 0], BAND_HUE, QUIET_LEVEL + .02)).level).toBeGreaterThan(0);
  });
});

describe('a stored colour under an EQ', () => {
  const samples = SHARES.flatMap(p => [.3, .7, 1].map(level => stored(p, BAND_HUE, level)));
  test('flat gains return the input itself; gains 0.001 % from flat stay within 0.01 of a byte, or 0.5 for a colour rounded to bytes', () => {
    const near = { lo: 1.00001, mid: .99999, hi: 1.00001 };
    for (const c of samples) {
      expect(eqColor(c[0], c[1], c[2], FLAT)).toEqual(c);
      // A rounded byte can sit just outside the model (saturation a hair over 1), which the mix puts back inside.
      const out = eqColor(c[0], c[1], c[2], near);
      for (let i = 0; i < 3; i++) expect(Math.abs(out[i] - c[i])).toBeLessThan(.5);
    }
    for (const p of SHARES) for (const level of [.3, .7, 1]) {
      const c = stored(p, BAND_HUE, level, false), out = eqColor(c[0], c[1], c[2], near);
      for (let i = 0; i < 3; i++) expect(Math.abs(out[i] - c[i])).toBeLessThan(.01);
    }
    // Colours outside the three bands' triangle (one filter alone) are continuous at flat too.
    for (let k = 0; k < 6; k++) {
      const c = stored(BAND_HUES.map((_, i) => Number(i === k)), BAND_HUES, .9, false), out = eqColor(c[0], c[1], c[2], near);
      for (let i = 0; i < 3; i++) expect(Math.abs(out[i] - c[i])).toBeLessThan(.01);
    }
  });
  test('a killed band leaves no share of itself (under 0.02) and the others keep their ratio', () => {
    for (const p of SHARES.filter(p => p.every(x => x > 0))) {
      const c = stored(p, BAND_HUE, .9);
      const s = bandShares(...eqColor(c[0], c[1], c[2], { lo: 0, mid: 1, hi: 1 }));
      expect(s.lo).toBeLessThan(.02);
      expect(s.mid / s.hi).toBeCloseTo(p[1] / p[2], 0);
    }
  });
  test('killing the only band of a column leaves the silent grey; killing a band the column lacks changes nothing', () => {
    const low = stored([1, 0, 0], BAND_HUE, 1, false);
    expect(eqColor(low[0], low[1], low[2], { lo: 0, mid: 1, hi: 1 }).map(Math.round)).toEqual([51, 51, 51]);
    // Stored as bytes the same colour keeps a trace of the other bands, so it lands within 6 of that grey.
    const bytes = stored([1, 0, 0], BAND_HUE, 1);
    for (const ch of eqColor(bytes[0], bytes[1], bytes[2], { lo: 0, mid: 1, hi: 1 })) expect(Math.abs(ch - 51)).toBeLessThan(6);
    const mid = stored([0, 1, 0], BAND_HUE, .8, false);
    for (const gains of [{ lo: 0, mid: 1, hi: 1 }, { lo: 2, mid: 1, hi: 0 }]) {
      const out = eqColor(mid[0], mid[1], mid[2], gains);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(mid[i], 6);
    }
  });
  test('a band turned down dims the column in step with its share, and never brightens it', () => {
    const value = (c: number[]) => Math.max(...c);
    const mostlyLow = stored([.8, .1, .1], BAND_HUE, .9), littleLow = stored([.1, .8, .1], BAND_HUE, .9);
    let last = Infinity;
    for (const g of [1, .7, .4, .2, .05, 0]) {
      const v = value(eqColor(mostlyLow[0], mostlyLow[1], mostlyLow[2], { lo: g, mid: 1, hi: 1 }));
      expect(v).toBeLessThanOrEqual(last + 1e-9);
      last = v;
    }
    const cut = { lo: .05, mid: 1, hi: 1 };
    expect(value(mostlyLow) - value(eqColor(mostlyLow[0], mostlyLow[1], mostlyLow[2], cut)))
      .toBeGreaterThan(3 * (value(littleLow) - value(eqColor(littleLow[0], littleLow[1], littleLow[2], cut))));
  });
  test('a +6 dB boost may brighten but never whitens: saturation does not fall below the model floor', () => {
    for (const c of samples) for (const gains of [{ lo: 2, mid: 1, hi: 1 }, { lo: 1, mid: 2, hi: 1 }, { lo: 2, mid: 2, hi: 2 }, { lo: 4, mid: 4, hi: 4 }]) {
      const out = eqColor(c[0], c[1], c[2], gains), max = Math.max(...out), min = Math.min(...out);
      expect(max).toBeLessThanOrEqual(255 + 1e-9);
      const level = (max / 255 - GREY) / (1 - GREY), before = bandShares(c[0], c[1], c[2]);
      expect((max - min) / 255 / level).toBeGreaterThan(Math.min(SAT_FLOOR, before.sat) - .02);
    }
  });
  test('every byte triple and every gain gives finite channels inside 0..255', () => {
    const steps = [0, 1, 17, 50, 51, 52, 61, 85, 128, 170, 204, 254, 255];
    const gainSets: EqGains[] = [FLAT, { lo: 0, mid: 0, hi: 0 }, { lo: 0, mid: 1, hi: 1 }, { lo: 1, mid: 0, hi: 4 }, { lo: 4, mid: 4, hi: 4 }, { lo: .05, mid: 2, hi: .3 },
      { lo: NaN, mid: 1, hi: 1 }, { lo: -1, mid: Infinity, hi: 1 }];
    for (const r of steps) for (const g of steps) for (const b of steps) for (const gains of gainSets) {
      const out = eqColor(r, g, b, gains);
      for (const ch of out) { expect(Number.isFinite(ch)).toBe(true); expect(ch).toBeGreaterThanOrEqual(0); expect(ch).toBeLessThanOrEqual(255 + 1e-9); }
    }
    // Black, a grey and the saturated primaries, with the lows killed.
    for (const c of [[0, 0, 0], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]) {
      expect(eqColor(c[0], c[1], c[2], { lo: 0, mid: 1, hi: 1 }).every(Number.isFinite)).toBe(true);
    }
    expect(eqColor(0, 0, 0, { lo: 0, mid: 0, hi: 0 })).toEqual([0, 0, 0]);   // quiet columns are left as they are
    expect(eqColor(58, 54, 52, { lo: 0, mid: 0, hi: 0 })).toEqual([58, 54, 52]);
  });
});

describe('the EQ a lane follows, as one key', () => {
  test('flat knobs are the flat key, with or without a neutral transition stage', () => {
    expect(eqKey(0, 0, 0)).toBe(EQ_FLAT_KEY);
    expect(eqKey(0, 0, 0, [0, 0, 0, 0])).toBe(EQ_FLAT_KEY);
    expect(eqKeyGains(EQ_FLAT_KEY)).toEqual(FLAT);
  });
  test('knobs map through eqDb, to a tenth of a dB', () => {
    const g = eqKeyGains(eqKey(-.5, -1, 1));
    expect(20 * Math.log10(g.lo)).toBeCloseTo(eqDb(-.5), 1);
    expect(20 * Math.log10(g.mid)).toBeCloseTo(-26, 1);
    expect(20 * Math.log10(g.hi)).toBeCloseTo(6, 1);
  });
  test('the LOW kill zone runs from the shelf gain at its start down to nothing fully left; MID and HIGH have none', () => {
    expect(20 * Math.log10(eqKeyGains(eqKey(LOW_KILL_START, 0, 0)).lo)).toBeCloseTo(eqDb(LOW_KILL_START), 1);
    const half = eqKeyGains(eqKey(-.925, 0, 0)).lo;
    expect(half).toBeLessThan(eqKeyGains(eqKey(LOW_KILL_START, 0, 0)).lo);
    expect(half).toBeGreaterThan(0);
    expect(eqKeyGains(eqKey(-1, 0, 0)).lo).toBe(0);
    expect(eqKeyGains(eqKey(0, -1, -1)).mid).toBeGreaterThan(0);
    expect(eqKeyGains(eqKey(0, -1, -1)).hi).toBeGreaterThan(0);
  });
  test("a transition stage's gains add to the knobs, and its kill cutoff removes the lows", () => {
    const g = eqKeyGains(eqKey(.5, 0, 0, [-13, -6, 0, 0]));
    expect(20 * Math.log10(g.lo)).toBeCloseTo(eqDb(.5) - 13, 1);
    expect(20 * Math.log10(g.mid)).toBeCloseTo(-6, 1);
    expect(g.hi).toBe(1);
    expect(eqKeyGains(eqKey(0, 0, 0, [-26, 0, 0, 200])).lo).toBe(0);
    expect(eqKeyGains(eqKey(0, 0, 0, [-22.1, 0, 0, 20])).lo).toBeGreaterThan(0);
    for (const stage of [[NaN, 0, 0, 0], [0, 0, 0, NaN], [-Infinity, 99, 0, 1e9]]) {
      const bad = eqKeyGains(eqKey(0, 0, 0, stage));
      for (const v of [bad.lo, bad.mid, bad.hi]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
    }
  });
  test('values a tenth of a dB apart share no key; closer ones do (no repaint for noise)', () => {
    expect(eqKey(0, 0, 0, [-.2, 0, 0, 0])).not.toBe(EQ_FLAT_KEY);
    expect(eqKey(0, 0, 0, [-.01, .02, 0, 0])).toBe(EQ_FLAT_KEY);
  });
});

describe('the colour row of a lane tile', () => {
  const frames = 64;
  const detail: DetailWaveform = {
    version: 2, sampleRate: 22050, hop: 256, win: 512, frames, duration: frames * 256 / 22050, digestHex: 'x',
    rms: new Uint8Array(frames).fill(200), peak: new Uint8Array(frames).fill(220),
    red: new Uint8Array(frames), green: new Uint8Array(frames), blue: new Uint8Array(frames),
  };
  for (let i = 0; i < frames; i++) {
    const c = i < 4 ? [51, 51, 51] : stored(SHARES[i % SHARES.length], BAND_HUE, .3 + .7 * i / frames);
    detail.red[i] = c[0]; detail.green[i] = c[1]; detail.blue[i] = c[2];
  }
  const width = 96, height = 3, pps = 140, start = .05;
  const tile = { width, height, startSeconds: start, pixelsPerSecond: pps, dpr: 1, digestHex: 'x', alpha: new Uint8Array(width * height).fill(255) };
  const IDS: WavePaletteId[] = ['frequency', 'cratemind-dark', 'cratemind-light'];

  test("with a flat EQ it is exactly the colours the tile is made with (the setting's off state), in every palette", () => {
    for (const id of IDS) {
      const rgba = renderDensityTileRGBA(detail, tile, id);
      const strip = eqStripRGBA(detail, start, pps, width, id, EQ_FLAT_KEY, new Uint8ClampedArray(width * 4));
      for (let y = 0; y < height; y++) expect(Array.from(rgba.subarray(y * width * 4, (y + 1) * width * 4))).toEqual(Array.from(strip));
    }
  });
  test('with the lows killed, columns with lows change and quiet columns do not', () => {
    const flat = eqStripRGBA(detail, start, pps, width, 'frequency', EQ_FLAT_KEY, new Uint8ClampedArray(width * 4));
    const cut = eqStripRGBA(detail, start, pps, width, 'frequency', eqKey(-1, 0, 0), new Uint8ClampedArray(width * 4));
    let changed = 0;
    for (let x = 0; x < width; x++) {
      const same = [0, 1, 2].every(c => flat[x * 4 + c] === cut[x * 4 + c]);
      const t = start + x / pps, quiet = (t + 1 / pps) * 22050 / 256 < 3;
      if (quiet) expect(same).toBe(true);
      if (!same) changed++;
      expect(cut[x * 4 + 3]).toBe(255);
    }
    expect(changed).toBeGreaterThan(width / 2);
  });
});

describe('the setting is off by default and the lane keeps its own path', () => {
  const lane = readFileSync(new URL('../src/components/DeckScrollWaveform.tsx', import.meta.url), 'utf8');
  test('off by default', () => { expect(DEFAULT_PREFS.waveformFollowEq).toBe(false); });
  test('tiles are still coloured by renderDensityTileRGBA; the EQ is read and tiles marked only with the setting on', () => {
    expect(lane).toContain('renderDensityTileRGBA(L.detail, density, L.palette)');
    expect(lane).toContain('eqDeck: followEq ? eqDeck : undefined');
    expect(lane).toContain('if (L.eqDeck) tile.eq =');
    expect(lane).toContain('} else eqLane.current.key = null;');
    expect(lane).toContain('if (tile.eq && eq !== null && tile.eq.key !== eq)');
    expect(lane.match(/laneEqKey\(/g)!.length).toBe(1);
    expect(lane.match(/recolourTile\(/g)!.length).toBe(1);
  });
  test('the tile key does not know the setting', () => {
    expect(readFileSync(new URL('../src/lib/deckScroll.ts', import.meta.url), 'utf8')).not.toContain('waveEq');
  });
});
