import { beatsInRange, type BeatGrid } from "./beatGrid";
import type { DetailWaveform } from "./detailWaveform";
import type { DensityTile } from "./waveformDensity";
import { PHRASE_BARS } from "./gridStyle";
import { isPhraseTime } from "./trackStructure";
import { hostDelaySeconds } from "./hostDelay";
import { waveformColor, type WavePaletteId } from "./wavePalette";

export const ZOOM_MIN_BARS = 2;
export const ZOOM_MAX_BARS = 32;
export const ZOOM_DEFAULT_BARS = 8;
export const TILE_WIDTH_PX = 2048;
export const TILE_BYTE_CEILING = 32 * 1024 * 1024;
/** Shift the drawn position back by outputLatency x rate (source seconds). Off until the live check shows it is needed. */
export const COMPENSATE_OUTPUT_LATENCY = false;

export const clampZoom = (bars: number) =>
  Number.isNaN(bars) ? ZOOM_DEFAULT_BARS : Math.max(ZOOM_MIN_BARS, Math.min(ZOOM_MAX_BARS, bars));

/** Wheel / pinch (ctrl+wheel) zoom: scrolling down widens the view. */
export const zoomByWheel = (bars: number, deltaY: number) => clampZoom(bars * Math.exp(deltaY * 0.002));

/**
 * Source pixels per second. The window is `bars` bars of the deck's pitched tempo, so its source span is
 * bars*240/bpm whatever the rate (bpm*rate cancels): beat spacing is the same on beatmatched decks and
 * bending only changes how fast the tiles scroll, never their scale.
 */
export const viewPxPerSec = (widthCss: number, bars: number, bpm: number) =>
  widthCss * (Number.isFinite(bpm) && bpm > 0 ? bpm : 120) / (bars * 240);

/** Position to draw: the media's own currentTime, optionally minus the output latency in source-time units. */
export function displayPosition(currentTime: number, outputLatency: number, rate: number, compensate = COMPENSATE_OUTPUT_LATENCY): number {
  if (!compensate || !Number.isFinite(outputLatency) || outputLatency <= 0) return currentTime;
  return currentTime - outputLatency * (Number.isFinite(rate) && rate > 0 ? rate : 1);
}

/**
 * Per-lane shift of the drawn position by the master host's delay (`delayAt`, seconds), so the waveform shows what is heard.
 * Cueing, no media or no host: 0 at once. The first call (a remount mid-play) starts at the delay; otherwise the shift grows
 * only by the media's own advance (after Play the waveform holds still until the sound starts, never stepping back) and a
 * lower delay applies at once (`hostDelay` slews falls). Only the visuals use it: audio, sync and the clocks read the media.
 */
export function createVisualShift(delayAt: (nowMs: number) => number = hostDelaySeconds) {
  let shift = 0;
  let last: number | null = null;
  let first = true;
  return <P extends { position: number; rate: number; cueing?: boolean }>(p: P | null, nowMs: number): P | null => {
    const target = delayAt(nowMs);
    const rate = p && Number.isFinite(p.rate) && p.rate > 0 ? p.rate : 1;
    if (!p || p.cueing || !(target > 0)) shift = 0;
    else if (first) shift = target;
    else shift = Math.min(target, shift + (last == null ? 0 : Math.max(0, (p.position - last) / rate)));
    first = false;
    last = p ? p.position : null;
    return p && shift > 0 ? { ...p, position: Math.max(0, p.position - shift * rate) } : p;
  };
}

/** Tiles are rasterised at a density snapped to half-octave steps; drawImage x-scales to the exact view density. */
export const tileDensity = (pxPerSecView: number) => 2 ** (Math.round(Math.log2(Math.max(1e-3, pxPerSecView)) * 2) / 2);
export const drawScale = (pxPerSecView: number, tilePxPerSec: number) => pxPerSecView / tilePxPerSec;
export const tileSeconds = (tilePxPerSec: number) => TILE_WIDTH_PX / tilePxPerSec;

/** Inclusive tile index range covering the view plus one neighbour either side (clamped to the track). */
export function tilesNeeded(position: number, halfSpanSec: number, tileSec: number, duration: number): { visible: [number, number]; keep: [number, number] } {
  const last = Math.max(0, Math.ceil(duration / tileSec) - 1);
  const lo = Math.max(0, Math.min(last, Math.floor((position - halfSpanSec) / tileSec)));
  const hi = Math.max(0, Math.min(last, Math.floor((position + halfSpanSec) / tileSec)));
  return { visible: [lo, hi], keep: [Math.max(0, lo - 1), Math.min(last, hi + 1)] };
}

/** Destination rectangle of a tile in device pixels; neighbours share rounded edges so there are no seams. */
export function tileDest(index: number, tileSec: number, position: number, centreDevX: number, pxPerSecDev: number): { x: number; w: number } {
  const x0 = timeColumn(index * tileSec, position, centreDevX, pxPerSecDev);
  const x1 = timeColumn((index + 1) * tileSec, position, centreDevX, pxPerSecDev);
  return { x: x0, w: x1 - x0 };
}

/** The device-pixel column a track time is drawn in: tiles, beat lines, cues and the on-beat check all use it. */
export const timeColumn = (time: number, position: number, centreDevX: number, pxPerSecDev: number) =>
  Math.round(centreDevX + (time - position) * pxPerSecDev);

/** True when a beat line is drawn in the playhead's own column, so exactly one drawn position per beat counts. */
export const isOnBeat = (grid: BeatGrid, position: number, centreDevX: number, pxPerSecDev: number) =>
  beatsInRange(grid, position - 1 / pxPerSecDev, position + 1 / pxPerSecDev)
    .some(b => timeColumn(b.time, position, centreDevX, pxPerSecDev) === centreDevX);

export const tileBytes = (widthPx: number, heightPx: number) => widthPx * heightPx * 4;

/** Keys to evict, least recently used first (Map order), never touching `protectedKeys`, until the total fits the ceiling. */
export function evictLru(entries: ReadonlyMap<string, { bytes: number }>, protectedKeys: ReadonlySet<string>, ceiling = TILE_BYTE_CEILING): string[] {
  let total = 0;
  for (const e of entries.values()) total += e.bytes;
  const out: string[] = [];
  for (const [key, e] of entries) {
    if (total <= ceiling) break;
    if (protectedKeys.has(key)) continue;
    out.push(key);
    total -= e.bytes;
  }
  return out;
}

/**
 * [RMS, peak, red, green, blue] for [t0,t1), in linear Uint8 units.
 * Combine RMS via mean square and peaks via max. Average complete RGB samples so
 * separate transients cannot manufacture a saturated colour from channel maxima.
 */
export function sampleBands(w: DetailWaveform, t0: number, t1: number, out: number[] = [0, 0, 0, 0, 0]): number[] {
  out.fill(0);
  if (t1 < 0 || t0 >= w.duration || !w.frames) return out;
  const f0 = (t0 * w.sampleRate - w.win / 2) / w.hop;
  const f1 = (t1 * w.sampleRate - w.win / 2) / w.hop;
  let lo: number, hi: number;
  if (f1 - f0 < 1) {
    lo = hi = Math.max(0, Math.min(w.frames - 1, Math.floor((f0 + f1) / 2 + 0.5)));
  } else {
    lo = Math.max(0, Math.ceil(f0));
    hi = Math.min(w.frames - 1, Math.ceil(f1) - 1);
    // A zero-padded partial final block may have its nominal centre past duration.
    if (t1 >= w.duration) hi = w.frames - 1;
  }
  if (hi < lo) return out;
  for (let i = lo; i <= hi; i++) {
    out[0] += w.rms[i] * w.rms[i];
    out[1] = Math.max(out[1], w.peak[i]);
    out[2] += w.red[i]; out[3] += w.green[i]; out[4] += w.blue[i];
  }
  const count = hi - lo + 1;
  out[0] = Math.sqrt(out[0] / count);
  out[2] /= count; out[3] /= count; out[4] /= count;
  return out;
}

/** What every cached lane tile of one (track, detail revision, palette) starts with: a late tile of another palette never lands. */
export const tileKeyPrefix = (trackId: number, detailDigest: string, palette: WavePaletteId) => `${trackId}:${detailDigest}:${palette}:`;
/** A lane tile's cache key. The palette (with the app theme in it for CrateMind's colours) is part of it, so a switch never shows the other palette's tiles. */
export const tileKey = (trackId: number, detailDigest: string, palette: WavePaletteId, density: number, height: number, dpr: number, index: number) =>
  `${tileKeyPrefix(trackId, detailDigest, palette)}${density}:${height}:${dpr}:${index}`;

/** Colour an actual signed-PCM density tile. ImageData takes straight RGB, not premultiplied RGB. */
export function renderDensityTileRGBA(w: DetailWaveform, density: DensityTile, palette: WavePaletteId = "frequency"): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, startSeconds, pixelsPerSecond, alpha } = density;
  const px = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const column = [0, 0, 0, 0, 0], rgb: [number, number, number] = [0, 0, 0];
  for (let x = 0; x < width; x++) {
    const t = Math.min(startSeconds + x / pixelsPerSecond, Math.max(0, w.duration - 1e-9));
    sampleBands(w, t, Math.min(t + 1 / pixelsPerSecond, w.duration), column);
    const [r, g, b] = waveformColor(column[2], column[3], column[4], palette, rgb);
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (!alpha[i]) continue;
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = alpha[i];
    }
  }
  return px;
}

/** Every bar is numbered when a bar is at least 34 px wide; zoomed out, only phrase starts are. (px per bar = lane width / bars, whatever the BPM.) */
export const barLabelEvery = (laneWidthCss: number, zoomBars: number) => laneWidthCss / clampZoom(zoomBars) >= 34 ? 1 : PHRASE_BARS;

/** Bar 1, 5, 9, …: the first bar of each phrase. */
export const isPhraseBar = (bar: number | null) => bar != null && (bar - 1) % PHRASE_BARS === 0;
/** How far (seconds) a downbeat may sit from a measured phrase line and still be it: far under a sixteenth at any tempo. */
const PHRASE_TOLERANCE_S = 0.02;
/**
 * Whether the downbeat at `time` gets the heavy phrase line. A grid with measured phrase lines uses them (8 bars apart,
 * counted from where the bass comes in); a phrase line that is not on a downbeat of the deck's grid is not drawn at
 * all. Without them: every PHRASE_BARS bars from bar 1.
 */
export const isPhraseDownbeat = (phrases: readonly number[] | undefined, time: number, bar: number | null) =>
  phrases ? isPhraseTime(phrases, time, PHRASE_TOLERANCE_S) : isPhraseBar(bar);

/** A bar number is skipped where the deck chip (left 32 px), the playhead caps (centre ±8 px) or the downbeat overlay would cover it. */
export function barLabelVisible(left: number, width: number, laneWidth: number, overlayLeft: number | null): boolean {
  const mid = laneWidth / 2;
  if (left < 32 || (left < mid + 8 && left + width > mid - 8)) return false;
  return overlayLeft == null || left + width <= overlayLeft - 4;
}
