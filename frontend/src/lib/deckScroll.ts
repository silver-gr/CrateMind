import type { DetailWaveform } from "./detailWaveform";

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
export const viewPxPerSec = (widthCss: number, bars: number, bpm: number) => widthCss * bpm / (bars * 240);

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

/** [full, low, mid, high] (0..255) over [t0, t1]: the max across the frames it spans, interpolated when narrower than a frame. */
export function sampleBands(w: DetailWaveform, t0: number, t1: number, out: number[] = [0, 0, 0, 0]): number[] {
  const bands = [w.full, w.low, w.mid, w.high];
  const f0 = (t0 * w.sampleRate - w.win / 2) / w.hop;
  const f1 = (t1 * w.sampleRate - w.win / 2) / w.hop;
  for (let b = 0; b < 4; b++) {
    const a = bands[b];
    if (f1 < 0 || f0 > w.frames - 1) { out[b] = 0; continue; }
    if (f1 - f0 < 1) {
      const f = Math.max(0, Math.min(w.frames - 1, (f0 + f1) / 2));
      const i = Math.floor(f);
      const j = Math.min(w.frames - 1, i + 1);
      out[b] = a[i] + (a[j] - a[i]) * (f - i);
    } else {
      let m = 0;
      for (let i = Math.max(0, Math.ceil(f0)); i <= Math.min(w.frames - 1, Math.floor(f1)); i++) if (a[i] > m) m = a[i];
      out[b] = m;
    }
  }
  return out;
}

/**
 * RGBA pixels of one tile (width x height, mirrored about the middle). Height follows the full band; colour is
 * R = low, G = mid, B = high, scaled so the strongest band is saturated. Tile `index` starts at index*tileSec.
 */
/** `frequency`: djay-style R/G/B = low/mid/high. `theme`: the Night Void palette, violet lows through indigo mids to cyan highs. */
export type WaveformPalette = "theme" | "frequency";
const THEME_LOW = [168, 85, 247], THEME_MID = [118, 128, 250], THEME_HIGH = [34, 211, 238];

export function renderTileRGBA(w: DetailWaveform, index: number, tilePxPerSec: number, width: number, height: number, palette: WaveformPalette = "frequency"): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const start = index * (width / tilePxPerSec);
  const mid = height / 2;
  const bands = [0, 0, 0, 0];
  for (let x = 0; x < width; x++) {
    sampleBands(w, start + x / tilePxPerSec, start + (x + 1) / tilePxPerSec, bands);
    const half = Math.round((bands[0] / 255) * mid);
    if (half <= 0) continue;
    let r: number, g: number, b: number;
    if (palette === "theme") {
      const sum = Math.max(bands[1] + bands[2] + bands[3], 1);
      const [l, m, h] = [bands[1] / sum, bands[2] / sum, bands[3] / sum];
      r = l * THEME_LOW[0] + m * THEME_MID[0] + h * THEME_HIGH[0];
      g = l * THEME_LOW[1] + m * THEME_MID[1] + h * THEME_HIGH[1];
      b = l * THEME_LOW[2] + m * THEME_MID[2] + h * THEME_HIGH[2];
    } else {
      const peak = Math.max(bands[1], bands[2], bands[3], 1);
      r = (bands[1] / peak) * 255; g = (bands[2] / peak) * 255; b = (bands[3] / peak) * 255;
    }
    for (let y = Math.max(0, Math.floor(mid - half)); y < Math.min(height, Math.ceil(mid + half)); y++) {
      const o = (y * width + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  return px;
}
