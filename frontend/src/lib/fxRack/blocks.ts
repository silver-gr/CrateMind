// Deck FX rack building blocks (§2): D delay, R reverb, F filters, G gate, C crusher and N generators. Our own DSP in
// plain TypeScript: no DOM or worklet globals, and nothing is allocated while processing. Recursive writes flush
// |x| < 1e-15 to 0 (§7.4).
import type { QuantumClock, StereoFilter, SvfMode } from "./types";

const TAU = 2 * Math.PI;
/** Recursive state below this is flushed to 0. */
const FLUSH = 1e-15;

const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const flush = (x: number) => (x < FLUSH && x > -FLUSH ? 0 : x);

/** Rational tanh: unity slope at 0, monotonic, exactly ±1 from |x| ≥ 3. */
export function tanhR(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Loop saturator tanh(d·x)/d: unity gain at small signals, slope ≤ 1 everywhere. */
const sat = (x: number, d: number): number => tanhR(d * x) / d;

/** Raised-cosine step: 0 at x ≤ −1, ½ at 0, 1 at x ≥ 1. */
function rcStep(x: number): number {
  if (x <= -1) return 0;
  if (x >= 1) return 1;
  return 0.5 + 0.5 * Math.sin(0.5 * Math.PI * x);
}

/** One-pole smoothing of a per-quantum target: the value after n frames with time constant `tauFrames`. */
export const smoothed = (cur: number, target: number, n: number, tauFrames: number): number =>
  target + (cur - target) * Math.exp(-n / Math.max(1, tauFrames));

// ---- F: TPT state-variable filter ----

const MODES: Record<SvfMode | "peak", number> = { lp: 0, bp: 1, hp: 2, peak: 3 };

/**
 * Zavalishin TPT SVF, stereo. The cutoff glides in log2 Hz over 15 ms (coefficients every 16 frames) unless snapped.
 * Band-pass is peak-normalised (k·band), the peak mode adds (A − 1)·k·band, and the band state is soft-clipped.
 */
export class Svf implements StereoFilter {
  yL = 0;
  yR = 0;
  /** Steady-state response at the frequency of the last `respond()`. */
  re = 1;
  im = 0;
  private mode = 0;
  private readonly fs: number;
  private readonly maxLog: number;
  private readonly glide: number;
  private cur = 10;
  private target = 10;
  private k = Math.SQRT2;
  private peak = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private s1L = 0;
  private s2L = 0;
  private s1R = 0;
  private s2R = 0;
  private count = 0;

  constructor(sampleRate: number, mode: SvfMode | "peak" = "lp") {
    this.fs = sampleRate;
    this.maxLog = Math.log2(sampleRate * 0.45);
    this.glide = 1 - Math.exp(-16 / (0.015 * sampleRate));
    this.mode = MODES[mode];
    this.coefs();
  }

  setMode(mode: SvfMode | "peak"): void {
    this.mode = MODES[mode];
  }

  set(hz: number, q: number, snap = false): void {
    this.target = clamp(Math.log2(hz > 1 ? hz : 1), 3.33, this.maxLog);
    this.k = 1 / clamp(q, 0.3, 8);
    if (snap) {
      this.cur = this.target;
      this.coefs();
    }
  }

  /** Peak mode gain in dB. */
  setGain(db: number): void {
    this.peak = 10 ** (db / 20) - 1;
  }

  reset(): void {
    this.s1L = this.s2L = this.s1R = this.s2R = 0;
    this.yL = this.yR = 0;
    this.cur = this.target;
    this.coefs();
  }

  /** A fresh low-pass starts settled on the input frame (l, r) instead of rising from 0, so it does not ring. */
  prime(l: number, r: number): void {
    this.s1L = this.s1R = 0;
    this.s2L = l;
    this.s2R = r;
  }

  private coefs(): void {
    const g = Math.tan((Math.PI * 2 ** this.cur) / this.fs);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Every 16 frames: glide the cutoff, refresh coefficients, flush the state. */
  private step(): void {
    this.count = 15;
    const d = this.target - this.cur;
    this.cur = d > 1e-4 || d < -1e-4 ? this.cur + d * this.glide : this.target;
    this.coefs();
    this.s1L = flush(this.s1L);
    this.s2L = flush(this.s2L);
    this.s1R = flush(this.s1R);
    this.s2R = flush(this.s2R);
  }

  /** One stereo frame; the result is in yL, yR. */
  tick(xL: number, xR: number): void {
    if (--this.count < 0) this.step();
    const a1 = this.a1, a2 = this.a2, a3 = this.a3, k = this.k;
    let v3 = xL - this.s2L;
    let v1 = a1 * this.s1L + a2 * v3;
    let v2 = this.s2L + a2 * this.s1L + a3 * v3;
    let s1 = 2 * v1 - this.s1L;
    this.s1L = s1 > 3 || s1 < -3 ? softState(s1) : s1;
    this.s2L = 2 * v2 - this.s2L;
    const m = this.mode;
    this.yL = m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? xL - k * v1 - v2 : xL + this.peak * k * v1;
    v3 = xR - this.s2R;
    v1 = a1 * this.s1R + a2 * v3;
    v2 = this.s2R + a2 * this.s1R + a3 * v3;
    s1 = 2 * v1 - this.s1R;
    this.s1R = s1 > 3 || s1 < -3 ? softState(s1) : s1;
    this.s2R = 2 * v2 - this.s2R;
    this.yR = m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? xR - k * v1 - v2 : xR + this.peak * k * v1;
  }

  /** One mono frame on the left state; returns the output. */
  tickMono(x: number): number {
    if (--this.count < 0) this.step();
    const v3 = x - this.s2L;
    const v1 = this.a1 * this.s1L + this.a2 * v3;
    const v2 = this.s2L + this.a2 * this.s1L + this.a3 * v3;
    const s1 = 2 * v1 - this.s1L;
    this.s1L = s1 > 3 || s1 < -3 ? softState(s1) : s1;
    this.s2L = 2 * v2 - this.s2L;
    const m = this.mode, k = this.k;
    return m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? x - k * v1 - v2 : x + this.peak * k * v1;
  }

  /** Filters frames [0, n) of a mono buffer in place, on the left state. */
  processMono(x: Float32Array, n: number): void {
    let i = 0;
    while (i < n) {
      if (--this.count < 0) this.step();
      const end = Math.min(n, i + this.count + 1);
      this.count -= end - i - 1;
      const a1 = this.a1, a2 = this.a2, a3 = this.a3, k = this.k, m = this.mode, pk = this.peak * k;
      let s1 = this.s1L, s2 = this.s2L;
      for (; i < end; i++) {
        const xi = x[i], v3 = xi - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1;
        if (s1 > 3 || s1 < -3) s1 = softState(s1);
        s2 = 2 * v2 - s2;
        x[i] = m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? xi - k * v1 - v2 : xi + pk * v1;
      }
      this.s1L = s1;
      this.s2L = s2;
    }
  }

  process(l: Float32Array, r: Float32Array, from: number, to: number): void {
    let i = from;
    while (i < to) {
      if (--this.count < 0) this.step();
      // Up to the next coefficient refresh with the state in locals.
      const end = Math.min(to, i + this.count + 1);
      this.count -= end - i - 1;
      const a1 = this.a1, a2 = this.a2, a3 = this.a3, k = this.k, m = this.mode, pk = this.peak * k;
      let s1L = this.s1L, s2L = this.s2L, s1R = this.s1R, s2R = this.s2R;
      for (; i < end; i++) {
        const xL = l[i], xR = r[i];
        let v3 = xL - s2L, v1 = a1 * s1L + a2 * v3, v2 = s2L + a2 * s1L + a3 * v3;
        s1L = 2 * v1 - s1L;
        if (s1L > 3 || s1L < -3) s1L = softState(s1L);
        s2L = 2 * v2 - s2L;
        l[i] = m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? xL - k * v1 - v2 : xL + pk * v1;
        v3 = xR - s2R;
        v1 = a1 * s1R + a2 * v3;
        v2 = s2R + a2 * s1R + a3 * v3;
        s1R = 2 * v1 - s1R;
        if (s1R > 3 || s1R < -3) s1R = softState(s1R);
        s2R = 2 * v2 - s2R;
        r[i] = m === 0 ? v2 : m === 1 ? k * v1 : m === 2 ? xR - k * v1 - v2 : xR + pk * v1;
      }
      this.s1L = s1L;
      this.s2L = s2L;
      this.s1R = s1R;
      this.s2R = s2R;
    }
  }

  /** Steady-state response (at the target cutoff) at `hz`, into re/im. */
  respond(hz: number): void {
    const w = Math.tan((Math.PI * Math.min(hz, this.fs * 0.4999)) / this.fs) / Math.tan((Math.PI * 2 ** this.target) / this.fs);
    const dr = 1 - w * w, di = this.k * w, den = dr * dr + di * di;
    // 1/den as complex: (dr − j·di)/|den|²
    const ir = dr / den, ii = -di / den;
    const m = this.mode;
    if (m === 0) {
      this.re = ir;
      this.im = ii;
    } else if (m === 2) {
      this.re = -w * w * ir;
      this.im = -w * w * ii;
    } else {
      // k·band = j·k·w / den
      const br = -this.k * w * ii, bi = this.k * w * ir;
      this.re = m === 1 ? br : 1 + this.peak * br;
      this.im = m === 1 ? bi : this.peak * bi;
    }
  }
}

/** Soft limit of the band state beyond ±3, approaching ±4 (keeps Q ≤ 8 bounded on transients). */
function softState(s: number): number {
  return s > 0 ? 3 + tanhR(s - 3) : -3 - tanhR(-s - 3);
}

/** DC blocker y = x − x₁ + R·y₁ with R ≈ .9995 at 48 kHz (a 3.8 Hz corner at every rate). */
export class DcBlock {
  yL = 0;
  yR = 0;
  r: number;
  private readonly fs: number;
  private x1L = 0;
  private y1L = 0;
  private x1R = 0;
  private y1R = 0;

  constructor(sampleRate: number, hz = 3.8) {
    this.fs = sampleRate;
    this.r = 1 - (TAU * hz) / sampleRate;
  }

  /** Moves the corner (Hz). */
  setCorner(hz: number): void {
    this.r = 1 - (TAU * hz) / this.fs;
  }

  tick(xL: number, xR: number): void {
    this.y1L = this.yL = flush(xL - this.x1L + this.r * this.y1L);
    this.x1L = xL;
    this.y1R = this.yR = flush(xR - this.x1R + this.r * this.y1R);
    this.x1R = xR;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const R = this.r;
    let x1L = this.x1L, y1L = this.y1L, x1R = this.x1R, y1R = this.y1R;
    for (let i = 0; i < n; i++) {
      const xL = l[i], xR = r[i];
      y1L = xL - x1L + R * y1L;
      x1L = xL;
      y1R = xR - x1R + R * y1R;
      x1R = xR;
      l[i] = y1L;
      r[i] = y1R;
    }
    this.x1L = x1L;
    this.y1L = flush(y1L);
    this.x1R = x1R;
    this.y1R = flush(y1R);
  }

  reset(): void {
    this.x1L = this.y1L = this.x1R = this.y1R = this.yL = this.yR = 0;
  }

  /** Response at `hz` as [re, im] of (1 − e^−jω)/(1 − R·e^−jω), written into `out`. */
  respond(hz: number, sampleRate: number, out: { re: number; im: number }): void {
    const w = (TAU * hz) / sampleRate, c = Math.cos(w), s = Math.sin(w);
    const nr = 1 - c, ni = s, dr = 1 - this.r * c, di = this.r * s, den = dr * dr + di * di;
    out.re = (nr * dr + ni * di) / den;
    out.im = (ni * dr - nr * di) / den;
  }
}

// ---- Delay lines ----

/** A mono delay line (power-of-two ring) that counts frames written since its last reset; older frames read as 0. */
class DelayLine {
  readonly buf: Float32Array;
  readonly mask: number;
  w = 0;
  written = 0;

  constructor(frames: number) {
    this.buf = new Float32Array(nextPow2(frames + 8));
    this.mask = this.buf.length - 1;
  }

  reset(): void {
    this.written = 0;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
    if (this.written <= this.mask) this.written++;
  }

  /** x[n − d] for a fractional d ≥ 2 (cubic Hermite), read before this frame's write. */
  read(d: number): number {
    const i = Math.floor(d), t = 1 - (d - i);
    const b = this.buf, m = this.mask, p = this.w - i;
    let ym1: number, y0: number, y1: number, y2: number;
    if (i + 2 <= this.written) {
      ym1 = b[(p - 2) & m];
      y0 = b[(p - 1) & m];
      y1 = b[p & m];
      y2 = b[(p + 1) & m];
    } else {
      ym1 = this.at(i + 2);
      y0 = this.at(i + 1);
      y1 = this.at(i);
      y2 = this.at(i - 1);
    }
    const c1 = 0.5 * (y1 - ym1);
    const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    return ((c3 * t + c2) * t + c1) * t + y0;
  }

  /** x[n − j] for an integer j ≥ 1; 0 when not written since the reset. */
  at(j: number): number {
    return j >= 1 && j <= this.written ? this.buf[(this.w - j) & this.mask] : 0;
  }
}

/**
 * One read head of a delay line. A change under 3 % slews the length over `slewFrames` (tape-style); a larger one
 * crossfades two taps over 30 ms, and a new target during that fade retargets the incoming tap. Tape always slews.
 */
class Tap {
  cur = -1;
  private target = 0;
  private step = 0;
  private next = -1;
  private fade = 0;
  private readonly fadeInc: number;

  constructor(sampleRate: number) {
    this.fadeInc = 1 / (0.03 * sampleRate);
  }

  reset(): void {
    this.cur = -1;
    this.next = -1;
    this.step = 0;
    this.fade = 0;
  }

  set(frames: number, slewFrames: number, alwaysSlew: boolean): void {
    if (this.cur < 0) {
      this.cur = this.target = frames;
      return;
    }
    if (this.next >= 0) {
      this.next = this.target = frames;
      return;
    }
    if (Math.abs(frames - this.target) < 1e-6) return;
    this.target = frames;
    if (alwaysSlew || Math.abs(frames - this.cur) < 0.03 * this.cur) {
      this.step = (frames - this.cur) / Math.max(1, slewFrames);
    } else {
      this.step = 0;
      this.next = frames;
      this.fade = 0;
    }
  }

  /** Reads one frame at the head (plus `mod` frames) and advances the slew or fade. */
  read(line: DelayLine, mod: number): number {
    if (this.step !== 0) {
      this.cur += this.step;
      if (this.step > 0 ? this.cur >= this.target : this.cur <= this.target) {
        this.cur = this.target;
        this.step = 0;
      }
    }
    const y = line.read(Math.max(2, this.cur + mod));
    if (this.next < 0) return y;
    this.fade += this.fadeInc;
    const y2 = line.read(Math.max(2, this.next + mod));
    if (this.fade >= 1) {
      this.cur = this.next;
      this.next = -1;
      this.fade = 0;
      return y2;
    }
    return y + this.fade * (y2 - y);
  }
}

/** D modes. */
export const DELAY_MODES = { digital: 0, pingpong: 1, dual: 2, tape: 3, comb: 4 } as const;
/** Longest delay time (§1 Buffers); a longer time halves BEATS until it fits. */
const DELAY_SECONDS = 4.5;
const LOOP_SLOTS = 3;

/**
 * D: two lines with Hermite reads. Each pass runs the loop filters (HP ≥ 80 Hz except comb), the saturator
 * tanh(d·x)/d, the DC blocker and the flush before the write, so successive echoes differ by fb·H_loop. The read
 * length is shortened by the loop's phase delay at the reference frequency (1 kHz, or f0 for comb) so echoes land on
 * time and comb peaks sit on k·f0.
 */
export class DelayBlock {
  readonly maxFrames: number;
  readonly line0: DelayLine;
  readonly line1: DelayLine;
  readonly tap0: Tap;
  readonly tap1: Tap;
  readonly loop: Svf[] = [];
  readonly dc: DcBlock;
  nLoop = 0;
  mode = 0;
  fb = 0;
  cross = 0;
  drive = 1;
  /** Output scale (resonance normalisation for comb). */
  norm = 1;
  /** Dual pan gains: line 0 → L/R, line 1 → L/R. */
  p0L = 1;
  p0R = 1;
  p1L = 1;
  p1R = 1;
  wowFrames = 0;
  flutterFrames = 0;
  private wowC = 1;
  private wowS = 0;
  private wowCd = 1;
  private wowSd = 0;
  private flC = 1;
  private flS = 0;
  private flCd = 1;
  private flSd = 0;
  private fbCur = 0;
  private readonly fs: number;
  private readonly resp = { re: 1, im: 0 };

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.maxFrames = Math.ceil(DELAY_SECONDS * sampleRate);
    const size = this.maxFrames + Math.ceil(0.004 * sampleRate);
    this.line0 = new DelayLine(size);
    this.line1 = new DelayLine(size);
    this.tap0 = new Tap(sampleRate);
    this.tap1 = new Tap(sampleRate);
    for (let i = 0; i < LOOP_SLOTS; i++) this.loop.push(new Svf(sampleRate, "hp"));
    this.dc = new DcBlock(sampleRate);
  }

  reset(): void {
    this.line0.reset();
    this.line1.reset();
    this.tap0.reset();
    this.tap1.reset();
    for (const f of this.loop) f.reset();
    this.dc.reset();
    this.fbCur = this.fb;
    this.wowC = this.flC = 1;
    this.wowS = this.flS = 0;
  }

  /** Sets loop filter `i` (snap at first use). */
  setLoop(i: number, mode: SvfMode, hz: number, q: number, snap: boolean): void {
    this.loop[i].setMode(mode);
    this.loop[i].set(hz, q, snap);
  }

  /** Wow and flutter: rate in Hz, depth in ms. */
  setMod(wowHz: number, wowMs: number, flHz: number, flMs: number): void {
    this.wowFrames = (wowMs * this.fs) / 1000;
    this.flutterFrames = (flMs * this.fs) / 1000;
    this.wowCd = Math.cos((TAU * wowHz) / this.fs);
    this.wowSd = Math.sin((TAU * wowHz) / this.fs);
    this.flCd = Math.cos((TAU * flHz) / this.fs);
    this.flSd = Math.sin((TAU * flHz) / this.fs);
  }

  /** Loop phase delay in frames at `hz` (filters and DC blocker). */
  phaseDelay(hz: number): number {
    let re = 1, im = 0;
    for (let i = 0; i < this.nLoop; i++) {
      const f = this.loop[i];
      f.respond(hz);
      const r = re * f.re - im * f.im;
      im = re * f.im + im * f.re;
      re = r;
    }
    this.dc.respond(hz, this.fs, this.resp);
    const r = re * this.resp.re - im * this.resp.im;
    im = re * this.resp.im + im * this.resp.re;
    return (-Math.atan2(im, r) / (TAU * hz)) * this.fs;
  }

  /** |H_loop(hz)| of the loop filters and DC blocker at their targets. */
  loopMagnitude(hz: number): number {
    let mag = 1;
    for (let i = 0; i < this.nLoop; i++) {
      const f = this.loop[i];
      f.respond(hz);
      mag *= Math.hypot(f.re, f.im);
    }
    this.dc.respond(hz, this.fs, this.resp);
    return mag * Math.hypot(this.resp.re, this.resp.im);
  }

  /** Sets the read lengths (frames, before compensation) for line 0 and line 1. */
  setTimes(t0: number, t1: number, slewFrames: number, refHz: number): void {
    const pd = this.phaseDelay(refHz);
    const tape = this.mode === DELAY_MODES.tape;
    const hi = this.maxFrames;
    this.tap0.set(clamp(t0 - pd, 2, hi), slewFrames, tape);
    this.tap1.set(clamp(t1 - pd, 2, hi), slewFrames, tape);
  }

  /** Runs n frames: inputs are the send signal, outputs the wet lines (before the send level). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number): void {
    const mode = this.mode, drive = this.drive, cross = this.cross, norm = this.norm;
    const l0 = this.line0, l1 = this.line1, t0 = this.tap0, t1 = this.tap1, dc = this.dc;
    const nLoop = this.nLoop, loop = this.loop;
    let fb = this.fbCur;
    const fbStep = (this.fb - fb) / n;
    const tape = mode === DELAY_MODES.tape, wf = this.wowFrames, ff = this.flutterFrames;
    for (let i = 0; i < n; i++) {
      fb += fbStep;
      let mod = 0;
      if (tape) {
        const wc = this.wowC * this.wowCd - this.wowS * this.wowSd;
        this.wowS = this.wowS * this.wowCd + this.wowC * this.wowSd;
        this.wowC = wc;
        const fc = this.flC * this.flCd - this.flS * this.flSd;
        this.flS = this.flS * this.flCd + this.flC * this.flSd;
        this.flC = fc;
        mod = wf * this.wowS + ff * this.flS;
      }
      const y0 = t0.read(l0, mod), y1 = t1.read(l1, mod);
      let s0: number, s1: number;
      if (mode === 1) {
        s0 = 0.5 * (inL[i] + inR[i]) + fb * y1;
        s1 = fb * y0;
      } else if (mode === 2) {
        const m = 0.5 * (inL[i] + inR[i]);
        s0 = m + fb * y0 + cross * y1;
        s1 = m + fb * y1 + cross * y0;
      } else {
        s0 = inL[i] + fb * y0;
        s1 = inR[i] + fb * y1;
      }
      for (let j = 0; j < nLoop; j++) {
        const f = loop[j];
        f.tick(s0, s1);
        s0 = f.yL;
        s1 = f.yR;
      }
      dc.tick(sat(s0, drive), sat(s1, drive));
      l0.write(dc.yL);
      l1.write(dc.yR);
      if (mode === 2) {
        outL[i] = this.p0L * y0 + this.p1L * y1;
        outR[i] = this.p0R * y0 + this.p1R * y1;
      } else {
        outL[i] = norm * y0;
        outR[i] = norm * y1;
      }
    }
    this.fbCur = this.fb;
    // Keep the LFO rotations on the unit circle.
    const wn = 1 / Math.hypot(this.wowC, this.wowS), fn = 1 / Math.hypot(this.flC, this.flS);
    this.wowC *= wn;
    this.wowS *= wn;
    this.flC *= fn;
    this.flS *= fn;
  }
}

/** Equal-power pan gain of channel `ch` (0 = L) for p in −1..1, capped at unity (no boost toward a side). */
export function panGain(p: number, ch: 0 | 1): number {
  const th = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return Math.min(1, Math.SQRT2 * (ch === 0 ? Math.cos(th) : Math.sin(th)));
}

// ---- LFO shapes (0..1, 1 at the value) ----

/** 0 = none, 1 = sine, 2 = triangle. */
export function lfoShape(shape: number, phase: number): number {
  const u = phase - Math.floor(phase);
  return shape === 1 ? 0.5 + 0.5 * Math.sin(TAU * u) : u < 0.5 ? 2 * u : 2 - 2 * u;
}

/**
 * D short (flanger/chorus, 0.3–8 ms): the delay sweeps from `msLo` to `msHi` (log scale) by an LFO in beats or Hz; the
 * output is (1 − mix)·x + mix·√(1 − fb²)·delayed, so a resonant setting does not jump in level.
 */
export class ShortDelay {
  msHi = 6;
  msLo = 6;
  depth = 1;
  /** 0 none, 1 sine, 2 triangle. */
  lfo = 0;
  periodBeats = 1;
  hz = 0;
  fb = 0;
  mix = 0.5;
  private readonly lineL: DelayLine;
  private readonly lineR: DelayLine;
  private readonly dc: DcBlock;
  private readonly fs: number;
  private phase = 0;
  private lnCur = Math.log(6);
  private fbCur = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.lineL = new DelayLine(Math.ceil(0.012 * sampleRate));
    this.lineR = new DelayLine(Math.ceil(0.012 * sampleRate));
    this.dc = new DcBlock(sampleRate);
  }

  reset(): void {
    this.lineL.reset();
    this.lineR.reset();
    this.dc.reset();
    this.phase = 0;
    this.lnCur = Math.log(this.msHi);
    this.fbCur = this.fb;
  }

  /** In place over n frames; the LFO follows B (or runs at `hz`). */
  process(l: Float32Array, r: Float32Array, n: number, clock: QuantumClock): void {
    const fpm = this.fs / 1000;
    const lnHi = Math.log(clamp(this.msHi, 0.05, 10)), lnLo = Math.log(clamp(this.msLo, 0.05, 10));
    const lnStep = (lnHi - this.lnCur) / n;
    let lnBase = this.lnCur;
    const span = (lnLo - lnHi) * this.depth;
    const useBeats = this.hz <= 0;
    const dPhase = useBeats ? clamp(clamp(clock.beatsPerFrame, 0, 1) / Math.max(1e-6, this.periodBeats), 0, 1) : this.hz / this.fs;
    let phase = useBeats ? clock.beat / Math.max(1e-6, this.periodBeats) : this.phase;
    let fb = this.fbCur;
    const fbStep = (this.fb - fb) / n;
    const mix = this.mix, dry = 1 - mix;
    for (let i = 0; i < n; i++) {
      lnBase += lnStep;
      fb += fbStep;
      const s = this.lfo === 0 ? 1 : lfoShape(this.lfo, phase);
      phase += dPhase;
      const d = Math.max(2, Math.exp(lnBase + span * (1 - s)) * fpm);
      const yL = this.lineL.read(d), yR = this.lineR.read(d);
      this.dc.tick(l[i] + fb * yL, r[i] + fb * yR);
      this.lineL.write(this.dc.yL);
      this.lineR.write(this.dc.yR);
      const norm = mix * Math.sqrt(1 - fb * fb);
      l[i] = dry * l[i] + norm * yL;
      r[i] = dry * r[i] + norm * yR;
    }
    this.lnCur = lnHi;
    this.fbCur = this.fb;
    if (!useBeats) this.phase = phase - Math.floor(phase);
  }
}

/** F phaser: 6–8 first-order all-passes swept lo..hi (log, sine LFO in beats) with feedback; level-normalised like D short. */
export class Phaser {
  stages = 6;
  lo = 250;
  hi = 4000;
  fb = 0;
  mix = 0.5;
  periodBeats = 8;
  private readonly zL = new Float64Array(8);
  private readonly zR = new Float64Array(8);
  private lastL = 0;
  private lastR = 0;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
  }

  reset(): void {
    this.zL.fill(0);
    this.zR.fill(0);
    this.lastL = this.lastR = 0;
  }

  process(l: Float32Array, r: Float32Array, n: number, clock: QuantumClock): void {
    const zL = this.zL, zR = this.zR, st = this.stages, fb = this.fb, mix = this.mix, dry = 1 - mix;
    const norm = mix * Math.sqrt(1 - fb * fb);
    const lnLo = Math.log(this.lo), span = Math.log(this.hi) - lnLo;
    let a = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        const s = lfoShape(1, (clock.beat + i * clock.beatsPerFrame) / this.periodBeats);
        const t = Math.tan((Math.PI * Math.exp(lnLo + span * s)) / this.fs);
        a = (t - 1) / (t + 1);
      }
      let uL = l[i] + fb * this.lastL, uR = r[i] + fb * this.lastR;
      for (let k = 0; k < st; k++) {
        const yL = a * uL + zL[k];
        zL[k] = uL - a * yL;
        uL = yL;
        const yR = a * uR + zR[k];
        zR[k] = uR - a * yR;
        uR = yR;
      }
      this.lastL = flush(uL);
      this.lastR = flush(uR);
      l[i] = dry * l[i] + norm * uL;
      r[i] = dry * r[i] + norm * uR;
    }
    for (let k = 0; k < st; k++) {
      zL[k] = flush(zL[k]);
      zR[k] = flush(zR[k]);
    }
  }
}

// ---- G: gate ----

/** Gate shapes. */
export const GATE_SHAPES = { square: 0, sine: 1, pattern: 2, pan: 3, pump: 4 } as const;

/**
 * G: gain = 1 − depth·s(step phase from B), so it is floored at 1 − depth. Square, pattern and pan edges are raised
 * cosines centred on the step boundaries; a slew limit just above their steepest slope (or the pump's attack) turns a
 * clock jump into a short ramp instead of a click.
 */
export class Gate {
  shape = 0;
  cycleBeats = 0.25;
  duty = 0.5;
  edgeMs = 2;
  depth = 0;
  tauBeats = 0.25;
  attackMs = 1;
  invert = false;
  readonly pattern = new Uint8Array(16);
  private depthCur = 0;
  private gL = 1;
  private gR = 1;
  private tL = 1;
  private tR = 1;
  /** B the next quantum would start at without a jump; after a jump the old phase crossfades out over one edge. */
  private nextBeat = Number.NaN;
  private oldBeat = 0;
  private jumpLeft = 0;
  private jumpLen = 0;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
  }

  reset(): void {
    this.gL = this.gR = 1;
    this.depthCur = this.depth;
    this.nextBeat = Number.NaN;
    this.jumpLeft = 0;
  }

  /** Sets a 16-step pattern, x = open. */
  setPattern(p: string): void {
    for (let i = 0; i < 16; i++) this.pattern[i] = p[i] === "x" ? 0 : 1;
  }

  /** The gain at step position `pos` (in cycles) into tL/tR; h and hp are the half edges in cycle units. */
  private target(pos: number, depth: number, h: number, hp: number): void {
    const shape = this.shape;
    const u = pos - Math.floor(pos);
    if (shape === 3) {
      // Even steps pan left, odd steps right; the side changes by a raised cosine centred on the boundary.
      const side = (Math.floor(pos) & 1) === 0 ? -1 : 1;
      let p = side;
      if (hp > 0 && u < hp) p = -side + 2 * side * rcStep(u / hp);
      else if (hp > 0 && u > 1 - hp) p = side - 2 * side * rcStep((u - 1) / hp);
      const th = ((depth * p + 1) * Math.PI) / 4;
      this.tL = Math.min(1, Math.SQRT2 * Math.cos(th));
      this.tR = Math.min(1, Math.SQRT2 * Math.sin(th));
      return;
    }
    let s: number;
    if (shape === 0) {
      const d = this.duty;
      if (h > 0 && u < h) s = 1 - rcStep(u / h);
      else if (h > 0 && u > 1 - h) s = 1 - rcStep((u - 1) / h);
      else if (u < d - h) s = 0;
      else if (h > 0 && u < d + h) s = rcStep((u - d) / h);
      else s = 1;
    } else if (shape === 1) {
      s = 0.5 - 0.5 * Math.cos(TAU * u);
    } else if (shape === 2) {
      const idx = Math.floor(pos), cur = this.pattern[idx & 15];
      s = cur;
      if (hp > 0 && u < hp) {
        const prev = this.pattern[(idx - 1) & 15];
        if (prev !== cur) s = prev + (cur - prev) * rcStep(u / hp);
      } else if (hp > 0 && u > 1 - hp) {
        const next = this.pattern[(idx + 1) & 15];
        if (next !== cur) s = cur + (next - cur) * rcStep((u - 1) / hp);
      }
    } else {
      const cycle = Math.max(1e-6, this.cycleBeats), t = u * cycle, tau = Math.max(1e-4, this.tauBeats);
      s = this.invert ? 1 - Math.exp(-(cycle - t) / tau) : Math.exp(-t / tau);
    }
    this.tL = this.tR = 1 - depth * s;
  }

  /** In place over n frames. */
  process(l: Float32Array, r: Float32Array, n: number, clock: QuantumClock): void {
    const shape = this.shape, cycle = Math.max(1e-6, this.cycleBeats), bpf = clock.beatsPerFrame;
    const edgeFrames = Math.max(1, (this.edgeMs * this.fs) / 1000);
    const atkFrames = Math.max(1, (this.attackMs * this.fs) / 1000);
    const maxStep = shape === 4 ? 1 / atkFrames : shape === 1 ? 2 : 2 / edgeFrames;
    // Half the edge in step-phase units, kept inside each state.
    const h = Math.min((0.5 * edgeFrames * Math.abs(bpf)) / cycle, 0.5 * Math.min(this.duty, 1 - this.duty));
    const hp = Math.min((0.5 * edgeFrames * Math.abs(bpf)) / cycle, 0.25);
    // A seek or re-phase: the old phase runs on and crossfades to the new one over one edge (raised cosine).
    if (clock.jumped && !Number.isNaN(this.nextBeat)) {
      this.oldBeat = this.nextBeat;
      this.jumpLen = this.jumpLeft = Math.ceil(edgeFrames);
    }
    let depth = this.depthCur;
    const dStep = (this.depth - depth) / n;
    let gL = this.gL, gR = this.gR;
    for (let i = 0; i < n; i++) {
      depth += dStep;
      this.target((clock.beat + i * bpf) / cycle, depth, h, hp);
      let tL = this.tL, tR = this.tR;
      if (this.jumpLeft > 0) {
        const c = 0.5 - 0.5 * Math.cos((Math.PI * (this.jumpLen - --this.jumpLeft)) / this.jumpLen);
        this.target((this.oldBeat + i * bpf) / cycle, depth, h, hp);
        tL = this.tL + c * (tL - this.tL);
        tR = this.tR + c * (tR - this.tR);
      }
      gL += clamp(tL - gL, -maxStep, maxStep);
      gR += clamp(tR - gR, -maxStep, maxStep);
      l[i] *= gL;
      r[i] *= gR;
    }
    if (this.jumpLeft > 0) this.oldBeat += n * bpf;
    this.nextBeat = clock.beat + n * bpf;
    this.gL = gL;
    this.gR = gR;
    this.depthCur = this.depth;
  }
}

// ---- C: crusher ----

/** C: fractional sample-and-hold at `rateHz` with continuous bit depth, and an optional post low-pass at `postLp`·rate. */
export class Crusher {
  bits = 16;
  rateHz = 48000;
  postLp = 0;
  readonly post: Svf;
  private holdL = 0;
  private holdR = 0;
  private phase = 1;
  private readonly fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.post = new Svf(sampleRate, "lp");
  }

  reset(): void {
    this.holdL = this.holdR = 0;
    this.phase = 1;
    this.post.reset();
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const inc = clamp(this.rateHz, 1, this.fs) / this.fs, q = 2 ** (clamp(this.bits, 1, 24) - 1), iq = 1 / q;
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      phase += inc;
      if (phase >= 1) {
        phase -= 1;
        this.holdL = Math.round(l[i] * q) * iq;
        this.holdR = Math.round(r[i] * q) * iq;
      }
      l[i] = this.holdL;
      r[i] = this.holdR;
    }
    this.phase = phase;
    if (this.postLp > 0) {
      this.post.set(this.postLp * this.rateHz, 0.7071);
      this.post.process(l, r, 0, n);
    }
  }
}

// ---- R: plate reverb ----

/** The plate's design rate: lengths below are in frames at this rate and rescale to fs. */
const PLATE_FS = 29761;
/** Input diffusion: six short all-passes (dense early echoes at every rate) ahead of the plate's four. */
const IN_AP = [19, 29, 41, 59, 83, 113, 142, 107, 379, 277];
const IN_COEF = [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.75, 0.75, 0.625, 0.625];
/** Tank elements: left ap1, d1, ap2, d2, then the same on the right. */
const TANK = [672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
const EXCURSION = 16;
const MAX_SIZE = 1.3;
const MAX_PRE_SECONDS = 1;
/** Output taps: [tank element, offset, sign] × 7 per side. */
const TAPS_L = [5, 266, 1, 5, 2974, 1, 6, 1913, -1, 7, 1996, 1, 1, 1990, -1, 2, 187, -1, 3, 1066, -1];
const TAPS_R = [1, 353, 1, 1, 3627, 1, 2, 1228, -1, 3, 2673, 1, 5, 2111, -1, 6, 335, -1, 7, 121, -1];
/** Lines in the shared buffer: pre-delay, the input all-passes, 8 tank elements, the shimmer window. */
const PRE = 0, IN0 = 1, TK0 = IN0 + IN_AP.length, SH = TK0 + 8, LINES = SH + 1;

/**
 * R: a Dattorro-style plate (input diffusion, then two cross-coupled branches of a modulated all-pass, a delay, damping,
 * a second all-pass and a delay), rescaled to fs and `size`. T60 is in seconds here; each branch applies its decay gain
 * twice, g = 10^(−1.5·τ/T60) with τ the branch length, capped at .97. Shimmer pitches the tank up an octave (two heads
 * at 2× with sin² windows) through a low-pass below fs/4 and a 120 Hz high-pass (the in-phase sum mode below 20 Hz
 * would otherwise lift the loop gain above 1) and feeds it back in. All lines share one buffer and one
 * write position.
 */
export class Reverb {
  size = 1;
  t60 = 2;
  preFrames = 0;
  damp = 0.35;
  mod = 1;
  shimmer = 0;
  readonly inHp: Svf;
  readonly gate: Gate;
  useGate = false;
  /** Set once the plate has been written (an unused plate is cleared lazily, on its next start). */
  dirty = false;
  private readonly fs: number;
  private readonly mem: Float32Array;
  private readonly base = new Int32Array(LINES);
  private readonly mask = new Int32Array(LINES);
  private readonly len = new Int32Array(8);
  private readonly inLen = new Int32Array(IN_AP.length);
  private readonly inCoef = Float64Array.from(IN_COEF);
  /** Per output tap: the absolute base, mask and offset of its line, and its sign; 7 per side. */
  private readonly tapBase = new Int32Array(14);
  private readonly tapMask = new Int32Array(14);
  private readonly tapOff = new Int32Array(14);
  private readonly tapSign = new Float32Array(14);
  private readonly shWin: Float32Array;
  private pos = 0;
  private gLeft = 0;
  private gRight = 0;
  private dampL = 0;
  private dampR = 0;
  private exc = 0;
  private lfoC = 1;
  private lfoS = 0;
  private readonly lfoCd: number;
  private readonly lfoSd: number;
  private sizeSet = -1;
  private readonly shLp: Svf;
  /** Keeps the tank's in-phase sum mode (below 20 Hz) out of the shimmer feed: through it the loop gain passes 1. */
  private readonly shHp: Svf;
  private shD = 0;
  /** The diffused input of one quantum. */
  private readonly xin = new Float32Array(4096);

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    const k = (sampleRate / PLATE_FS) * MAX_SIZE;
    const sizes = [Math.ceil(MAX_PRE_SECONDS * sampleRate)];
    for (const a of IN_AP) sizes.push(Math.ceil(a * k));
    TANK.forEach((t, i) => sizes.push(Math.ceil(t * k) + (i % 4 === 0 ? Math.ceil(2 * EXCURSION * k) + 4 : 0)));
    this.shWin = new Float32Array(2 * Math.round(0.025 * sampleRate));
    for (let d = 0; d < this.shWin.length; d++) this.shWin[d] = Math.sin((Math.PI * d) / this.shWin.length) ** 2;
    sizes.push(this.shWin.length);
    let total = 0;
    sizes.forEach((s, i) => {
      const size = nextPow2(s + 2);
      this.base[i] = total;
      this.mask[i] = size - 1;
      total += size;
    });
    this.mem = new Float32Array(total);
    this.inHp = new Svf(sampleRate, "hp");
    this.gate = new Gate(sampleRate);
    this.lfoCd = Math.cos((TAU * 0.9) / sampleRate);
    this.lfoSd = Math.sin((TAU * 0.9) / sampleRate);
    this.shLp = new Svf(sampleRate, "lp");
    this.shLp.set(0.2 * sampleRate, 0.7071, true);
    this.shHp = new Svf(sampleRate, "hp");
    this.shHp.set(120, 0.7071, true);
  }

  /** Clears the plate when it was used (at a voice start). */
  reset(): void {
    if (this.dirty) {
      this.mem.fill(0);
      this.dirty = false;
    }
    this.inHp.reset();
    this.shLp.reset();
    this.shHp.reset();
    this.gate.reset();
    this.dampL = this.dampR = 0;
    this.gLeft = this.gRight = 0;
  }

  private layout(): void {
    const k = (this.fs / PLATE_FS) * clamp(this.size, 0.5, MAX_SIZE);
    for (let i = 0; i < 8; i++) this.len[i] = Math.round(TANK[i] * k);
    for (let i = 0; i < IN_AP.length; i++) this.inLen[i] = Math.max(1, Math.round(IN_AP[i] * k));
    for (let t = 0; t < 14; t++) {
      const src = t < 7 ? TAPS_L : TAPS_R, j = (t % 7) * 3, line = TK0 + src[j];
      this.tapBase[t] = this.base[line];
      this.tapMask[t] = this.mask[line];
      this.tapOff[t] = Math.max(1, Math.round(src[j + 1] * k));
      this.tapSign[t] = src[j + 2];
    }
    this.exc = EXCURSION * (this.fs / PLATE_FS);
    this.sizeSet = this.size;
  }

  /** Branch length in seconds (for the decay gain). */
  branchSeconds(b: number): number {
    if (this.sizeSet !== this.size) this.layout();
    const o = b * 4;
    return (this.len[o] + this.len[o + 1] + this.len[o + 2] + this.len[o + 3]) / this.fs;
  }

  /** The decay gain of branch b for the current T60. */
  decayGain(b: number): number {
    return Math.min(0.97, 10 ** ((-1.5 * this.branchSeconds(b)) / Math.max(0.05, this.t60)));
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number, clock: QuantumClock): void {
    if (this.sizeSet !== this.size) this.layout();
    this.dirty = true;
    const mem = this.mem, B = this.base, M = this.mask, len = this.len, inLen = this.inLen, x = this.xin;
    const pos0 = this.pos;
    // Input HP and pre-delay, then the diffusion chain, each over the whole quantum (none of it is recursive across
    // stages, so tight per-stage loops give the same result as a per-sample pass).
    const bPre = B[PRE], mPre = M[PRE], preD = clamp(Math.round(this.preFrames), 0, mPre - 1), hp = this.inHp;
    for (let i = 0; i < n; i++) x[i] = 0.5 * (inL[i] + inR[i]);
    hp.processMono(x, n);
    for (let i = 0; i < n; i++) {
      const p = pos0 + i;
      mem[bPre + (p & mPre)] = x[i];
      x[i] = mem[bPre + ((p - preD) & mPre)];
    }
    for (let a = 0; a < IN_AP.length; a++) {
      const ba = B[IN0 + a], ma = M[IN0 + a], c = this.inCoef[a], d = inLen[a];
      for (let i = 0; i < n; i++) {
        const p = pos0 + i, old = mem[ba + ((p - d) & ma)];
        let v = x[i] - c * old;
        v = v < FLUSH && v > -FLUSH ? 0 : v;
        mem[ba + (p & ma)] = v;
        x[i] = c * v + old;
      }
    }
    // The tank, per sample.
    const gStepL = (this.decayGain(0) - this.gLeft) / n, gStepR = (this.decayGain(1) - this.gRight) / n;
    const damp = clamp(this.damp, 0, 0.95), exc = this.exc * this.mod, shimmer = this.shimmer;
    const bA1L = B[TK0], mA1L = M[TK0], lA1L = len[0], bD1L = B[TK0 + 1], mD1L = M[TK0 + 1], lD1L = len[1];
    const bA2L = B[TK0 + 2], mA2L = M[TK0 + 2], lA2L = len[2], bD2L = B[TK0 + 3], mD2L = M[TK0 + 3], lD2L = len[3];
    const bA1R = B[TK0 + 4], mA1R = M[TK0 + 4], lA1R = len[4], bD1R = B[TK0 + 5], mD1R = M[TK0 + 5], lD1R = len[5];
    const bA2R = B[TK0 + 6], mA2R = M[TK0 + 6], lA2R = len[6], bD2R = B[TK0 + 7], mD2R = M[TK0 + 7], lD2R = len[7];
    const bSh = B[SH], mSh = M[SH], win = this.shWin, shN = win.length, half = shN >> 1, shLp = this.shLp, shHp = this.shHp;
    let gl = this.gLeft, gr = this.gRight, dL = this.dampL, dR = this.dampR;
    let lc = this.lfoC, ls = this.lfoS, shD = this.shD;
    const cd = this.lfoCd, sd = this.lfoSd;
    for (let i = 0; i < n; i++) {
      const pos = pos0 + i;
      gl += gStepL;
      gr += gStepR;
      // Slow modulation of the first tank all-passes (quadrature).
      const c = lc * cd - ls * sd;
      ls = ls * cd + lc * sd;
      lc = c;
      // Cross-coupled feedback from the far end of each branch.
      const fbL = mem[bD2R + ((pos - lD2R) & mD2R)] * gr;
      const fbR = mem[bD2L + ((pos - lD2L) & mD2L)] * gl;
      let sh = 0;
      if (shimmer > 0) {
        mem[bSh + (pos & mSh)] = shLp.tickMono(shHp.tickMono(0.5 * (fbL + fbR)));
        shD = shD <= 0 ? shN - 1 : shD - 1;
        const dB = shD >= half ? shD - half : shD + half;
        const wA = win[shD];
        sh = shimmer * (wA * mem[bSh + ((pos - shD) & mSh)] + (1 - wA) * mem[bSh + ((pos - dB) & mSh)]);
      }
      const xi = x[i] + sh;
      // Left branch: all-pass (−.7, modulated), delay, damping, ×g, all-pass (.5), delay.
      // The modulated length stays positive, so | 0 truncates like floor.
      let d = lA1L + exc * ls, di = d | 0, f = d - di;
      let o0 = mem[bA1L + ((pos - di) & mA1L)];
      let old = o0 + f * (mem[bA1L + ((pos - di - 1) & mA1L)] - o0);
      let v = xi + fbL + 0.7 * old;
      v = v < FLUSH && v > -FLUSH ? 0 : v;
      mem[bA1L + (pos & mA1L)] = v;
      mem[bD1L + (pos & mD1L)] = old - 0.7 * v;
      let y = mem[bD1L + ((pos - lD1L) & mD1L)];
      dL = y + damp * (dL - y);
      dL = dL < FLUSH && dL > -FLUSH ? 0 : dL;
      y = dL * gl;
      old = mem[bA2L + ((pos - lA2L) & mA2L)];
      v = y - 0.5 * old;
      v = v < FLUSH && v > -FLUSH ? 0 : v;
      mem[bA2L + (pos & mA2L)] = v;
      mem[bD2L + (pos & mD2L)] = 0.5 * v + old;
      // Right branch.
      d = lA1R + exc * lc;
      di = d | 0;
      f = d - di;
      o0 = mem[bA1R + ((pos - di) & mA1R)];
      old = o0 + f * (mem[bA1R + ((pos - di - 1) & mA1R)] - o0);
      v = xi + fbR + 0.7 * old;
      v = v < FLUSH && v > -FLUSH ? 0 : v;
      mem[bA1R + (pos & mA1R)] = v;
      mem[bD1R + (pos & mD1R)] = old - 0.7 * v;
      y = mem[bD1R + ((pos - lD1R) & mD1R)];
      dR = y + damp * (dR - y);
      dR = dR < FLUSH && dR > -FLUSH ? 0 : dR;
      y = dR * gr;
      old = mem[bA2R + ((pos - lA2R) & mA2R)];
      v = y - 0.5 * old;
      v = v < FLUSH && v > -FLUSH ? 0 : v;
      mem[bA2R + (pos & mA2R)] = v;
      mem[bD2R + (pos & mD2R)] = 0.5 * v + old;
    }
    // Output taps across both branches, one tap at a time over the quantum.
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    const tB = this.tapBase, tM = this.tapMask, tO = this.tapOff, tS = this.tapSign;
    for (let t = 0; t < 14; t++) {
      const out = t < 7 ? outL : outR, b = tB[t], m = tM[t], g = 0.6 * tS[t], start = pos0 - tO[t];
      for (let i = 0; i < n; i++) out[i] += g * mem[b + ((start + i) & m)];
    }
    const nrm = 1 / Math.hypot(lc, ls);
    this.lfoC = lc * nrm;
    this.lfoS = ls * nrm;
    this.pos = (pos0 + n) & 0x3fffffff;
    this.gLeft = gl;
    this.gRight = gr;
    this.dampL = dL;
    this.dampR = dR;
    this.shD = shD;
    if (this.useGate) this.gate.process(outL, outR, n, clock);
  }
}

// ---- N: generators ----

/** Seeded xorshift32 white noise in [−1, 1). */
export class Noise {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0 || 0x9e3779b9 | 0;
  }
  seed(seed: number): void {
    this.s = seed | 0 || 0x9e3779b9 | 0;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return x / 2147483648;
  }
}

/** PolyBLEP residual for a step at phase 0 with increment dt. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Generator sources. */
export const GEN_KINDS = { noise: 0, tones: 1, clap: 2, snare: 3 } as const;
/** Hit patterns. */
export const HIT_KINDS = { "2&4": 0, every: 1, off: 2 } as const;

/**
 * N: noise, two alternating PolyBLEP tones through a band-pass, a clap (bursts + tail through a band-pass) or a snare
 * (a falling sine body + band-passed noise). Hit sources trigger on the hit pattern from B. The voice applies the level,
 * the fader and the envelope; `follow` and `rms` scale by the input here.
 */
export class Generator {
  kind = 0;
  /** Tones: f1, interval (semitones) and step in beats. */
  f1 = 880;
  interval = 7;
  stepBeats = 0.5;
  /** Hit pattern (−1 = continuous), and whether new hits may start. */
  hits = -1;
  triggers = true;
  /** Clap and snare shape (ms, Hz). */
  bursts = 3;
  gapMs = 10;
  tailMs = 120;
  bodyHz = 190;
  dropPct = 10;
  dropMs = 30;
  bodyDecayMs = 80;
  noiseDecayMs = 150;
  /** Input following: 0 none, 1 envelope (attack/release ms), 2 RMS. */
  follow = 0;
  attackMs = 1;
  releaseMs = 40;
  readonly tone: Svf;
  readonly filters: Svf[];
  nFilters = 0;
  readonly gate: Gate;
  useGate = false;
  readonly flanger: ShortDelay;
  useFlanger = false;
  private readonly nL = new Noise(1);
  private readonly nR = new Noise(2);
  private readonly fs: number;
  private phase = 0;
  private bodyPhase = 0;
  private t = 1e9;
  private end = 0;
  private nextHit = Number.NaN;
  private envF = 0;
  private ms = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.tone = new Svf(sampleRate, "bp");
    this.filters = [new Svf(sampleRate, "lp"), new Svf(sampleRate, "lp")];
    this.gate = new Gate(sampleRate);
    this.flanger = new ShortDelay(sampleRate);
  }

  reset(seed: number): void {
    this.nL.seed(seed);
    this.nR.seed(seed ^ 0x5bd1e995);
    this.phase = this.bodyPhase = 0;
    this.t = 1e9;
    this.nextHit = Number.NaN;
    this.envF = this.ms = 0;
    this.tone.reset();
    for (const f of this.filters) f.reset();
    this.gate.reset();
    this.flanger.reset();
    this.triggers = true;
  }

  /** True while a hit is still sounding. */
  get ringing(): boolean {
    return this.t < this.end;
  }

  /** The first hit at or after B = b: every beat, the off-beats, or beats 2 and 4 (odd B). */
  private firstHit(b: number): number {
    if (this.hits === 2) return Math.ceil(b - 0.5 - 1e-9) + 0.5;
    const h = Math.ceil(b - 1e-9);
    return this.hits === 1 || (h & 1) === 1 ? h : h + 1;
  }

  /** Writes n frames of the raw source into outL/outR; inL/inR drive `follow`. */
  process(outL: Float32Array, outR: Float32Array, n: number, clock: QuantumClock, inL: Float32Array, inR: Float32Array): void {
    const fs = this.fs, kind = this.kind, bpf = clock.beatsPerFrame;
    if (this.hits >= 0 && (Number.isNaN(this.nextHit) || clock.jumped || this.nextHit < clock.beat - 1)) this.nextHit = this.firstHit(clock.beat);
    const atk = Math.exp(-1 / Math.max(1, (this.attackMs * fs) / 1000)), rel = Math.exp(-1 / Math.max(1, (this.releaseMs * fs) / 1000));
    const msA = Math.exp(-1 / (0.1 * fs));
    if (kind === 1) {
      const step = Math.floor(clock.beat / Math.max(1e-6, this.stepBeats));
      const f = (step & 1) === 0 ? this.f1 : this.f1 * 2 ** (this.interval / 12);
      this.tone.set(f, 2);
      const dt = clamp(f / fs, 0, 0.45);
      for (let i = 0; i < n; i++) {
        let ph = this.phase + dt;
        if (ph >= 1) ph -= 1;
        this.phase = ph;
        let v = ph < 0.5 ? 1 : -1;
        v += blep(ph, dt);
        let p2 = ph + 0.5;
        if (p2 >= 1) p2 -= 1;
        v -= blep(p2, dt);
        outL[i] = outR[i] = this.tone.tickMono(v);
      }
    } else if (kind === 0) {
      for (let i = 0; i < n; i++) {
        outL[i] = this.nL.next();
        outR[i] = this.nR.next();
      }
    } else {
      const gap = Math.max(1, (this.gapMs * fs) / 1000), last = (this.bursts - 1) * gap;
      const tauB = 0.002 * fs, tauTail = (this.tailMs * fs) / 5000, end = kind === 2 ? last + 6 * tauTail : (this.noiseDecayMs * fs) / 125;
      this.end = end;
      const dropF = Math.max(1, (this.dropMs * fs) / 1000), bodyTau = (this.bodyDecayMs * fs) / 3000, noiseTau = (this.noiseDecayMs * fs) / 3000;
      this.tone.set(kind === 2 ? 1200 : 2500, 1.5);
      for (let i = 0; i < n; i++) {
        if (this.hits >= 0 && this.triggers && bpf > 0 && clock.beat + i * bpf >= this.nextHit) {
          this.t = 0;
          this.nextHit = this.hits === 0 ? this.nextHit + 2 : this.nextHit + 1;
        }
        const t = this.t;
        let v = 0;
        if (t < end) {
          const nz = this.nL.next();
          if (kind === 2) {
            const k = Math.floor(t / gap);
            let e = k < this.bursts ? Math.exp(-(t - k * gap) / tauB) : 0;
            if (t >= last) e = Math.max(e, 0.5 * Math.exp(-(t - last) / tauTail));
            v = 2 * this.tone.tickMono(nz * e);
          } else {
            const f = this.bodyHz * (1 - (this.dropPct / 100) * Math.min(1, t / dropF));
            this.bodyPhase += f / fs;
            if (this.bodyPhase >= 1) this.bodyPhase -= 1;
            v = 0.7 * Math.sin(TAU * this.bodyPhase) * Math.exp(-t / bodyTau) + this.tone.tickMono(nz * Math.exp(-t / noiseTau));
          }
          this.t = t + 1;
        } else this.tone.tickMono(0);
        outL[i] = outR[i] = v;
      }
    }
    for (let j = 0; j < this.nFilters; j++) this.filters[j].process(outL, outR, 0, n);
    if (this.useGate) this.gate.process(outL, outR, n, clock);
    if (this.useFlanger) this.flanger.process(outL, outR, n, clock);
    if (this.follow === 1) {
      let e = this.envF;
      for (let i = 0; i < n; i++) {
        const x = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
        e = x > e ? x + atk * (e - x) : x + rel * (e - x);
        outL[i] *= e;
        outR[i] *= e;
      }
      this.envF = flush(e);
    } else if (this.follow === 2) {
      let ms = this.ms;
      for (let i = 0; i < n; i++) {
        const p = 0.5 * (inL[i] * inL[i] + inR[i] * inR[i]);
        ms = p + msA * (ms - p);
        const g = Math.sqrt(ms);
        outL[i] *= g;
        outR[i] *= g;
      }
      this.ms = flush(ms);
    }
  }
}
