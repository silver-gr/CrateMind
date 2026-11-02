import type { DetailWaveform } from "./detailWaveform";
import type { DensityTile } from "./waveformDensity";

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
  const x0 = Math.round(centreDevX + (index * tileSec - position) * pxPerSecDev);
  const x1 = Math.round(centreDevX + ((index + 1) * tileSec - position) * pxPerSecDev);
  return { x: x0, w: x1 - x0 };
}

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

export type WaveformPalette = "theme" | "frequency";
// App theme hues. This remapping is CrateMind design, not part of djay's colour algorithm.
const THEME_STOPS = [[252, 91, 209], [179, 123, 255], [65, 161, 255], [0, 224, 245]];

/** Remap spectral hue to the theme while preserving analysed value and saturation. */
function themeColor(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta < 1e-6) return [r, g, b];
  let hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = ((hue / 6) % 1 + 1) % 1;
  // The lowest filter wraps just below red (.99); it belongs at the magenta end.
  const t = hue > 5 / 6 ? 0 : Math.min(1, hue / (2 / 3));
  const position = t * 3, index = Math.min(2, Math.floor(position)), mix = position - index;
  const saturation = delta / max, value = max / 255;
  return [0, 1, 2].map(ch => {
    const themed = THEME_STOPS[index][ch] * (1 - mix) + THEME_STOPS[index + 1][ch] * mix;
    return value * (255 * (1 - saturation) + themed * saturation);
  }) as [number, number, number];
}

/** Colour an actual signed-PCM density tile. ImageData takes straight RGB, not premultiplied RGB. */
export function renderDensityTileRGBA(w: DetailWaveform, density: DensityTile, palette: WaveformPalette = "frequency"): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, startSeconds, pixelsPerSecond, alpha } = density;
  const px = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const column = [0, 0, 0, 0, 0];
  for (let x = 0; x < width; x++) {
    const t = Math.min(startSeconds + x / pixelsPerSecond, Math.max(0, w.duration - 1e-9));
    sampleBands(w, t, Math.min(t + 1 / pixelsPerSecond, w.duration), column);
    const [r, g, b] = palette === "theme" ? themeColor(column[2], column[3], column[4]) : column.slice(2);
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (!alpha[i]) continue;
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = alpha[i];
    }
  }
  return px;
}
