import type { DetailWaveform } from "./detailWaveform";
import { waveformColor, type WaveformPalette } from "./deckScroll";

export const OVERVIEW_MAX_WIDTH = 4096;
export const OVERVIEW_MAX_HEIGHT = 512;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

const SUMMARY_BINS = 4096;
interface OverviewSummary {
  bins: number;
  counts: Uint32Array;
  energy: Float64Array;
  peak: Float64Array;
  red: Float64Array;
  green: Float64Array;
  blue: Float64Array;
}
// Detail buffers are immutable source revisions. Weak keys release summaries with
// their detail object; the cache owns no full-track copies or permanent track IDs.
const summaries = new WeakMap<DetailWaveform, OverviewSummary>();

function overviewSummary(w: DetailWaveform): OverviewSummary {
  const cached = summaries.get(w);
  if (cached) return cached;
  const bins = Math.min(SUMMARY_BINS, w.frames);
  const result: OverviewSummary = {
    bins, counts: new Uint32Array(bins), energy: new Float64Array(bins), peak: new Float64Array(bins),
    red: new Float64Array(bins), green: new Float64Array(bins), blue: new Float64Array(bins),
  };
  const rmsBytes = w.rms, peakBytes = w.peak, redBytes = w.red, greenBytes = w.green, blueBytes = w.blue;
  let previousR = -1, previousG = -1, previousB = -1, hueR = 1, hueG = 1, hueB = 1;
  for (let bucket = 0; bucket < bins; bucket++) {
    const lo = Math.floor(bucket * w.frames / bins), hi = Math.floor((bucket + 1) * w.frames / bins);
    let energy = 0, peak = 0, red = 0, green = 0, blue = 0;
    for (let i = lo; i < hi; i++) {
      const rms = rmsBytes[i], samplePeak = peakBytes[i];
      energy += rms * rms;
      if (samplePeak > peak) peak = samplePeak;
      const rByte = redBytes[i], gByte = greenBytes[i], bByte = blueBytes[i];
      // CMWD repeats each lower-rate colour across several envelope frames.
      if (rByte !== previousR || gByte !== previousG || bByte !== previousB) {
        const r = rByte / 255, g = gByte / 255, b = bByte / 255;
        const maximum = Math.max(r, g, b), detailBrightness = clamp((maximum - .2) / .8);
        if (detailBrightness >= .05 && maximum - Math.min(r, g, b) > 2 / 255) {
          const gray = .2 * (1 - detailBrightness);
          hueR = clamp((r - gray) / detailBrightness);
          hueG = clamp((g - gray) / detailBrightness);
          hueB = clamp((b - gray) / detailBrightness);
        } else {
          hueR = hueG = hueB = 1;
        }
        previousR = rByte; previousG = gByte; previousB = bByte;
      }
      red += rms * hueR; green += rms * hueG; blue += rms * hueB;
    }
    const count = hi - lo;
    result.counts[bucket] = count;
    result.energy[bucket] = energy / (count * 255 * 255);
    result.peak[bucket] = peak / 255;
    result.red[bucket] = red / (count * 255);
    result.green[bucket] = green / (count * 255);
    result.blue[bucket] = blue / (count * 255);
  }
  summaries.set(w, result);
  return result;
}

function brightness(rms: number) {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return clamp(db < -36 ? .2 * (db + 50) / 14 : .2 + .8 * (db + 36) / 27);
}

/**
 * Continuous overview geometry recovered from djay's RMS/peak overview drawer.
 * CMWD v2 colours are an approximation of its separate overview RGB: invert the
 * known detail gray blend only above a safe brightness, then pool with RMS weights.
 * At very low brightness the original hue was lost; keep those samples neutral.
 * A source revision is reduced once to at most 4096 bins, retaining mean-square
 * energy and peak maxima. Resize and palette work uses only this bounded summary.
 * The proprietary bitmap texture is deliberately absent. Coincident alpha stops
 * use their final value, matching the recovered transfer rather than CoreGraphics pixels.
 */
export function renderOverviewRGBA(w: DetailWaveform, width: number, height: number, palette: WaveformPalette): Uint8ClampedArray<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > OVERVIEW_MAX_WIDTH || height > OVERVIEW_MAX_HEIGHT) {
    throw new Error("overview waveform: invalid dimensions");
  }
  const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  if (!w.frames) return rgba;
  const summary = overviewSummary(w);
  const q = Math.min(.95, Math.pow(.1, 10 * w.duration / width));
  const half = height / 2;
  let previousRms = 0, previousPeak = 0, previousRed = 0, previousGreen = 0, previousBlue = 0;
  for (let x = 0; x < width; x++) {
    const lo = Math.max(0, Math.min(summary.bins - 1, Math.floor((x - .5) * summary.bins / width)));
    const hi = Math.min(summary.bins, Math.max(lo + 1, Math.floor((x + 1.5) * summary.bins / width)));
    let energy = 0, peak = 0, red = 0, green = 0, blue = 0, count = 0;
    // Resize/palette work visits only the bounded summary, never the detail bytes.
    for (let i = lo; i < hi; i++) {
      const frames = summary.counts[i];
      energy += summary.energy[i] * frames;
      count += frames;
      peak = Math.max(peak, summary.peak[i]);
      red += summary.red[i]; green += summary.green[i]; blue += summary.blue[i];
    }
    const rawRms = Math.sqrt(energy / count);
    const rms = rawRms >= previousRms ? rawRms : q * previousRms + (1 - q) * rawRms;
    peak = Math.max(rms, peak >= previousPeak ? peak : q * previousPeak + (1 - q) * peak);
    previousRms = rms; previousPeak = peak;
    const qColor = Math.min(.8, Math.pow(.05, count * w.duration / w.frames));
    red = qColor * previousRed + (1 - qColor) * red;
    green = qColor * previousGreen + (1 - qColor) * green;
    blue = qColor * previousBlue + (1 - qColor) * blue;
    previousRed = red; previousGreen = green; previousBlue = blue;
    // Preserve exact silence instead of introducing a minimum-height decorative line.
    if (peak <= 0) continue;
    const maximum = Math.max(red, green, blue);
    const scale = brightness(rms) * (maximum < .01 ? .52 : .52 / maximum);
    const [baseR, baseG, baseB] = waveformColor(255 * (.9 * red * scale + .03),
      255 * (.9 * green * scale + .03), 255 * (.9 * blue * scale + .03), palette);
    const outer = Math.round(Math.max(1, Math.min(half, .75 * half * peak)));
    const core = Math.round(Math.max(1, Math.min(half, half * rms)));
    const ratio = rms / peak || 1;
    const stop1 = clamp(.8 - 2 * ratio), stop2 = clamp(1 - 2 * ratio);
    const firstRow = Math.max(0, Math.floor(half - outer));
    const lastRow = Math.min(height - 1, Math.ceil(half + outer) - 1);
    for (let y = firstRow; y <= lastRow; y++) {
      const distance = Math.abs(y + .5 - half);
      if (distance >= outer) continue;
      const t = distance / (1.3 * core);
      const glow = t <= .2 ? .2 : t <= .5 ? .2 - .1 * (t - .2) / .3 : t < 1 ? .2 * (1 - t) : 0;
      const inward = (outer - distance) / outer;
      const alpha = inward >= stop2 ? 1 : inward >= stop1
        ? .5 + .5 * (inward - stop1) / (stop2 - stop1)
        : .2 + .3 * inward / stop1;
      const index = (y * width + x) * 4;
      rgba[index] = Math.min(255, baseR + 255 * glow);
      rgba[index + 1] = Math.min(255, baseG + 255 * glow);
      rgba[index + 2] = Math.min(255, baseB + 255 * glow);
      rgba[index + 3] = 255 * alpha;
    }
  }
  return rgba;
}
