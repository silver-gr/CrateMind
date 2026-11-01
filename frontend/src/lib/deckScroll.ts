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

interface Stats { fullRef: number; bandRef: [number, number, number] }
const statsCache = new WeakMap<DetailWaveform, Stats>();

/** p99.5 of a 0..255 array from a 256-bin histogram (cheap, no sort). */
function p995(a: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < a.length; i++) hist[a[i]]++;
  const need = Math.ceil(a.length * 0.995);
  let cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= need) return v; }
  return 255;
}

/**
 * Per-track references, memoised per waveform. `fullRef` is the linear-domain (squared) p99.5 of `full`; `bandRef` is each
 * band's p99.5 in stored units, floored at 10% of the full reference (and 1) so leakage in quiet or band-sparse material
 * is not stretched into false full colour.
 */
function trackStats(w: DetailWaveform): Stats {
  let st = statsCache.get(w);
  if (st) return st;
  let refFull = p995(w.full);
  if (refFull === 0) for (let i = 0; i < w.full.length; i++) if (w.full[i] > refFull) refFull = w.full[i];
  refFull = Math.max(refFull, 1);
  const floor = Math.max(0.1 * refFull, 1);
  st = {
    fullRef: (refFull / 255) ** 2,
    bandRef: [Math.max(p995(w.low), floor), Math.max(p995(w.mid), floor), Math.max(p995(w.high), floor)],
  };
  statsCache.set(w, st);
  return st;
}

/**
 * [full, low, mid, high, fullLinearMean] over [t0, t1). Bands are 0..255 stored units; the 5th value is 0..1.
 * A column narrower than a frame takes the nearest frame (no interpolation, so step edges stay crisp). A wider column
 * spans the frames `f0 <= i < f1`: bands are the max across them, the 5th value is the mean of (full/255)^2 (the body energy).
 */
export function sampleBands(w: DetailWaveform, t0: number, t1: number, out: number[] = [0, 0, 0, 0, 0]): number[] {
  const bands = [w.full, w.low, w.mid, w.high];
  const f0 = (t0 * w.sampleRate - w.win / 2) / w.hop;
  const f1 = (t1 * w.sampleRate - w.win / 2) / w.hop;
  out[0] = out[1] = out[2] = out[3] = out[4] = 0;
  if (f1 < 0 || f0 > w.frames - 1) return out;
  if (f1 - f0 < 1) {
    const i = Math.max(0, Math.min(w.frames - 1, Math.floor((f0 + f1) / 2 + 0.5)));
    for (let b = 0; b < 4; b++) out[b] = bands[b][i];
    out[4] = (w.full[i] / 255) ** 2;
    return out;
  }
  const lo = Math.max(0, Math.ceil(f0)), hi = Math.min(w.frames - 1, Math.ceil(f1) - 1);
  if (hi < lo) return out;
  let sq = 0;
  for (let i = lo; i <= hi; i++) {
    for (let b = 0; b < 4; b++) if (bands[b][i] > out[b]) out[b] = bands[b][i];
    sq += (w.full[i] / 255) ** 2;
  }
  out[4] = sq / (hi - lo + 1);
  return out;
}

/** `frequency`: djay-style R/G/B = low/mid/high. `theme`: Night Void: magenta lows through violet and blue to cyan highs; broadband columns lighten. */
export type WaveformPalette = "theme" | "frequency";
// App OKLCH tokens in sRGB, evenly spaced over the theme hue position t in [0, 1]: magenta, violet, blue, cyan.
const THEME_STOPS = [[252, 91, 209], [179, 123, 255], [65, 161, 255], [0, 224, 245]];
const THEME_WHITE = [242, 245, 254];
const SILENT_RGB = [150, 150, 165];

/**
 * RGBA pixels of one tile (width x height, mirrored about the middle), tile `index` starting at index*tileSec.
 * The body is two-tone: a translucent outline at the column's peak (max full, relative to the track's p99.5) and an opaque
 * core at its mean energy, so dense passages read as a solid body inside a halo of transients. Colour comes from the band
 * maxima normalised by per-track band references (R/G/B = low/mid/high, strongest saturated; or the theme mix). Columns
 * whose core is under 2% of the reference are drawn as a dim neutral outline only.
 */
export function renderTileRGBA(w: DetailWaveform, index: number, tilePxPerSec: number, width: number, height: number, palette: WaveformPalette = "frequency"): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const start = index * (width / tilePxPerSec);
  const mid = height / 2;
  const { fullRef, bandRef } = trackStats(w);
  const refAmp = Math.sqrt(fullRef);
  const bands = [0, 0, 0, 0, 0];
  const paint = (x: number, half: number, r: number, g: number, b: number, a: number) => {
    for (let y = Math.max(0, Math.floor(mid - half)); y < Math.min(height, Math.ceil(mid + half)); y++) {
      const o = (y * width + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
    }
  };
  for (let x = 0; x < width; x++) {
    sampleBands(w, start + x / tilePxPerSec, start + (x + 1) / tilePxPerSec, bands);
    const o = Math.min(1, bands[0] / 255 / refAmp);
    const outline = Math.round(o * mid);
    if (outline <= 0) continue;
    if (bands[4] / fullRef < 0.02) { paint(x, outline, SILENT_RGB[0], SILENT_RGB[1], SILENT_RGB[2], 100); continue; }
    const core = Math.round(Math.min(Math.min(1, bands[4] / fullRef), o) * mid);
    const nl = Math.min(1, bands[1] / bandRef[0]), nm = Math.min(1, bands[2] / bandRef[1]), nh = Math.min(1, bands[3] / bandRef[2]);
    let r: number, g: number, b: number;
    if (palette === "theme") {
      const pk = Math.max(nl, nm, nh, 1e-6);
      const wl = nl / pk, wm = nm / pk, wh = nh / pk;
      const t = (0.5 * wm * wm + wh * wh) / Math.max(wl * wl + wm * wm + wh * wh, 1e-6);
      const f = Math.min(t * 3, 2.999999), i = Math.floor(f), u = f - i;
      const c0 = THEME_STOPS[i], c1 = THEME_STOPS[i + 1];
      const k = 0.55 * Math.min(wl, wm, wh);
      r = c0[0] + (c1[0] - c0[0]) * u; g = c0[1] + (c1[1] - c0[1]) * u; b = c0[2] + (c1[2] - c0[2]) * u;
      r += (THEME_WHITE[0] - r) * k; g += (THEME_WHITE[1] - g) * k; b += (THEME_WHITE[2] - b) * k;
    } else {
      const peak = Math.max(nl, nm, nh, 1e-6);
      r = (nl / peak) * 255; g = (nm / peak) * 255; b = (nh / peak) * 255;
    }
    paint(x, outline, r, g, b, 140);
    paint(x, core, r, g, b, 255);
  }
  return px;
}
