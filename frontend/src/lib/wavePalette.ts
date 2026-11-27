/**
 * CrateMind's own waveform colours («Χρώματα κυματομορφής»: «CrateMind»).
 *
 * The stored detail colour (CMWD red/green/blue, `waveform_color.py`) is djay's model: an HSV colour whose hue is the
 * circular mean of the six band hues (lows 0, mids about 0.40, highs about 0.65; a kick with hats lands between highs and
 * lows, about 0.83), whose saturation says how much one band leads (0.3 broadband … 1 one band) and whose value is the level.
 * This module reads those three back and paints them in the app's own hues, in OKLCH. Nothing is analysed again.
 *
 * The old "theme" map remapped hue to hue along the same wheel, so blue stayed blue, magenta magenta and red rose: on real
 * music, whose stored colours sit between blue and red, it looked the same as the frequency colours (measured on five
 * tracks: a mean hue shift of 7°). This one moves every band (about 95° on the same tracks):
 *   lows (kick, bass) → violet · lows under a little top end → magenta · kick and hats together → rose ·
 *   highs (hats, noise, snare rolls) → amber · highs with mids → yellow · mids (leads, pads, voices) → lime, the yellow
 *   side of chartreuse · mids with lows → blue (the rare stretch between lime and blue crosses green and cyan quickly,
 *   because those are the deck rails' and the playhead's colours).
 * The map runs the other way round the colour wheel than the stored hue, so the two must meet at two hues: they do near
 * stored 0.26 (a rare low-mid mix, green in both) and near 0.90 (a pink-red in both); everywhere else they are far apart.
 * The low end is the deepest colour and the mids and highs the lightest, so the bands differ in more than hue. A broadband
 * column (a full drop) loses chroma, toward white on the dark screen and toward ink on the light one.
 */
import type { Theme } from "./theme";

/** The stored pref ("theme" is CrateMind's palette; the value's name is older than the palette). */
export type WaveformPalette = "theme" | "frequency";
/** What a renderer draws and keys its caches with: the pref, split by app theme for CrateMind's colours. */
export type WavePaletteId = "frequency" | "cratemind-dark" | "cratemind-light";

export const wavePaletteId = (palette: WaveformPalette, theme: Theme): WavePaletteId =>
  palette === "frequency" ? "frequency" : theme === "light" ? "cratemind-light" : "cratemind-dark";

/** One stop of the map: the stored (djay) hue 0..1, then the OKLCH lightness, chroma and hue (degrees, increasing) it becomes. */
export type PaletteStop = readonly [storedHue: number, l: number, c: number, h: number];
export interface PaletteSpec {
  /** Stops by rising stored hue; the first is repeated at stored hue 1. A chroma above what sRGB holds means "as strong as fits". */
  stops: readonly PaletteStop[];
  /** OKLab lightness of the neutral a broadband column pales toward (white on the dark screen, ink on the light one). */
  neutralL: number;
  /** Level 0: the sRGB byte the colour fades to (black on the dark screen, the paper grey on the light one). */
  floor: number;
}

/** Night Void: the app's hues at the strongest chroma sRGB holds. */
export const CRATEMIND_DARK: PaletteSpec = {
  stops: [
    [0, .64, .4, 298],      // lows: violet
    [.18, .68, .4, 255],    // lows + mids: blue
    [.25, .80, .4, 160],    // (the rare stretch here crosses the rails' cyan and green quickly)
    [.31, .88, .4, 116],
    [.40, .89, .4, 108],    // mids: lime, the yellow side of chartreuse
    [.52, .86, .4, 84],     // mids + highs: yellow
    [.65, .80, .4, 56],     // highs: amber
    [.74, .74, .4, 36],     // highs over a little low end: orange
    [.83, .69, .4, 14],     // highs + lows (kick and hats together): rose
    [.92, .66, .4, -18],    // lows under a little top end: magenta (342°)
  ],
  neutralL: .95, floor: 0,
};
/** Solar Void: the same hues at the light theme's ink strength; loud is deep, quiet fades into the paper. */
export const CRATEMIND_LIGHT: PaletteSpec = {
  stops: [
    [0, .50, .4, 298],
    [.18, .54, .4, 255],
    [.25, .62, .4, 160],
    [.31, .70, .4, 118],
    [.40, .72, .4, 110],
    [.52, .72, .4, 84],
    [.65, .68, .4, 56],
    [.74, .63, .4, 36],
    [.83, .59, .4, 14],
    [.92, .54, .4, -18],
  ],
  neutralL: .42, floor: 226,
};

const HUE_STEPS = 256, SAT_STEPS = 32;

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.7076147010 * s];
}
const encode = (x: number) => 255 * (x <= .0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - .055);
const inGamut = (rgb: number[]) => rgb.every(x => x >= -1e-4 && x <= 1 + 1e-4);

/** The largest chroma up to `c` that sRGB holds at this lightness and hue. */
export function fitChroma(l: number, c: number, hDeg: number): number {
  const h = hDeg * Math.PI / 180, cos = Math.cos(h), sin = Math.sin(h);
  if (inGamut(oklabToSrgb(l, c * cos, c * sin))) return c;
  let lo = 0, hi = c;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToSrgb(l, mid * cos, mid * sin))) lo = mid; else hi = mid;
  }
  return lo;
}

/** sRGB bytes of an OKLCH colour that is inside sRGB (see fitChroma). */
export function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = hDeg * Math.PI / 180;
  return oklabToSrgb(l, c * Math.cos(h), c * Math.sin(h)).map(x => encode(Math.max(0, Math.min(1, x)))) as [number, number, number];
}

/** The OKLCH colour a fully saturated stored hue (0..1) becomes. */
export function paletteAt(spec: PaletteSpec, storedHue: number): [l: number, c: number, h: number] {
  const stops = spec.stops, first = stops[0];
  const hue = ((storedHue % 1) + 1) % 1;
  let i = 0;
  while (i < stops.length - 1 && hue >= stops[i + 1][0]) i++;
  const lo = stops[i], hi = i + 1 < stops.length ? stops[i + 1] : [1 + first[0], first[1], first[2], first[3] + 360] as const;
  // Each segment takes the short way round between its two stops' hues.
  let hiH = hi[3];
  while (hiH < lo[3] - 180) hiH += 360;
  while (hiH > lo[3] + 180) hiH -= 360;
  const t = (hue - lo[0]) / (hi[0] - lo[0]);
  return [lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t, lo[3] + (hiH - lo[3]) * t];
}

/** Full-level sRGB bytes for every (hue, saturation) step: (HUE_STEPS + 1) × (SAT_STEPS + 1) triples. */
function buildTable(spec: PaletteSpec): Float32Array {
  const table = new Float32Array((HUE_STEPS + 1) * (SAT_STEPS + 1) * 3);
  for (let hi = 0; hi <= HUE_STEPS; hi++) {
    const [l, c, h] = paletteAt(spec, hi / HUE_STEPS);
    for (let si = 0; si <= SAT_STEPS; si++) {
      // Saturation 1 is one band alone, 0.3 a broadband column. Chroma falls slowly (power 0.4) and the lightness leans
      // toward the neutral only for the most mixed columns, so mixed music keeps its colour instead of going pastel.
      const sat = si / SAT_STEPS, light = l + (spec.neutralL - l) * Math.pow(1 - sat, 2.5);
      const rgb = oklchToSrgb(light, si === 0 ? 0 : fitChroma(light, c, h) * Math.pow(sat, .4), h);
      table.set(si === 0 ? [rgb[0], rgb[0], rgb[0]] : rgb, (hi * (SAT_STEPS + 1) + si) * 3);
    }
  }
  return table;
}

const tables = new Map<PaletteSpec, Float32Array>();
function tableOf(spec: PaletteSpec): Float32Array {
  let table = tables.get(spec);
  if (!table) { table = buildTable(spec); tables.set(spec, table); }
  return table;
}

/**
 * A stored colour (bytes, fractions allowed) in the given palette: its hue picks the band colour, its saturation how far
 * from the neutral, its value (the level) how far from the floor. Grey in is grey out; nothing is brighter than the input.
 */
export function paletteColor(r: number, g: number, b: number, spec: PaletteSpec, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const table = tableOf(spec), row = SAT_STEPS + 1, value = max / 255, floor = spec.floor * (1 - value);
  if (max <= 0) { out[0] = out[1] = out[2] = spec.floor; return out; }
  let hue = 0;
  if (delta > 1e-6) {
    hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = ((hue / 6) % 1 + 1) % 1;
  }
  const hf = hue * HUE_STEPS, h0 = Math.floor(hf), ht = hf - h0;
  const sf = Math.min(1, delta / max) * SAT_STEPS, s0 = Math.min(SAT_STEPS - 1, Math.floor(sf)), st = sf - s0;
  const a = (h0 * row + s0) * 3, c = ((h0 + 1) * row + s0) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const low = table[a + ch] + (table[a + 3 + ch] - table[a + ch]) * st;
    const high = table[c + ch] + (table[c + 3 + ch] - table[c + ch]) * st;
    out[ch] = floor + value * (low + (high - low) * ht);
  }
  return out;
}

/** Shared by the deck lanes, the overviews and the transition editor; the frequency colours stay the measured RGB. */
export function waveformColor(r: number, g: number, b: number, palette: WavePaletteId, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (palette === "frequency") { out[0] = r; out[1] = g; out[2] = b; return out; }
  return paletteColor(r, g, b, palette === "cratemind-light" ? CRATEMIND_LIGHT : CRATEMIND_DARK, out);
}
