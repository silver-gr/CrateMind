import { describe, expect, test } from 'bun:test';
import { waveformColor } from '../src/lib/deckScroll';

describe('spectral palette separation', () => {
  test('theme keeps distinct warm lows, green mids and blue highs', () => {
    const low = waveformColor(255, 0, 0, 'theme');
    const mid = waveformColor(0, 255, 40, 'theme');
    const high = waveformColor(0, 0, 255, 'theme');
    expect(low[0]).toBe(255); expect(low[1]).toBeLessThan(50);
    expect(mid[1]).toBe(255); expect(mid[0]).toBeLessThan(130); expect(mid[2]).toBeLessThan(130);
    expect(high[2]).toBe(255); expect(high[0]).toBeLessThan(130);
    const warm = waveformColor(255, 190, 0, 'theme');
    expect(warm[0]).toBeGreaterThan(220); expect(warm[1]).toBeGreaterThan(150); expect(warm[2]).toBeLessThan(40);
  });
  test('frequency colours remain measured RGB; quiet and neutral levels are not amplified', () => {
    for (const rgb of [[0, 0, 0], [51, 51, 51], [120, 80, 65], [35, 60, 100]]) {
      expect(waveformColor(rgb[0], rgb[1], rgb[2], 'frequency')).toEqual(rgb);
      const theme = waveformColor(rgb[0], rgb[1], rgb[2], 'theme');
      expect(Math.max(...theme)).toBeCloseTo(Math.max(...rgb), 6);
      expect(theme.every(x => Number.isFinite(x) && x >= 0 && x <= 255)).toBe(true);
      if (rgb[0] === rgb[1] && rgb[1] === rgb[2]) expect(theme).toEqual(rgb);
    }
  });
  test('broadband colours gain chroma rather than an added white wash', () => {
    const rgb = [200, 140, 140];
    const colour = waveformColor(rgb[0], rgb[1], rgb[2], 'theme');
    expect(Math.max(...colour)).toBe(200);
    expect(Math.max(...colour) - Math.min(...colour)).toBeGreaterThan(60);
  });
});
