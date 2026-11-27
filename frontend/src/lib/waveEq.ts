/**
 * «Η κυματομορφή ακολουθεί το EQ» (`Prefs.waveformFollowEq`): the deck lanes' colours recomputed from the stored colours
 * for the deck's LOW / MID / HIGH. Nothing is analysed again and no tile is fetched again.
 *
 * The stored colour (`backend/app/services/waveform_color.py`) is `level·HSV(hue, sat, 1) + GREY·(1 − level)`, where the
 * hue and `sat = SAT_FLOOR + (1 − SAT_FLOOR)·R` come from the mean vector `z = R·e^(i·hue)` of the six band hues, each
 * weighted by its filter score to the power SCORE_POWER. This module undoes that: it reads level, sat and hue back, folds
 * the six filters into three directions (lows, mids, highs: the mean hue of each pair) and solves
 * `p_lo·u_lo + p_mid·u_mid + p_hi·u_hi = z`, `p_lo + p_mid + p_hi = 1` for the three weight shares. A band whose audio
 * gain is g then weighs `p·g^SCORE_POWER`, the colour is mixed again, and the level moves by the change in the column's
 * amplitude (a band's amplitude share is proportional to `p^(1/SCORE_POWER)`), along the stored level's own dB scale.
 *
 * Limits: one colour per column, so a mixed column dims as a whole and the shape never changes; a pair of filters is
 * treated as one direction (the two mid filters are 29° apart); a column at full level may have been louder than the
 * scale holds. The constants below exist in Python too: `tests/waveEq.test.ts` fails when one side changes.
 */
import { sampleBands } from "./deckScroll";
import type { DetailWaveform } from "./detailWaveform";
import { LOW_KILL_START, eqDb } from "./mixer";
import { waveformColor, type WavePaletteId } from "./wavePalette";

/** The six filters' hues (0..1), low to high: `_HUES` in waveform_color.py. */
export const BAND_HUES = [.99, 0, .36, .44, .64, .66] as const;
/** weights = scores ** 1.5 (`mix_colors`). */
export const SCORE_POWER = 1.5;
/** saturation = .3 + .7·R. */
export const SAT_FLOOR = .3;
/** rgb = level·hue_rgb + .2·(1 − level). */
export const GREY = .2;
/** `brightness`: level GREY at KNEE_DB, 0 at FLOOR_DB, 1 at KNEE_DB + SPAN_DB. */
export const LEVEL_KNEE_DB = -36, LEVEL_FLOOR_DB = -50, LEVEL_SPAN_DB = 27;
/** Below this level the stored hue is noise (the overview ignores it there too): the column is left as it is. */
export const QUIET_LEVEL = .05;
/** A column less saturated than the model allows (an average of opposite hues) keeps a little of its hue's direction. */
const MIN_R = .02;
/** Gains are read up to +24 dB (knob and transition together reach +12). */
const MAX_GAIN = 16;

const TAU = 2 * Math.PI;
const pairAngle = (a: number, b: number) =>
  Math.atan2(Math.sin(TAU * a) + Math.sin(TAU * b), Math.cos(TAU * a) + Math.cos(TAU * b));
/** The three band directions on the hue wheel, radians: lows about -2°, mids 144°, highs 234°. */
export const BAND_ANGLES = [pairAngle(BAND_HUES[0], BAND_HUES[1]), pairAngle(BAND_HUES[2], BAND_HUES[3]), pairAngle(BAND_HUES[4], BAND_HUES[5])] as const;
const UX = BAND_ANGLES.map(Math.cos), UY = BAND_ANGLES.map(Math.sin);
// Inverse of [[ux0 ux1 ux2] [uy0 uy1 uy2] [1 1 1]], by cofactors: shares = INV · (zx, zy, 1).
const DET = UX[0] * (UY[1] - UY[2]) - UX[1] * (UY[0] - UY[2]) + UX[2] * (UY[0] - UY[1]);
const INV = [
  [(UY[1] - UY[2]) / DET, (UX[2] - UX[1]) / DET, (UX[1] * UY[2] - UX[2] * UY[1]) / DET],
  [(UY[2] - UY[0]) / DET, (UX[0] - UX[2]) / DET, (UX[2] * UY[0] - UX[0] * UY[2]) / DET],
  [(UY[0] - UY[1]) / DET, (UX[1] - UX[0]) / DET, (UX[0] * UY[1] - UX[1] * UY[0]) / DET],
];

/** What `bandShares` reads from a stored colour. `level` under QUIET_LEVEL: nothing else is filled. */
export interface BandShares { level: number; sat: number; hue: number; r: number; lo: number; mid: number; hi: number }
const SCRATCH: BandShares = { level: 0, sat: 0, hue: 0, r: 0, lo: 0, mid: 0, hi: 0 };

/**
 * Level, saturation, hue (radians) and the lows / mids / highs shares of the colour weight (they sum to 1) of a stored
 * colour in bytes (fractions allowed). A colour outside the three bands' triangle is clamped onto it.
 */
export function bandShares(r: number, g: number, b: number, out: BandShares = { level: 0, sat: 0, hue: 0, r: 0, lo: 0, mid: 0, hi: 0 }): BandShares {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const level = Math.min(1, (max / 255 - GREY) / (1 - GREY));
  out.level = level >= QUIET_LEVEL ? level : 0;   // NaN lands here too
  out.sat = out.hue = out.r = out.lo = out.mid = out.hi = 0;
  if (!out.level) return out;
  out.sat = Math.min(1, delta / 255 / level);
  let hue = 0;
  if (delta > 1e-9) hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  out.hue = hue * TAU / 6;
  out.r = Math.max(MIN_R, Math.min(1, (out.sat - SAT_FLOOR) / (1 - SAT_FLOOR)));
  const zx = out.r * Math.cos(out.hue), zy = out.r * Math.sin(out.hue);
  const lo = Math.max(0, INV[0][0] * zx + INV[0][1] * zy + INV[0][2]);
  const mid = Math.max(0, INV[1][0] * zx + INV[1][1] * zy + INV[1][2]);
  const hi = Math.max(0, INV[2][0] * zx + INV[2][1] * zy + INV[2][2]);
  const sum = lo + mid + hi;   // the three raw shares sum to 1, so at least one is positive
  out.lo = lo / sum; out.mid = mid / sum; out.hi = hi / sum;
  return out;
}

const levelDb = (level: number) => level >= GREY
  ? LEVEL_KNEE_DB + LEVEL_SPAN_DB * (level - GREY) / (1 - GREY)
  : LEVEL_FLOOR_DB + (LEVEL_KNEE_DB - LEVEL_FLOOR_DB) * level / GREY;
const dbLevel = (db: number) => Math.max(0, Math.min(1, db < LEVEL_KNEE_DB
  ? GREY * (db - LEVEL_FLOOR_DB) / (LEVEL_KNEE_DB - LEVEL_FLOOR_DB)
  : GREY + (1 - GREY) * (db - LEVEL_KNEE_DB) / LEVEL_SPAN_DB));

/** Linear audio gains of the three bands (1 = flat, 0 = gone). */
export interface EqGains { lo: number; mid: number; hi: number }

/**
 * A stored colour (bytes) as it would have been stored with the three bands at these gains, in bytes (fractions).
 * Flat gains and quiet columns return the input untouched; near flat the result approaches it continuously.
 */
export function eqColor(r: number, g: number, b: number, gains: EqGains, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (gains.lo === 1 && gains.mid === 1 && gains.hi === 1) { out[0] = r; out[1] = g; out[2] = b; return out; }
  const gl = Math.max(0, Math.min(MAX_GAIN, gains.lo)) || 0, gm = Math.max(0, Math.min(MAX_GAIN, gains.mid)) || 0, gh = Math.max(0, Math.min(MAX_GAIN, gains.hi)) || 0;
  return mixed(r, g, b, gl, gm, gh, gl ** SCORE_POWER, gm ** SCORE_POWER, gh ** SCORE_POWER, out);
}

/** eqColor's work for gains that are not flat: g* are the clamped gains, p* the same to the power SCORE_POWER. */
function mixed(r: number, g: number, b: number, gl: number, gm: number, gh: number, pl: number, pm: number, ph: number, out: [number, number, number]): [number, number, number] {
  out[0] = r; out[1] = g; out[2] = b;
  const s = bandShares(r, g, b, SCRATCH);
  if (!s.level) return out;
  // What the clamp onto the triangle left out stays in the colour, so flat gains give back exactly the stored hue.
  const zx = s.r * Math.cos(s.hue), zy = s.r * Math.sin(s.hue);
  const restX = zx - (s.lo * UX[0] + s.mid * UX[1] + s.hi * UX[2]), restY = zy - (s.lo * UY[0] + s.mid * UY[1] + s.hi * UY[2]);
  const wl = s.lo * pl, wm = s.mid * pm, wh = s.hi * ph, weight = wl + wm + wh;
  let hue = s.hue, radius = s.r;
  if (weight > 1e-12) {
    const x = (wl * UX[0] + wm * UX[1] + wh * UX[2]) / weight + restX, y = (wl * UY[0] + wm * UY[1] + wh * UY[2]) / weight + restY;
    radius = Math.min(1, Math.hypot(x, y));
    if (radius > 1e-6) hue = Math.atan2(y, x);
  }
  const sat = Math.min(1, s.sat * (SAT_FLOOR + (1 - SAT_FLOOR) * radius) / (SAT_FLOOR + (1 - SAT_FLOOR) * s.r));
  // The column's amplitude with the gains over its amplitude without them.
  const al = Math.cbrt(s.lo * s.lo), am = Math.cbrt(s.mid * s.mid), ah = Math.cbrt(s.hi * s.hi);   // share ** (1 / SCORE_POWER)
  const ratio = (al * gl + am * gm + ah * gh) / (al + am + ah);
  const level = ratio > 1e-9 ? dbLevel(levelDb(s.level) + 20 * Math.log10(ratio)) : 0;
  // HSV(hue, sat, 1), then the stored blend toward grey.
  const sector = ((hue / TAU % 1) + 1) % 1 * 6, i = Math.floor(sector) % 6, f = sector - Math.floor(sector);
  const p = 1 - sat, q = 1 - sat * f, t = 1 - sat * (1 - f);
  const red = i === 0 || i === 5 ? 1 : i === 1 ? q : i === 4 ? t : p;
  const green = i === 1 || i === 2 ? 1 : i === 0 ? t : i === 3 ? q : p;
  const blue = i === 3 || i === 4 ? 1 : i === 2 ? t : i === 5 ? q : p;
  const grey = GREY * (1 - level);
  out[0] = 255 * (level * red + grey); out[1] = 255 * (level * green + grey); out[2] = 255 * (level * blue + grey);
  return out;
}

// --- The EQ a lane follows, as one number -------------------------------------------------------------------------

const DB_STEP = 10, DB_GONE = -120, DB_OFFSET = -DB_GONE * DB_STEP, RADIX = 2048;
const tenths = (db: number) => Math.max(0, Math.min(RADIX - 1, Math.round((Number.isFinite(db) ? Math.max(DB_GONE, db) : DB_GONE) * DB_STEP) + DB_OFFSET));
/** How far into the LOW kill zone a knob is: 0 at LOW_KILL_START and above, 1 fully left. */
const knobKill = (v: number) => Math.max(0, Math.min(1, (LOW_KILL_START - v) / (1 + LOW_KILL_START)));
/** The same for the kill high-pass's cutoff (`lowKillHz`: 20 Hz where the zone starts, 200 Hz fully left). */
const hzKill = (hz: number) => hz > 20 ? Math.min(1, Math.log10(hz / 20)) : 0;

/** The key of a flat EQ: a lane whose tiles all carry it shows the stored colours. */
export const EQ_FLAT_KEY = (DB_OFFSET * RADIX + DB_OFFSET) * RADIX + DB_OFFSET;

/**
 * One number for the EQ a deck's listener hears, in tenths of a dB per band: the knobs (-1..1, through `eqDb`) plus, when
 * given, the transition stage's own gains (`StretchDeck.automationEq`: LOW, MID, HIGH in dB and the kill cutoff in Hz).
 * The LOW kill zone takes the lows from the shelf's gain down to nothing as the knob (or the cutoff) crosses it.
 */
export function eqKey(lo: number, mid: number, hi: number, stage?: ArrayLike<number> | null): number {
  const kill = (1 - knobKill(lo)) * (stage ? 1 - hzKill(stage[3]) : 1);
  const low = kill > 0 ? eqDb(lo) + (stage ? stage[0] : 0) + 20 * Math.log10(kill) : DB_GONE;
  return (tenths(low) * RADIX + tenths(eqDb(mid) + (stage ? stage[1] : 0))) * RADIX + tenths(eqDb(hi) + (stage ? stage[2] : 0));
}

const keyGain = (t: number) => t <= 0 ? 0 : 10 ** ((t - DB_OFFSET) / DB_STEP / 20);
/** The linear gains an `eqKey` stands for. */
export function eqKeyGains(key: number, out: EqGains = { lo: 1, mid: 1, hi: 1 }): EqGains {
  out.hi = keyGain(key % RADIX);
  out.mid = keyGain(Math.floor(key / RADIX) % RADIX);
  out.lo = keyGain(Math.floor(key / RADIX / RADIX));
  return out;
}

/**
 * One row of opaque RGBA, a colour per tile column, for a lane tile that starts at `startSeconds`: the same columns
 * `renderDensityTileRGBA` colours, with the EQ of `key` applied before the palette. With EQ_FLAT_KEY it is that
 * function's colours exactly.
 */
export function eqStripRGBA(w: DetailWaveform, startSeconds: number, pixelsPerSecond: number, width: number, palette: WavePaletteId, key: number, out: Uint8ClampedArray): Uint8ClampedArray {
  const column = COLUMN, rgb = RGB, flat = key === EQ_FLAT_KEY, { lo, mid, hi } = eqKeyGains(key, GAINS);
  const pl = lo ** SCORE_POWER, pm = mid ** SCORE_POWER, ph = hi ** SCORE_POWER;
  for (let x = 0; x < width; x++) {
    const t = Math.min(startSeconds + x / pixelsPerSecond, Math.max(0, w.duration - 1e-9));
    sampleBands(w, t, Math.min(t + 1 / pixelsPerSecond, w.duration), column);
    if (flat) waveformColor(column[2], column[3], column[4], palette, rgb);
    else { mixed(column[2], column[3], column[4], lo, mid, hi, pl, pm, ph, rgb); waveformColor(rgb[0], rgb[1], rgb[2], palette, rgb); }
    out[x * 4] = rgb[0]; out[x * 4 + 1] = rgb[1]; out[x * 4 + 2] = rgb[2]; out[x * 4 + 3] = 255;
  }
  return out;
}
const COLUMN = [0, 0, 0, 0, 0], RGB: [number, number, number] = [0, 0, 0], GAINS: EqGains = { lo: 1, mid: 1, hi: 1 };
