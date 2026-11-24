import { describe, expect, test } from 'bun:test';
import { barLabelEvery, barLabelVisible, clampZoom, createVisualShift, displayPosition, isOnBeat, isPhraseBar, isPhraseDownbeat, drawScale, evictLru, sampleBands, tileBytes, timeColumn, tileDensity, tileDest, tileSeconds, tilesNeeded, viewPxPerSec, zoomByWheel, TILE_WIDTH_PX } from '../src/lib/deckScroll';
import { combinedPlayerHeight, deckViewHeight, deckViewMode, getDeckSlots, setDeckView, DECK_BAR_HEIGHT } from '../src/lib/deckView';
import type { BeatGrid } from '../src/lib/beatGrid';
import type { DetailWaveform } from '../src/lib/detailWaveform';
import { readFileSync } from 'node:fs';

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

describe('host delay visual shift', () => {
  const play = (position: number, rate = 1, cueing = false) => ({ position, rate, cueing });
  const shifter = (delay: { s: number }) => createVisualShift(() => delay.s);

  test('after Play the waveform holds still until the sound starts, then follows without stepping back', () => {
    const d = { s: 0.15 };
    const shift = shifter(d);
    expect(shift(play(10, 1, true), 0)?.position).toBe(10); // paused: no shift
    // A long first frame with a small media advance: the drawn position stays put.
    expect(shift(play(10.02), 400)?.position).toBeCloseTo(10);
    let drawn = 10;
    for (let i = 1; i <= 20; i++) {
      const p = shift(play(10.02 + i * 0.016), 400 + i * 16)!.position;
      expect(p).toBeGreaterThanOrEqual(drawn - 1e-9);
      drawn = p;
    }
    // Past the delay it trails the media by exactly the delay.
    expect(drawn).toBeCloseTo(10.02 + 20 * 0.016 - 0.15);
  });

  test('a remount mid-play starts at the delay', () => {
    const shift = shifter({ s: 0.1 });
    expect(shift(play(30), 0)?.position).toBeCloseTo(29.9);
  });

  test('a seek forward reaches the delay at once; a lower delay applies at once', () => {
    const d = { s: 0.1 };
    const shift = shifter(d);
    shift(play(5, 1, true), 0);
    expect(shift(play(5), 16)?.position).toBe(5);
    expect(shift(play(60), 32)?.position).toBeCloseTo(59.9);
    d.s = 0.04;
    expect(shift(play(60.016), 48)?.position).toBeCloseTo(59.976);
  });

  test('cueing and a stopped host snap the shift to 0', () => {
    const d = { s: 0.1 };
    const shift = shifter(d);
    expect(shift(play(20), 0)?.position).toBeCloseTo(19.9);
    expect(shift(play(20.016, 1, true), 16)?.position).toBe(20.016);
    expect(shift(play(20.032), 32)?.position).toBeCloseTo(20.016); // Play again: holds still, the shift grows from 0
    d.s = 0;
    const p = play(25);
    expect(shift(p, 48)).toBe(p);
    expect(shift(null, 64)).toBeNull();
  });

  test('the shift is in source time: delay x rate (rate <= 0 counts as 1); never before 0', () => {
    expect(createVisualShift(() => 0.1)(play(10, 1.1), 0)?.position).toBeCloseTo(10 - 0.11);
    expect(createVisualShift(() => 0.1)(play(10, 0), 0)?.position).toBeCloseTo(9.9);
    expect(createVisualShift(() => 0.1)(play(0.05), 0)?.position).toBe(0);
    // Held still on Play at rate 1.1: media advance / rate grows the shift.
    const shift = createVisualShift(() => 0.1);
    shift(play(10, 1.1, true), 0);
    expect(shift(play(10.055, 1.1), 16)?.position).toBeCloseTo(10);
  });

  test('the deck waveform shifts every reading of its playback, and the live ref keeps no braces', () => {
    const wave = readFileSync(new URL('../src/components/DeckScrollWaveform.tsx', import.meta.url), 'utf8');
    expect(wave).toContain('const [shift] = useState(() => createVisualShift());');
    expect(wave).toContain('getPlayback: () => shift(getPlayback(), performance.now()),');
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
  test('on beat only when the beat line falls in the playhead\'s own pixel column: one step per beat, at any width, zoom and offset', () => {
    const period = 60 / 188;
    const grid: BeatGrid = { kind: 'straight', anchor: 0.0137, period, estimated: false, overridden: false };
    for (const pxDev of [60, 117.3, 500]) for (const cx of [800, 801]) for (const offset of [0, 0.31, 0.77]) {
      const start = 100 + offset / pxDev;
      const beats = new Map<number, number>();
      for (let px = 0; px < 10 * period * pxDev; px++) {
        const position = start + px / pxDev;
        if (!isOnBeat(grid, position, cx, pxDev)) continue;
        const nearest = Math.round((position - grid.anchor) / period);
        expect(timeColumn(grid.anchor + nearest * period, position, cx, pxDev)).toBe(cx);
        beats.set(nearest, (beats.get(nearest) ?? 0) + 1);
      }
      expect(beats.size).toBeGreaterThanOrEqual(9);
      expect([...beats.values()].every(n => n === 1)).toBe(true);
    }
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
  test('full = both lanes stacked + the control bar; headers-only keeps the bar; hidden is 0', () => {
    expect(deckViewHeight('full', 72)).toBe(DECK_BAR_HEIGHT + 144);
    expect(deckViewHeight('full', 72)).toBe(166);
    expect(deckViewHeight('headers', 72)).toBe(DECK_BAR_HEIGHT);
    expect(DECK_BAR_HEIGHT).toBe(22);
    expect(deckViewHeight('hidden', 72)).toBe(0);
  });
  test('the combined height feeds the CSS variable and the Toaster offset', () => {
    expect(combinedPlayerHeight(240, deckViewHeight('full', 72))).toBe(406);
    expect(combinedPlayerHeight(240, 0)).toBe(240);
  });
  test('short windows collapse to the bar, then hide', () => {
    expect(deckViewMode(1100, 240, 72)).toBe('full');
    expect(deckViewMode(700, 240, 72)).toBe('full');
    expect(deckViewMode(600, 240, 72)).toBe('headers');
    expect(deckViewMode(520, 240, 72)).toBe('headers');
    expect(deckViewMode(500, 240, 72)).toBe('hidden');
    expect(deckViewMode(700, 240, 128)).toBe('headers');
  });
});

describe('bar labels', () => {
  test('every bar is numbered while a bar is at least 34 px wide; zoomed out, only phrase starts', () => {
    expect(barLabelEvery(1280, 8)).toBe(1);
    expect(barLabelEvery(1000, 32)).toBe(4);
    expect(barLabelEvery(1088, 32)).toBe(1);
  });
  test('phrase bars are 1, 5, 9, ...', () => {
    expect(isPhraseBar(1)).toBe(true);
    expect(isPhraseBar(5)).toBe(true);
    expect(isPhraseBar(9)).toBe(true);
    expect(isPhraseBar(2)).toBe(false);
    expect(isPhraseBar(null)).toBe(false);
    // Measured phrase lines replace the count: a downbeat is a phrase line only where one was measured.
    expect(isPhraseDownbeat([13.964, 27.679], 13.97, 2)).toBe(true);
    expect(isPhraseDownbeat([13.964, 27.679], 1.0, 1)).toBe(false);
    expect(isPhraseDownbeat([], 1.0, 1)).toBe(false);
    expect(isPhraseDownbeat(undefined, 1.0, 1)).toBe(true);
  });
  test('labels under the deck chip, the playhead caps or the downbeat overlay are skipped', () => {
    expect(barLabelVisible(20, 14, 1280, null)).toBe(false);
    expect(barLabelVisible(636, 14, 1280, null)).toBe(false);
    expect(barLabelVisible(300, 14, 1280, 1100)).toBe(true);
    expect(barLabelVisible(1090, 14, 1280, 1100)).toBe(false);
  });
});

describe('deck view store', () => {
  const el = (name: string) => ({ name }) as unknown as HTMLElement;
  const reset = () => setDeckView({ waveA: null, waveB: null, mode: 'hidden' });
  test('each deck sees its own lane slot', () => {
    const elA = el('waveA');
    setDeckView({ waveA: elA, mode: 'full' });
    expect(getDeckSlots('A')).toEqual({ wave: elA, mode: 'full' });
    reset();
  });
  test("a change to deck A's slots keeps deck B's snapshot identity", () => {
    setDeckView({ waveA: el('a1'), mode: 'full' });
    const b = getDeckSlots('B');
    setDeckView({ waveA: el('a3') });
    expect(getDeckSlots('B')).toBe(b);
    reset();
  });
  test('an identical patch keeps both identities', () => {
    const w = el('w');
    setDeckView({ waveA: w, mode: 'full' });
    const a = getDeckSlots('A'), b = getDeckSlots('B');
    setDeckView({ waveA: w, mode: 'full' });
    expect(getDeckSlots('A')).toBe(a);
    expect(getDeckSlots('B')).toBe(b);
    reset();
  });
});
