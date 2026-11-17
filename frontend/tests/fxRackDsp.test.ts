import { describe, expect, test } from "bun:test";
import { DelayBlock, Reverb } from "../src/lib/fxRack/blocks";
import { NodeClock } from "../src/lib/fxRack/clock";
import { FxRackEngine, setupDelay, softClip, type BlockContext } from "../src/lib/fxRack/core";
import { FX_PRESETS, presetById } from "../src/lib/fxRack/presets";
import { createSlicer } from "../src/lib/fxRack/slicer";
import type { CurveInputs, FxClockMsg, FxFromNode, FxPreset, FxToNode, QuantumClock } from "../src/lib/fxRack/types";

const RATES = [44100, 48000, 96000];
const BPM = 145;
const N = 128;
const FULL: CurveInputs = { a: 1, m: 1, rho: 1, t: 1e6 };

/** Seeded PRNG (mulberry32) in [0, 1). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fpbOf = (fs: number, bpm = BPM) => (fs * 60) / bpm;
/** Events land on quantum starts (the render hooks run once per quantum). */
const onQ = (f: number) => Math.round(f / N) * N;
/** A straight 145 BPM clock from frame 0 (B = 0 there). */
function straight(fs: number, extra: Partial<FxClockMsg> = {}): FxClockMsg {
  const fpb = fpbOf(fs);
  return { t: "clock", validFrom: 0, playing: true, knots: [0, 0, fpb * 1e6, 1e6], bpm: BPM, rate: 1, trusted: true, seek: false, ...extra };
}

/** An engine on a straight clock with helpers to render quanta. */
class Rig {
  readonly e: FxRackEngine;
  readonly msgs: FxFromNode[] = [];
  readonly fpb: number;
  frame = 0;
  amount = 1;
  fader = 1;
  /** Count of samples the clip changed, and the largest pre-clip peak. */
  clipped = 0;
  prePeak = 0;

  constructor(readonly fs: number, id?: string, beats?: number) {
    this.e = new FxRackEngine(fs, m => this.msgs.push(m), { createSlicer });
    this.fpb = fpbOf(fs);
    this.e.message(straight(fs));
    this.e.message({ t: "track", rootPc: 9, minor: true, keylock: true });
    if (id) this.e.message({ t: "preset", id, beats: beats ?? presetById(id)!.beats?.def ?? 0 });
  }

  send(m: FxToNode): void {
    this.e.message(m);
  }

  /** Renders x (mono, or L and R); `hook(frame)` runs before each quantum. */
  render(xL: Float32Array, xR: Float32Array = xL, hook?: (frame: number) => void): [Float32Array, Float32Array] {
    const n = xL.length, oL = new Float32Array(n), oR = new Float32Array(n);
    const params = { amount: new Float32Array([this.amount]), fader: new Float32Array([this.fader]) };
    for (let off = 0; off < n; off += N) {
      hook?.(this.frame);
      params.amount[0] = this.amount;
      params.fader[0] = this.fader;
      const len = Math.min(N, n - off);
      this.e.process([xL.subarray(off, off + len), xR.subarray(off, off + len)], [oL.subarray(off, off + len), oR.subarray(off, off + len)], params, this.frame);
      this.clipped += this.e.clipped;
      this.prePeak = Math.max(this.prePeak, this.e.prePeak);
      this.frame += len;
    }
    return [oL, oR];
  }

  silence(frames: number): [Float32Array, Float32Array] {
    return this.render(new Float32Array(frames));
  }
}

const sine = (fs: number, hz: number, frames: number, amp = 0.5, phase = 0) =>
  Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / fs + phase));

/** A Hann-windowed tone burst of `ms` at `hz`, placed at `at` in a buffer of `frames`. */
function burst(fs: number, hz: number, ms: number, amp: number, at: number, frames: number): Float32Array {
  const x = new Float32Array(frames), len = Math.round((ms * fs) / 1000);
  for (let i = 0; i < len; i++) x[at + i] = amp * Math.sin((2 * Math.PI * hz * i) / fs) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  return x;
}

/** Cross-correlation of `ref` (its first `len` samples from `at`) against y, best lag within [lo, hi], parabolic-refined. */
function bestLag(y: Float32Array, ref: Float32Array, at: number, len: number, lo: number, hi: number): { lag: number; value: number } {
  let best = -Infinity, bestK = lo;
  const corr = (k: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += ref[at + i] * y[at + i + k];
    return s;
  };
  for (let k = lo; k <= hi; k++) {
    const c = corr(k);
    if (c > best) {
      best = c;
      bestK = k;
    }
  }
  const a = corr(bestK - 1), b = best, c = corr(bestK + 1), den = a - 2 * b + c;
  return { lag: bestK + (den !== 0 ? (0.5 * (a - c)) / den : 0), value: best };
}

const energy = (x: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = Math.max(0, Math.floor(from)); i < Math.min(x.length, Math.floor(to)); i++) e += x[i] * x[i];
  return e;
};
const rms = (x: Float32Array, from = 0, to = x.length) => Math.sqrt(energy(x, from, to) / (to - from));
const maxD2 = (y: Float32Array, from: number, to: number) => {
  let m = 0;
  for (let i = Math.max(2, from); i < Math.min(y.length, to); i++) m = Math.max(m, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2]));
  return m;
};

/** Pink-ish noise (three one-pole sums over seeded white), scaled to `level` RMS. */
function pink(frames: number, seed: number, level = 0.1): Float32Array {
  const r = prng(seed), x = new Float32Array(frames);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < frames; i++) {
    const w = 2 * r() - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    x[i] = b0 + b1 + b2 + w * 0.1848;
  }
  const k = level / rms(x);
  for (let i = 0; i < frames; i++) x[i] *= k;
  return x;
}

function ctxOf(fs: number, p: FxPreset, beatsIndex = p.beats?.def ?? 0, rootPc: number | null = 9, keyRate = 1): BlockContext {
  const bv = p.beats ? p.beats.options[beatsIndex] : null;
  return { fs, fpb: fpbOf(fs), beats: typeof bv === "number" ? bv : 1, beatsValue: bv, rootPc, keyRate };
}
const quantumAt = (fs: number, beat = 0): QuantumClock =>
  ({ beat, beatsPerFrame: 1 / fpbOf(fs), framesPerBeat: fpbOf(fs), playing: true, jumped: false });

const delayPresets = FX_PRESETS.filter(p => p.delay);

describe("delay", () => {
  test("the first echo lands at round(t·beatFrames) ±1 for every BEATS value", () => {
    const echo = presetById("echo")!;
    for (const fs of RATES) {
      for (let b = 0; b < echo.beats!.options.length; b++) {
        const t = echo.beats!.options[b] as number, frames = Math.round(t * fpbOf(fs));
        const rig = new Rig(fs, "echo", b);
        rig.send({ t: "engage", lag: 0 });
        const at = 2048, len = Math.round(0.02 * fs);
        const x = burst(fs, 1000, 20, 0.01, at, at + frames + len + 4096);
        const [y] = rig.render(x);
        const wet = y.map((v, i) => v - x[i]);
        const { lag } = bestLag(wet, x, at, len, frames - 24, frames + 24);
        expect(Math.abs(lag - frames)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("on a −40 dBFS 1 kHz burst, successive echoes differ by fb·|H_loop(1 kHz)| ±1 %", () => {
    const echo = presetById("echo")!;
    for (const fs of RATES) {
      const rig = new Rig(fs, "echo", 3);
      rig.send({ t: "engage", lag: 0 });
      const frames = Math.round(0.75 * fpbOf(fs)), at = Math.round(0.3 * fs), len = Math.round(0.02 * fs);
      const x = burst(fs, 1000, 20, 0.01, at, at + 4 * frames + len + 2048);
      const [y] = rig.render(x);
      const wet = y.map((v, i) => v - x[i]);
      const e1 = bestLag(wet, x, at, len, frames - 24, frames + 24).value;
      const e2 = bestLag(wet, x, at, len, 2 * frames - 24, 2 * frames + 24).value;
      const e3 = bestLag(wet, x, at, len, 3 * frames - 24, 3 * frames + 24).value;
      const block = new DelayBlock(fs);
      setupDelay(block, echo.delay!, FULL, ctxOf(fs, echo, 3), quantumAt(fs), true);
      const expected = 0.78 * block.loopMagnitude(1000);
      expect(Math.abs(e2 / e1 / expected - 1)).toBeLessThan(0.01);
      expect(Math.abs(e3 / e2 / expected - 1)).toBeLessThan(0.01);
    }
  });

  test("ping-pong alternates sides", () => {
    for (const fs of RATES) {
      const rig = new Rig(fs, "ping-pong-delay", 3);
      rig.send({ t: "engage", lag: 0 });
      const frames = Math.round(0.75 * fpbOf(fs)), at = 2048;
      const x = burst(fs, 1000, 20, 0.05, at, at + 5 * frames + 4096);
      const [l, r] = rig.render(x);
      const w = Math.round(0.03 * fs);
      for (let k = 1; k <= 4; k++) {
        const c = at + k * frames, eL = energy(l.map((v, i) => v - x[i]), c - w, c + w), eR = energy(r.map((v, i) => v - x[i]), c - w, c + w);
        if (k % 2 === 1) expect(eL).toBeGreaterThan(20 * eR);
        else expect(eR).toBeGreaterThan(20 * eL);
      }
    }
  });

  test("polyrhythmic taps land at k·tA, k·tB and tA + tB", () => {
    for (const fs of RATES) {
      const rig = new Rig(fs, "polyrhythmic-delay", 0);
      rig.send({ t: "engage", lag: 0 });
      const fpb = fpbOf(fs), at = 2048, len = Math.round(0.02 * fs);
      const x = burst(fs, 1000, 20, 0.01, at, at + Math.round(3 * fpb) + 4096);
      const [l, r] = rig.render(x);
      const mono = l.map((v, i) => v + r[i] - 2 * x[i]);
      for (const beats of [0.75, 1.5, 2.25, 1, 2, 1.75]) {
        const frames = Math.round(beats * fpb);
        const { lag, value } = bestLag(mono, x, at, len, frames - 24, frames + 24);
        expect(Math.abs(lag - frames)).toBeLessThanOrEqual(1);
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  test("an impulse into each D preset loses energy every loop period", () => {
    const fs = 48000, fpb = fpbOf(fs);
    for (const p of delayPresets) {
      const ctx = ctxOf(fs, p), d = p.delay!, block = new DelayBlock(fs);
      const bv = ctx.beatsValue;
      let period: number;
      if (d.mode === "comb") period = 20 * Math.round(fs / 55);
      else if (d.mode === "dual" && Array.isArray(bv)) {
        const a = Math.round(bv[0] * 12), b = Math.round(bv[1] * 12), g = (x: number, y: number): number => (y ? g(y, x % y) : x);
        period = Math.round((((a * b) / g(a, b)) / 12) * fpb);
      } else period = Math.round((d.timeBeats === undefined || d.timeBeats === "beats" ? ctx.beats : d.timeBeats) * fpb);
      const total = 7 * period, inL = new Float32Array(N), inR = new Float32Array(N), oL = new Float32Array(total), oR = new Float32Array(total);
      for (let off = 0; off < total; off += N) {
        inL.fill(0);
        inR.fill(0);
        if (off === 0) inL[0] = inR[0] = 0.5;
        setupDelay(block, d, FULL, ctx, quantumAt(fs, off / fpb), off === 0);
        block.process(inL, inR, oL.subarray(off, off + N), oR.subarray(off, off + N), Math.min(N, total - off));
      }
      const e = (k: number) => energy(oL, k * period - period / 2, k * period + period / 2) + energy(oR, k * period - period / 2, k * period + period / 2);
      for (let k = 1; k < 6; k++) expect(e(k + 1)).toBeLessThan(e(k));
    }
  });

  test("every D preset at amount 1 has fb·max|H_loop| < 1, from blocks.ts's own filters", () => {
    for (const fs of RATES) {
      for (const p of delayPresets) {
        const d = p.delay!, block = new DelayBlock(fs);
        let worst = 0;
        // Sweep LFO phases and the beats since engage (Echo Out's rising HP).
        for (let beat = 0; beat <= 16; beat += 0.25) {
          setupDelay(block, d, { ...FULL, t: beat }, ctxOf(fs, p), quantumAt(fs, beat), true);
          let mag = 0;
          for (let k = 0; k <= 400; k++) mag = Math.max(mag, block.loopMagnitude(20 * 1000 ** (k / 400)));
          worst = Math.max(worst, (block.fb + block.cross) * mag);
        }
        expect(worst).toBeLessThan(1);
      }
    }
  });
});

describe("reverb", () => {
  function impulse(fs: number, t60Beats: number, seconds: number, damp = 0) {
    const r = new Reverb(fs), q = quantumAt(fs), frames = Math.round(seconds * fs);
    r.t60 = (t60Beats * fpbOf(fs)) / fs;
    r.damp = damp;
    r.inHp.set(80, 0.7071, true);
    const L = new Float32Array(frames), R = new Float32Array(frames), x = new Float32Array(N);
    for (let off = 0; off < frames; off += N) {
      x.fill(0);
      if (off === 0) x[0] = 1;
      r.process(x, x, L.subarray(off, off + N), R.subarray(off, off + N), Math.min(N, frames - off), q);
    }
    return { L, R };
  }

  test("Schroeder T60 within ±15 %", () => {
    for (const fs of RATES) {
      for (const beats of [4, 8]) {
        const t60 = (beats * fpbOf(fs)) / fs;
        const { L: l, R: r } = impulse(fs, beats, 1.6 * t60);
        const h = l.map((v, i) => v + r[i]);
        const edc = new Float64Array(h.length);
        let acc = 0;
        for (let i = h.length - 1; i >= 0; i--) edc[i] = acc += h[i] * h[i];
        const db = (i: number) => 10 * Math.log10(edc[i] / edc[0]);
        const at = (level: number) => {
          let i = 0;
          while (i < h.length - 1 && db(i) > level) i++;
          return i / fs;
        };
        const measured = 2 * (at(-35) - at(-5));
        expect(Math.abs(measured / t60 - 1)).toBeLessThan(0.15);
      }
    }
  });

  test("echo density ≥ .9 by 80 ms, L/R correlation < .3", () => {
    for (const fs of RATES) {
      const { L, R } = impulse(fs, 4, 1);
      const win = Math.round(0.02 * fs), c = Math.round(0.08 * fs);
      for (const h of [L, R]) {
        let s = 0;
        for (let i = c - win / 2; i < c + win / 2; i++) s += h[i] * h[i];
        const sigma = Math.sqrt(s / win);
        let over = 0;
        for (let i = c - win / 2; i < c + win / 2; i++) if (Math.abs(h[i]) > sigma) over++;
        expect(over / win / 0.3173).toBeGreaterThanOrEqual(0.9);
      }
      let lr = 0, ll = 0, rr = 0;
      for (let i = 0; i < L.length; i++) {
        lr += L[i] * R[i];
        ll += L[i] * L[i];
        rr += R[i] * R[i];
      }
      expect(Math.abs(lr / Math.sqrt(ll * rr))).toBeLessThan(0.3);
    }
  });

  test("a released reverb is idle by 2·T60 + .5 s", () => {
    for (const fs of RATES) {
      const rig = new Rig(fs, "reverb", 1);
      rig.send({ t: "engage", lag: 0 });
      rig.render(pink(Math.round(0.5 * fs), 3, 0.3));
      rig.send({ t: "release", atBeat: null });
      const t60 = (4 * fpbOf(fs)) / fs, limit = Math.round((2 * t60 + 0.5) * fs);
      let idleAt = -1;
      for (let f = 0; f < limit + fs && idleAt < 0; f += N) {
        rig.silence(N);
        if (!rig.e.busy) idleAt = f;
      }
      expect(idleAt).toBeGreaterThan(0);
      expect(idleAt).toBeLessThanOrEqual(limit);
      expect(rig.msgs.at(-1)).toEqual({ t: "state", engaged: false, tail: false });
    }
  });
});

describe("stability", () => {
  const fs = 48000;
  /** 2 s of noise plus a 110 Hz tone. */
  const burst2s = () => {
    const r = prng(11);
    return Float32Array.from({ length: 2 * fs }, (_, i) => 0.1 * (2 * r() - 1) + 0.2 * Math.sin((2 * Math.PI * 110 * i) / fs));
  };
  const peakOf = ([l, r]: [Float32Array, Float32Array]) => {
    let m = 0;
    for (let i = 0; i < l.length; i++) m = Math.max(m, Math.abs(l[i]), Math.abs(r[i]));
    return m;
  };

  test("T60-in-BEATS presets latched 60 s at the longest BEATS and 60 or 70 BPM keep decaying after a burst", () => {
    for (const bpm of [60, 70]) {
      for (const p of FX_PRESETS.filter(q => q.reverb?.t60Beats === "beats")) {
        const fpb = fpbOf(fs, bpm), rig = new Rig(fs, p.id, p.beats!.options.length - 1);
        rig.send({ ...straight(fs), knots: [0, 0, fpb * 1e6, 1e6], bpm });
        rig.send({ t: "engage", lag: 0 });
        rig.render(burst2s());
        const burstPre = rig.prePeak;
        rig.prePeak = 0;
        // The peak of each second after the burst: [2, 3) s … [59, 60) s.
        const peaks: number[] = [];
        for (let sec = 2; sec < 60; sec++) peaks.push(peakOf(rig.silence(fs)));
        const at10 = peaks[10 - 2], last = Math.max(peaks[56], peaks[57]);
        // The tail never rises above what the burst itself reached (before the clip).
        expect({ id: p.id, bpm, decays: last < at10, pre: rig.prePeak <= burstPre }).toEqual({ id: p.id, bpm, decays: true, pre: true });
        expect(rig.msgs.some(m => m.t === "fault")).toBe(false);
      }
    }
  }, 120000);

  test("a raw shimmer plate at the .97 decay cap keeps decaying", () => {
    for (const damp of [0.1, 0.35]) {
      const r = new Reverb(fs), q = quantumAt(fs), x = burst2s();
      r.t60 = 1000;
      r.shimmer = 0.35;
      r.damp = damp;
      r.inHp.set(80, 0.7071, true);
      const inp = new Float32Array(N), oL = new Float32Array(N), oR = new Float32Array(N);
      // Energy of each 10 s window.
      const e = new Float64Array(6);
      for (let off = 0; off < 60 * fs; off += N) {
        inp.fill(0);
        if (off < x.length) inp.set(x.subarray(off, off + N));
        r.process(inp, inp, oL, oR, N, q);
        for (let i = 0; i < N; i++) e[Math.floor(off / (10 * fs))] += oL[i] * oL[i] + oR[i] * oR[i];
      }
      for (let w = 2; w < 6; w++) expect({ damp, w, ok: e[w] < e[w - 1] }).toEqual({ damp, w, ok: true });
      expect(e[5]).toBeLessThan(1e-3 * e[1]);
    }
  }, 60000);
});

describe("gate", () => {
  test("edges within ±1 sample, duty .50 ± .01, closed gain 1 − depth ± .001", () => {
    for (const fs of RATES) {
      for (const id of ["simple-gate", "gate"]) {
        const p = presetById(id)!, rig = new Rig(fs, id);
        rig.amount = 0.6;
        rig.send({ t: "engage", lag: 0 });
        const frames = Math.round(8 * fpbOf(fs)), x = new Float32Array(frames).fill(1);
        const [y] = rig.render(x);
        const cycle = (p.beats!.options[p.beats!.def] as number) * fpbOf(fs), mid = 1 - 0.3;
        // From beat 2 on (amount and fades settled).
        const from = Math.round(2 * fpbOf(fs)), to = frames - 4;
        let open = 0, closedMin = 1, closedMax = 0;
        for (let i = from; i < to; i++) {
          if (y[i] > mid) open++;
          const u = (i / cycle) % 1;
          if (u > 0.6 && u < 0.9) {
            closedMin = Math.min(closedMin, y[i]);
            closedMax = Math.max(closedMax, y[i]);
          }
          if ((y[i - 1] > mid) !== (y[i] > mid)) {
            const edges = [Math.ceil(i / cycle - 0.5) * cycle, (Math.round(i / cycle - 0.5) + 0.5) * cycle];
            const nearest = Math.min(...edges.map(e => Math.abs(i - e)));
            expect(nearest).toBeLessThanOrEqual(1);
          }
        }
        expect(Math.abs(open / (to - from) - 0.5)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(closedMin - 0.4)).toBeLessThanOrEqual(0.001);
        expect(Math.abs(closedMax - 0.4)).toBeLessThanOrEqual(0.001);
      }
    }
  });
});

describe("level", () => {
  test("on pink noise at amount 1, output RMS ≤ +3 dB over dry and the clip acts on < 1 % of samples", () => {
    const fs = 48000, x = pink(fs * 6, 7, 0.1);
    for (const p of FX_PRESETS) {
      if (p.exit || p.gens) continue;
      const rig = new Rig(fs, p.id);
      rig.send({ t: "engage", lag: 0 });
      const [l, r] = rig.render(x);
      const gain = 20 * Math.log10((rms(l, fs) + rms(r, fs)) / (2 * rms(x, fs)));
      expect({ id: p.id, over: gain > 3 }).toEqual({ id: p.id, over: false });
      expect({ id: p.id, clip: rig.clipped / x.length >= 0.01 }).toEqual({ id: p.id, clip: false });
    }
  });
});

describe("timing and key", () => {
  /** Bandpass on DC: y = 0 while on, then the X fade back to dry (raised cosine, so tiny at first) starts at the release frame. */
  function releaseFrame(fs: number, mid?: (rig: Rig, frame: number) => void): number {
    const rig = new Rig(fs, "bandpass");
    rig.send({ t: "engage", lag: 0 });
    rig.send({ t: "release", atBeat: 16 });
    const frames = Math.round(18 * fpbOf(fs)), x = new Float32Array(frames).fill(1);
    const [y] = rig.render(x, x, f => mid?.(rig, f));
    let i = Math.round(4 * fpbOf(fs));
    while (i < frames && y[i] < 1e-7) i++;
    return i - 1;
  }

  test("a release lands on its beat ±1 frame, also after a rate change and after a nudge", () => {
    for (const fs of RATES) {
      const fpb = fpbOf(fs);
      expect(Math.abs(releaseFrame(fs) - 16 * fpb)).toBeLessThanOrEqual(1);
      // Rate 1.06 from beat 8.
      const f8 = Math.round(8 * fpb), slope = 1.06 / fpb;
      const rate = releaseFrame(fs, (rig, f) => {
        if (f === Math.floor(f8 / N) * N) rig.send({ ...straight(fs), knots: [f8, 8, f8 + 1e6, 8 + 1e6 * slope], rate: 1.06, validFrom: f8 });
      });
      expect(Math.abs(rate - (f8 + 8 / slope))).toBeLessThanOrEqual(1);
      // A Sync nudge of 0.02 beat at beat 8 (slews, not a seek).
      const nudge = releaseFrame(fs, (rig, f) => {
        if (f === Math.floor(f8 / N) * N) rig.send({ ...straight(fs), knots: [f8, 8.02, f8 + 1e6, 8.02 + 1e6 / fpb], validFrom: f8 });
      });
      expect(Math.abs(nudge - (f8 + 7.98 * fpb))).toBeLessThanOrEqual(1);
    }
  });

  /** The frequency in [lo, hi] (step `step` × f) with the most energy in h. */
  function peakHz(h: Float32Array, fs: number, lo: number, hi: number, step = 0.0005): number {
    let best = 0, bestF = lo;
    for (let f = lo; f <= hi; f *= 1 + step) {
      let re = 0, im = 0;
      for (let i = 0; i < h.length; i++) {
        const w = (2 * Math.PI * f * i) / fs;
        re += h[i] * Math.cos(w);
        im -= h[i] * Math.sin(w);
      }
      if (re * re + im * im > best) {
        best = re * re + im * im;
        bestF = f;
      }
    }
    return bestF;
  }

  test("with key lock off at rate 1.06, the comb peaks sit at k·rootHz ±0.5 %", () => {
    // The D block as the engine sets it up (the reverb Frost Comb feeds would add its own ripple to the spectrum).
    const p = presetById("frost-comb")!;
    for (const fs of RATES) {
      const block = new DelayBlock(fs), frames = 2 * fs, L = new Float32Array(frames), R = new Float32Array(frames), x = new Float32Array(N);
      for (let off = 0; off < frames; off += N) {
        x.fill(0);
        if (off === 0) x[0] = 0.2;
        setupDelay(block, p.delay!, FULL, ctxOf(fs, p, 1, 2, 1.06), quantumAt(fs), off === 0);
        block.process(x, x, L.subarray(off, off + N), R.subarray(off, off + N), N);
      }
      const root = (440 * 2 ** ((2 - 9) / 12)) / 4 * 1.06;
      for (let k = 1; k <= 4; k++) expect(Math.abs(peakHz(L, fs, k * root * 0.97, k * root * 1.03) / (k * root) - 1)).toBeLessThanOrEqual(0.005);
    }
  }, 60000);

  test("key lock off follows the deck rate; key lock on keeps the key (Alarm's tone)", () => {
    // D (293.66 Hz) folded into 700–1400 Hz.
    const fs = 48000, f1 = 440 * 2 ** ((2 - 9) / 12) * 4;
    for (const keylock of [false, true]) {
      const rig = new Rig(fs, "alarm", 0);
      rig.send({ ...straight(fs), rate: 1.06, knots: [0, 0, fpbOf(fs) * 1e6, 1.06e6] });
      rig.send({ t: "track", rootPc: 2, minor: false, keylock });
      rig.send({ t: "engage", lag: 0 });
      // The first half beat plays f1.
      const len = Math.round((0.4 * fpbOf(fs)) / 1.06), [l] = rig.render(new Float32Array(len));
      const want = f1 * (keylock ? 1 : 1.06);
      expect(Math.abs(peakHz(l.subarray(len >> 2), fs, want * 0.95, want * 1.05, 0.001) / want - 1)).toBeLessThanOrEqual(0.005);
    }
  });
});

describe("clicks", () => {
  const fs = 48000, fpb = fpbOf(fs), bar = Math.round(4 * fpb), win = Math.round(0.005 * fs);
  const x = sine(fs, 440, 5 * bar);
  const dry = maxD2(x, 2, x.length);

  /** Max |Δ²y| of a preset over one steady bar. */
  function steady(id: string): number {
    const rig = new Rig(fs, id);
    rig.send({ t: "engage", lag: 0 });
    const [l, r] = rig.render(x.subarray(0, 3 * bar));
    return Math.max(maxD2(l, 2 * bar, 3 * bar), maxD2(r, 2 * bar, 3 * bar));
  }

  test("engage and release stay within 2× the larger of dry and steady-state |Δ²y|", () => {
    for (const p of FX_PRESETS) {
      const bound = 2 * Math.max(dry, steady(p.id));
      const rig = new Rig(fs, p.id), engageAt = onQ(bar), releaseAt = onQ(3 * bar);
      const [l, r] = rig.render(x.subarray(0, 4 * bar), x.subarray(0, 4 * bar), f => {
        if (f === engageAt) rig.send({ t: "engage", lag: 0 });
        if (f === releaseAt) rig.send({ t: "release", atBeat: null });
      });
      // B and C wait for a step or line; check every frame where the output starts to change after the release.
      for (const at of [engageAt, releaseAt]) {
        const m = Math.max(maxD2(l, at - win, at + win), maxD2(r, at - win, at + win));
        expect({ id: p.id, at, ok: m <= bound }).toEqual({ id: p.id, at, ok: true });
      }
      const m = Math.max(maxD2(l, releaseAt, 4 * bar), maxD2(r, releaseAt, 4 * bar));
      expect({ id: p.id, tail: m <= bound }).toEqual({ id: p.id, tail: true });
      expect(rig.msgs.some(msg => msg.t === "state" && msg.engaged)).toBe(true);
    }
  }, 120000);

  test("slice edges of the unpitched slicers stay within 2× the dry signal's |Δ²y|", () => {
    for (const id of ["roll", "flashback", "tri-step", "scramble", "rapid-fire", "bounce"]) {
      const rig = new Rig(fs, id);
      rig.send({ t: "engage", lag: 0 });
      const [l, r] = rig.render(x.subarray(0, 3 * bar));
      // Slicing is really on: the output leaves the live sine by most of its swing.
      let off = 0;
      for (let i = bar; i < 3 * bar; i++) off = Math.max(off, Math.abs(l[i] - x[i]));
      expect({ id, slicing: off > 0.5 }).toEqual({ id, slicing: true });
      const m = Math.max(maxD2(l, bar, 3 * bar), maxD2(r, bar, 3 * bar));
      expect({ id, ok: m <= 2 * dry }).toEqual({ id, ok: true });
    }
  });

  test("a latched Reverse held 6 s: exact reversal, no click at the press, the cap or the release", () => {
    const press = onQ(6 * fs), off = onQ(12 * fs), y = sine(fs, 440, 13 * fs);
    const rig = new Rig(fs, "reverse");
    const states: { engaged: boolean; at: number }[] = [];
    const [l, r] = rig.render(y, y, f => {
      if (f === press) rig.send({ t: "engage", lag: 0 });
      if (f === off) rig.send({ t: "release", atBeat: null });
      for (const msg of rig.msgs.splice(0)) if (msg.t === "state") states.push({ engaged: msg.engaged, at: f });
    });
    // out[C + k] = in[C − 1 − k] through the first 3 s, once the 5 ms insert fade-in is over.
    let err = 0;
    for (let k = 0.005 * fs; k < 3 * fs; k++) err = Math.max(err, Math.abs(l[press + k] - y[press - 1 - k]));
    expect(err).toBeLessThan(1e-5);
    // A reversed sine has the dry's |Δ²y|, so the whole run, cap and release included, stays within 2× it.
    expect(Math.max(maxD2(l, 2, l.length), maxD2(r, 2, r.length))).toBeLessThanOrEqual(2 * dry);
    // At its cap (ring/2 − 1 b, about 3.8 s) Reverse ends itself and the node reports it, before the DJ lets go.
    const end = states.find(st => !st.engaged);
    expect(states[0]).toEqual({ engaged: true, at: press + N });
    expect(end!.at).toBeGreaterThan(press + 3.5 * fs);
    expect(end!.at).toBeLessThan(off);
    // Live again after the cap.
    let live = 0;
    for (let i = end!.at + 0.1 * fs; i < off; i++) live = Math.max(live, Math.abs(l[i] - y[i]));
    expect(live).toBeLessThan(1e-6);
  }, 60000);

  test("switches, three switches within 30 ms, a seek re-phase and a slewing delay time", () => {
    const pairs = [["echo", "reverb"], ["gate", "lowpass"], ["polyrhythmic-delay", "flanger"], ["echo-out", "highpass"], ["phaser", "tremolo-gate"]];
    for (const [a, b] of pairs) {
      const bound = 2 * Math.max(dry, steady(a), steady(b));
      const rig = new Rig(fs, a), at = onQ(2 * bar);
      rig.send({ t: "engage", lag: 0 });
      const [l] = rig.render(x.subarray(0, 3 * bar), undefined, f => {
        if (f === at) rig.send({ t: "preset", id: b, beats: presetById(b)!.beats?.def ?? 0 });
      });
      expect({ a, b, ok: maxD2(l, at - win, at + win) <= bound }).toEqual({ a, b, ok: true });
    }
    // Three switches within 30 ms.
    const ids = ["echo", "flanger", "gate", "lowpass"];
    const bound = 2 * Math.max(dry, ...ids.map(steady));
    const rig = new Rig(fs, ids[0]), at = onQ(2 * bar), step = onQ(0.01 * fs);
    rig.send({ t: "engage", lag: 0 });
    const [l] = rig.render(x.subarray(0, 3 * bar), undefined, f => {
      for (let k = 1; k <= 3; k++) if (f === at + (k - 1) * step) rig.send({ t: "preset", id: ids[k], beats: presetById(ids[k])!.beats?.def ?? 0 });
    });
    expect(maxD2(l, at - win, at + 3 * step + 2 * win)).toBeLessThanOrEqual(bound);
    // A seek re-phases a gate.
    for (const id of ["simple-gate", "slice-gate", "strobe-pan", "sidechain"]) {
      const g = new Rig(fs, id), gb = 2 * Math.max(dry, steady(id)), seekAt = onQ(2 * bar) + 37 * N;
      g.send({ t: "engage", lag: 0 });
      const [gl, gr] = g.render(x.subarray(0, 3 * bar), undefined, f => {
        if (f === seekAt) g.send({ ...straight(fs), validFrom: seekAt, knots: [seekAt, 101.37, seekAt + 1e6, 101.37 + 1e6 / fpb], seek: true });
      });
      expect({ id, ok: Math.max(maxD2(gl, seekAt - win, seekAt + win), maxD2(gr, seekAt - win, seekAt + win)) <= gb }).toEqual({ id, ok: true });
    }
    // A delay time moving 0.2 % every 50 ms for 2 s (Sync rewriting the rate). At amount .5 the echoes cannot add up
    // past the clip whatever their phase against the sine, so the bound compares like with like.
    const steadyHalf = (() => {
      const s = new Rig(fs, "echo");
      s.amount = 0.5;
      s.send({ t: "engage", lag: 0 });
      const [l] = s.render(x.subarray(0, 3 * bar));
      return maxD2(l, 2 * bar, 3 * bar);
    })();
    const e = new Rig(fs, "echo"), eb = 2 * Math.max(dry, steadyHalf), every = Math.round(0.05 * fs / N) * N;
    e.amount = 0.5;
    e.send({ t: "engage", lag: 0 });
    let rate = 1, beat = 0, last = 0;
    const [el] = e.render(sine(fs, 440, 3 * fs), undefined, f => {
      if (f >= fs && f < 3 * fs && f - last >= every) {
        beat += ((f - last) * rate) / fpb;
        last = f;
        rate *= 1.002;
        e.send({ ...straight(fs), validFrom: f, rate, knots: [f, beat, f + 1e6, beat + (1e6 * rate) / fpb] });
      } else if (f < fs) {
        beat = f / fpb;
        last = f;
      }
    });
    expect(maxD2(el, fs, 3 * fs)).toBeLessThanOrEqual(eb);
  }, 60000);
});

describe("fuzz", () => {
  test("500 seeded runs stay finite, bounded, never subnormal, and reach idle", () => {
    const rates = [44100, 48000];
    for (let run = 0; run < 500; run++) {
      const rnd = prng(1000 + run), fs = rates[run % 2], frames = Math.round(0.5 * fs);
      const p = FX_PRESETS[Math.floor(rnd() * FX_PRESETS.length)];
      const rig = new Rig(fs, p.id, p.beats ? Math.floor(rnd() * p.beats.options.length) : 0);
      rig.amount = rnd();
      const bpm = 60 + rnd() * 120;
      const x = new Float32Array(frames);
      for (let i = 0; i < frames; i++) x[i] = 0.5 * Math.sin(i * 0.05 * (1 + rnd() * 0.01)) * rnd();
      const events = new Map<number, () => void>();
      const q = () => Math.floor((rnd() * frames) / N) * N;
      events.set(0, () => {
        rig.send({ ...straight(fs), knots: [0, 0, 1e7, (1e7 * bpm) / (60 * fs)], bpm });
        rig.send({ t: "engage", lag: rnd() * 0.02 });
      });
      for (let k = 0; k < 6; k++) {
        const kind = Math.floor(rnd() * 8), at = q();
        events.set(at, () => {
          if (kind === 0) rig.send({ t: "release", atBeat: rnd() < 0.5 ? null : "bar" });
          else if (kind === 1) rig.send({ t: "engage", lag: 0 });
          else if (kind === 2) {
            const o = FX_PRESETS[Math.floor(rnd() * FX_PRESETS.length)];
            rig.send({ t: "preset", id: o.id, beats: o.beats ? Math.floor(rnd() * o.beats.options.length) : 0 });
          } else if (kind === 3) rig.send({ ...straight(fs), validFrom: at, playing: false });
          else if (kind === 4) rig.send({ ...straight(fs), validFrom: at, seek: true, knots: [at, rnd() * 300, at + 1e7, rnd() * 300 + 1e7 / fpbOf(fs)] });
          else if (kind === 5) for (let i = at; i < Math.min(frames, at + 300); i++) x[i] = Number.NaN;
          else if (kind === 6) rig.amount = rnd();
          else rig.fader = rnd();
        });
      }
      const empty = q();
      const params = { amount: new Float32Array(1), fader: new Float32Array(1) };
      const out = [new Float32Array(N), new Float32Array(N)];
      const check = (o: Float32Array[]) => {
        for (const ch of o) for (const v of ch) {
          if (!Number.isFinite(v) || Math.abs(v) > 1 || (v !== 0 && Math.abs(v) < 1.2e-38)) throw new Error(`run ${run} (${p.id}): ${v}`);
        }
      };
      for (let f = 0; f < frames; f += N) {
        events.get(f)?.();
        params.amount[0] = rig.amount;
        params.fader[0] = rig.fader;
        const input = f === empty ? [] : [x.subarray(f, f + N), x.subarray(f, f + N)];
        rig.e.process(input, out, params, rig.frame);
        rig.frame += N;
        check(out);
        expect(rig.e.prePeak).toBeLessThanOrEqual(4);
      }
      // Playing again, then release (the host re-sends a pending release after a seek, so release on the new clock).
      rig.send({ ...straight(fs), validFrom: rig.frame, knots: [rig.frame, 0, rig.frame + 1e7, (1e7 * bpm) / (60 * fs)], bpm });
      const silent = [new Float32Array(N), new Float32Array(N)];
      rig.e.process(silent, out, params, rig.frame);
      rig.frame += N;
      rig.send({ t: "release", atBeat: null });
      let left = Math.round(60 * fs);
      while (rig.e.busy && left > 0) {
        rig.e.process(silent, out, params, rig.frame);
        rig.frame += N;
        left -= N;
        check(out);
      }
      expect({ run, id: p.id, idle: !rig.e.busy }).toEqual({ run, id: p.id, idle: true });
      expect(rig.msgs.some(m => m.t === "fault")).toBe(false);
    }
  }, 300000);
});

describe("fault guard", () => {
  test("a finite runaway (pre-clip peak far above any preset) resets to dry and posts fault", () => {
    const fs = 48000, rig = new Rig(fs, "echo");
    rig.send({ t: "engage", lag: 0 });
    rig.render(sine(fs, 440, onQ(0.2 * fs)));
    const hot = new Float32Array(N).fill(40);
    const [l, r] = rig.render(hot);
    expect(rig.msgs.filter(m => m.t === "fault")).toHaveLength(1);
    expect(l).toEqual(hot);
    expect(r).toEqual(hot);
    expect(rig.e.busy).toBe(false);
  });

  test("hot input (trim +12 dB, limiter off: peak 4) never trips it, on any preset at amount 1", () => {
    const fs = 48000, x = sine(fs, 220, fs, 4);
    for (const p of FX_PRESETS) {
      const rig = new Rig(fs, p.id);
      rig.send({ t: "engage", lag: 0 });
      rig.render(x);
      expect({ id: p.id, fault: rig.msgs.some(m => m.t === "fault") }).toEqual({ id: p.id, fault: false });
    }
  }, 60000);
});

describe("bypass", () => {
  test("bit-exact on a fresh node and after engage → release → idle", () => {
    for (const fs of RATES) {
      const r = prng(5), x = Float32Array.from({ length: 4096 }, () => 3 * (2 * r() - 1));
      const fresh = new Rig(fs);
      const [l, rr] = fresh.render(x);
      expect(l).toEqual(x);
      expect(rr).toEqual(x);
      const rig = new Rig(fs, "echo");
      rig.send({ t: "engage", lag: 0 });
      rig.render(sine(fs, 440, fs));
      rig.send({ t: "release", atBeat: null });
      for (let k = 0; k < 200 && rig.e.busy; k++) rig.silence(fs / 10);
      expect(rig.e.busy).toBe(false);
      rig.silence(N * 4);
      const [l2, r2] = rig.render(x);
      expect(l2).toEqual(x);
      expect(r2).toEqual(x);
    }
  });
});

describe("dry and reset", () => {
  /** The dry gain at frame `at`: the output difference a small spike makes there (wet paths have no zero-lag tap). */
  function dryAt(make: () => Rig, x: Float32Array, at: number, hook?: (rig: Rig, f: number) => void): number {
    const a = make(), b = make(), spike = x.slice();
    spike[at] += 0.01;
    const [ya] = a.render(x, x, f => hook?.(a, f)), [yb] = b.render(spike, spike, f => hook?.(b, f));
    return (yb[at] - ya[at]) / 0.01;
  }

  test("an active voice plus a tail keeps the dry at unity", () => {
    const fs = 48000, x = sine(fs, 220, fs, 0.01), at = Math.round(0.8 * fs);
    const g = dryAt(() => new Rig(fs, "echo"), x, at, (rig, f) => {
      if (f === 0) rig.send({ t: "engage", lag: 0 });
      if (f === Math.round(0.4 * fs / N) * N) rig.send({ t: "preset", id: "reverb", beats: 1 });
    });
    expect(Math.abs(g - 1)).toBeLessThan(1e-4);
  });

  test("every exit restores the dry on release and on track", () => {
    const fs = 48000, fpb = fpbOf(fs);
    for (const p of FX_PRESETS.filter(q => q.exit)) {
      const frames = Math.round(12 * fpb), x = sine(fs, 220, frames, 0.01);
      const gone = Math.round(9 * fpb);
      // Engaged: the dry has gone by beat 9 (next beat + up to 4 beats).
      expect(Math.abs(dryAt(() => new Rig(fs, p.id), x, gone, (r, f) => f === 0 && r.send({ t: "engage", lag: 0 })))).toBeLessThan(1e-4);
      for (const how of ["release", "track"] as const) {
        const back = gone + Math.round(0.05 * fs);
        const g = dryAt(() => new Rig(fs, p.id), x, back, (r, f) => {
          if (f === 0) r.send({ t: "engage", lag: 0 });
          if (f === Math.floor(gone / N) * N) r.send(how === "release" ? { t: "release", atBeat: null } : { t: "track", rootPc: null, minor: false, keylock: false });
        });
        expect({ id: p.id, how, g: Math.abs(g - 1) < 1e-4 }).toEqual({ id: p.id, how, g: true });
      }
    }
  });

  test("an exit closes the send with the dry: music after the exit never reaches the echo or reverb", () => {
    const fs = 48000, fpb = fpbOf(fs), frames = Math.round(14 * fpb), change = Math.round(6 * fpb);
    // 440 Hz until beat 6 (every exit's dry has gone by then), 660 Hz after.
    const x = Float32Array.from({ length: frames }, (_, i) => 0.25 * Math.sin((2 * Math.PI * (i < change ? 440 : 660) * i) / fs));
    const amplitude = (y: Float32Array, from: number, len: number, hz: number) => {
      let re = 0, im = 0, ws = 0;
      for (let i = 0; i < len; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len), ph = (2 * Math.PI * hz * (from + i)) / fs;
        re += w * y[from + i] * Math.cos(ph);
        im += w * y[from + i] * Math.sin(ph);
        ws += w;
      }
      return (2 * Math.hypot(re, im)) / ws;
    };
    for (const p of FX_PRESETS.filter(q => q.exit)) {
      const rig = new Rig(fs, p.id);
      rig.send({ t: "engage", lag: 0 });
      const [l] = rig.render(x);
      const from = Math.round(8 * fpb);
      expect({ id: p.id, ok: amplitude(l, from, frames - from, 660) < 0.01 * 0.25 }).toEqual({ id: p.id, ok: true });
    }
  });

  test("a backward seek during a latched exit keeps the dry where it was", () => {
    const fs = 48000, fpb = fpbOf(fs), x = sine(fs, 220, Math.round(10 * fpb), 0.01), seekAt = onQ(8 * fpb);
    const back = straight(fs, { validFrom: seekAt, knots: [seekAt, seekAt / fpb - 10, seekAt + fpb * 1e6, seekAt / fpb - 10 + 1e6], seek: true });
    for (const at of [seekAt + N, seekAt + Math.round(0.1 * fs), seekAt + Math.round(1.5 * fpb)]) {
      const g = dryAt(() => new Rig(fs, "echo-out"), x, at, (r, f) => {
        if (f === 0) r.send({ t: "engage", lag: 0 });
        if (f === seekAt) r.send(back);
      });
      expect({ at, g: Math.abs(g) < 1e-4 }).toEqual({ at, g: true });
    }
  });

  test("a track message and a seek clock reset the capture ring", () => {
    const fs = 48000, rig = new Rig(fs);
    rig.silence(10 * N);
    expect(rig.e.ring.written).toBe(10 * N);
    rig.send({ t: "track", rootPc: 0, minor: false, keylock: true });
    rig.silence(3 * N);
    expect(rig.e.ring.written).toBe(3 * N);
    rig.send({ ...straight(fs), validFrom: rig.frame, seek: true });
    rig.silence(2 * N);
    expect(rig.e.ring.written).toBe(2 * N);
    // A nudge (no seek) keeps it.
    rig.send({ ...straight(fs), validFrom: rig.frame, knots: [rig.frame, 0.01, rig.frame + 1e6, 0.01 + 1e6 / fpbOf(fs)] });
    rig.silence(N);
    expect(rig.e.ring.written).toBe(3 * N);
    // So does a key or key-lock change on the same track.
    rig.send({ t: "track", rootPc: 2, minor: true, keylock: false, keep: true });
    rig.silence(N);
    expect(rig.e.ring.written).toBe(4 * N);
  });

  test("after a track message or a seek clock, Reverse and Spinback read nothing older than the reset", () => {
    const fs = 48000, fpb = fpbOf(fs), reset = onQ(3 * fs), frames = 4 * fs;
    // A sine before the reset and silence after it: any output after the reset's 3 ms fade is pre-reset audio.
    const x = sine(fs, 440, frames);
    x.fill(0, reset);
    const resets: [string, FxToNode][] = [
      ["track", { t: "track", rootPc: 9, minor: true, keylock: true }],
      ["seek", { ...straight(fs), validFrom: reset, knots: [reset, 40.5, reset + 1e6, 40.5 + 1e6 / fpb], seek: true }],
    ];
    for (const id of ["reverse", "spinback"]) {
      for (const [how, msg] of resets) {
        // Engaged after the reset, and (Reverse only: Spinback has faded out by then) before it, reading back across it.
        for (const engageAt of id === "reverse" ? [onQ(2.5 * fs), onQ(3.25 * fs)] : [onQ(3.25 * fs)]) {
          const rig = new Rig(fs, id);
          const [l, r] = rig.render(x, x, f => {
            if (f === engageAt) rig.send({ t: "engage", lag: 0 });
            if (f === reset) rig.send(msg);
          });
          let peak = 0;
          for (let i = Math.max(reset, engageAt) + 4 * N; i < frames; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
          expect({ id, how, engageAt, peak: peak < 1e-6 }).toEqual({ id, how, engageAt, peak: true });
        }
      }
    }
  });

  test("the ring stores x/fader, clamped, and 0 behind a closed fader", () => {
    const fs = 48000, rig = new Rig(fs);
    rig.fader = 0.5;
    rig.render(new Float32Array(N).fill(0.25));
    expect(rig.e.ring.at(0, N - 1)).toBeCloseTo(0.5, 6);
    rig.fader = 0.001;
    rig.render(new Float32Array(N).fill(0.9));
    expect(rig.e.ring.at(1, 2 * N - 1)).toBe(4);
    rig.fader = 0;
    rig.render(new Float32Array(N).fill(0.9));
    expect(rig.e.ring.at(0, 3 * N - 1)).toBe(0);
  });
});

describe("node clock", () => {
  const fs = 48000, fpb = fpbOf(fs);

  test("keeps the old clock until validFrom, then follows the knots", () => {
    const c = new NodeClock(fs);
    c.set(straight(fs));
    expect(c.advance(0, N).beat).toBe(0);
    c.set({ ...straight(fs), validFrom: 10 * N, knots: [10 * N, 50, 10 * N + 1e6, 50 + 1e6 / fpb] });
    expect(c.advance(N, N).beat).toBeCloseTo(N / fpb, 9);
    const q = c.advance(10 * N, N);
    expect(q.beat).toBe(50);
    expect(q.jumped).toBe(true);
    expect(c.takeSeek()).toBe(false);
  });

  test("a small residual slews over 20 ms; a seek jumps and is reported once", () => {
    const c = new NodeClock(fs);
    c.set(straight(fs));
    c.advance(0, N);
    c.set({ ...straight(fs), validFrom: N, knots: [N, N / fpb + 0.02, N + 1e6, N / fpb + 0.02 + 1e6 / fpb] });
    const q = c.advance(N, N);
    expect(q.jumped).toBe(false);
    expect(q.beat).toBeCloseTo(N / fpb, 9);
    let f = 2 * N;
    for (; f < 0.03 * fs; f += N) c.advance(f, N);
    expect(c.advance(f, N).beat).toBeCloseTo(f / fpb + 0.02, 9);
    c.set({ ...straight(fs), validFrom: f + N, seek: true, knots: [f + N, f / fpb + 0.021, f + N + 1e6, 1e6] });
    expect(c.advance(f + N, N).jumped).toBe(true);
    expect(c.takeSeek()).toBe(true);
    expect(c.takeSeek()).toBe(false);
  });

  test("an untrusted grid counts B from the engage frame; an element deck runs at bpm × rate; pause freezes", () => {
    const c = new NodeClock(fs);
    c.set({ ...straight(fs), trusted: false });
    c.advance(0, N);
    c.advance(N, N);
    c.markEngage();
    expect(c.advance(2 * N, N).beat).toBeCloseTo(0, 12);
    expect(c.nextBar()).toBe(4);
    const e = new NodeClock(fs);
    e.set({ t: "clock", validFrom: 0, playing: true, knots: null, bpm: 120, rate: 1.5, trusted: false, seek: false });
    e.advance(0, N);
    e.markEngage();
    const q = e.advance(N, N);
    expect(q.beat).toBeCloseTo(0, 12);
    expect(q.beatsPerFrame).toBeCloseTo((120 * 1.5) / 60 / fs, 15);
    expect(e.advance(2 * N, N).beat).toBeCloseTo((N * 3) / fs, 12);
    e.set({ t: "clock", validFrom: 3 * N, playing: false, knots: null, bpm: 120, rate: 1.5, trusted: false, seek: false });
    const p1 = e.advance(3 * N, N), b = p1.beat;
    expect(p1.playing).toBe(false);
    expect(p1.beatsPerFrame).toBe(0);
    expect(p1.framesPerBeat).toBeCloseTo(fs / 3, 6);
    expect(e.advance(10 * N, N).beat).toBe(b);
  });
});

describe("engine", () => {
  const fs = 48000, fpb = fpbOf(fs);
  /** First frame from `from` where |y − ref| exceeds 1e-4. */
  const firstChange = (y: Float32Array, ref: number, from: number) => {
    let i = from;
    while (i < y.length && Math.abs(y[i] - ref) < 1e-4) i++;
    return i;
  };

  test("B waits for the next step and C for the next beat; X releases now", () => {
    // On DC: Bandpass (X) outputs 0 while on; Launch (C) rolls the DC through a high-pass that removes it.
    const at = Math.round(2.3 * fpb / N) * N, x = new Float32Array(Math.round(4 * fpb)).fill(1);
    for (const [id, expected, from] of [["bandpass", at, at], ["launch", 3 * fpb, at]] as const) {
      const rig = new Rig(fs, id);
      rig.send({ t: "engage", lag: 0 });
      const [y] = rig.render(x, x, f => f === at && rig.send({ t: "release", atBeat: null }));
      expect({ id, ok: Math.abs(firstChange(y, y[from - 1], from) - 1 - expected) <= 1 }).toEqual({ id, ok: true });
    }
    // Simple Gate (B, ½ b cycle, depth 1): still closed just before the next step at 2.5 b, then open where it would
    // have closed again (2.75–3 b).
    const rig = new Rig(fs, "simple-gate");
    rig.send({ t: "engage", lag: 0 });
    const [y] = rig.render(x, x, f => f === at && rig.send({ t: "release", atBeat: null }));
    expect(y[Math.round(2.45 * fpb)]).toBeLessThan(1e-6);
    // Open again: 1.0 through the soft clip, which stays on until the voice is idle.
    expect(y[Math.round(2.875 * fpb)]).toBeCloseTo(softClip(1), 6);
  });

  test("on an untrusted grid B counts from the engage frame and a \"bar\" release lands 4 beats later", () => {
    const rig = new Rig(fs, "bandpass");
    rig.send({ ...straight(fs), trusted: false, knots: [0, 0.37, fpb * 1e6, 0.37 + 1e6] });
    const engageAt = 10 * N;
    const x = new Float32Array(Math.round(6 * fpb)).fill(1);
    const [y] = rig.render(x, x, f => {
      if (f === engageAt) rig.send({ t: "engage", lag: 0 });
      if (f === engageAt + 20 * N) rig.send({ t: "release", atBeat: "bar" });
    });
    expect(Math.abs(firstChange(y, 0, engageAt + 21 * N) - 1 - (engageAt + 4 * fpb))).toBeLessThanOrEqual(1);
  });

  test("paused: inserts fade out within 5 ms while a tail rings; state messages follow engage, release and idle", () => {
    const rig = new Rig(fs, "lowpass");
    rig.send({ t: "engage", lag: 0 });
    const x = sine(fs, 5000, fs / 2, 0.3);
    rig.render(x);
    rig.send({ ...straight(fs), validFrom: rig.frame, playing: false });
    const [y] = rig.render(x.subarray(0, 2048));
    // After the pause ramp (5 ms) plus a quantum the low-pass is gone: the output is the dry input again.
    for (let i = 240 + N; i < 2048; i++) expect(Math.abs(y[i] - x[i])).toBeLessThan(1e-6);
    expect(rig.msgs.filter(m => m.t === "state")).toEqual([{ t: "state", engaged: true, tail: false }]);

    const echo = new Rig(fs, "echo");
    echo.send({ t: "engage", lag: 0 });
    echo.render(sine(fs, 440, fs / 2));
    echo.send({ t: "release", atBeat: null });
    echo.send({ ...straight(fs), validFrom: echo.frame, playing: false });
    const [tail] = echo.silence(Math.round(0.6 * fpb));
    expect(rms(tail, Math.round(0.4 * fpb))).toBeGreaterThan(1e-3);
    for (let k = 0; k < 400 && echo.e.busy; k++) echo.silence(fs / 10);
    expect(echo.msgs.filter(m => m.t === "state")).toEqual([
      { t: "state", engaged: true, tail: false }, { t: "state", engaged: false, tail: true }, { t: "state", engaged: false, tail: false },
    ]);
    expect(echo.msgs[0]).toEqual({ t: "ready" });
  });

  test("a release target posted while a seek clock is pending waits for that clock, then lands on the new B", () => {
    const rig = new Rig(fs, "bandpass");
    rig.send({ t: "engage", lag: 0 });
    const f0 = onQ(40 * fpb), from = f0 + onQ(0.15 * fs);
    const x = new Float32Array(from + Math.round(12 * fpb)).fill(1);
    const [y] = rig.render(x, x, f => {
      if (f !== f0) return;
      // A hot cue 30 beats back, heard 150 ms from now; then the phrase target re-sent for the new timeline.
      rig.send({ ...straight(fs), validFrom: from, knots: [from, 10, from + fpb * 1e6, 10 + 1e6], seek: true });
      rig.send({ t: "release", atBeat: 20 });
    });
    expect(Math.abs(firstChange(y, y[f0 - 1], f0) - 1 - (from + 10 * fpb))).toBeLessThanOrEqual(1);
    // A null release while the seek is pending still ends it at once.
    const now = new Rig(fs, "bandpass");
    now.send({ t: "engage", lag: 0 });
    now.render(x.subarray(0, f0));
    now.send({ ...straight(fs), validFrom: from, knots: [from, 10, from + fpb * 1e6, 10 + 1e6], seek: true });
    now.send({ t: "release", atBeat: null });
    now.silence(N);
    expect(now.e.engaged).toBe(false);
  });

  test("a Φ ramp target waits while paused and fires on its line once playing", () => {
    const rig = new Rig(fs, "lift", 3);
    rig.send({ ...straight(fs), playing: false });
    rig.send({ t: "engage", lag: 0 });
    rig.send({ t: "release", atBeat: 16 });
    rig.silence(onQ(0.5 * fs));
    expect(rig.e.engaged).toBe(true);
    const start = rig.frame;
    rig.send({ ...straight(fs), validFrom: start, knots: [start, 0, start + fpb * 1e6, 1e6] });
    rig.silence(onQ(15.5 * fpb));
    expect(rig.e.engaged).toBe(true);
    rig.silence(onQ(fpb));
    expect(rig.e.engaged).toBe(false);
    // A user release of a Φ preset while paused still ends it at once.
    const paused = new Rig(fs, "lift", 3);
    paused.send({ ...straight(fs), playing: false });
    paused.send({ t: "engage", lag: 0 });
    paused.silence(N);
    paused.send({ t: "release", atBeat: null });
    paused.silence(N);
    expect(paused.e.engaged).toBe(false);
  });

  test("a fourth voice waits for a free slot; a phrase target posted meanwhile still applies", () => {
    const rig = new Rig(fs, "echo");
    rig.send({ t: "engage", lag: 0 });
    rig.silence(N);
    rig.send({ t: "preset", id: "reverb", beats: 1 });
    rig.send({ t: "preset", id: "phaser", beats: 2 });
    rig.send({ t: "preset", id: "bandpass", beats: 0 });
    rig.send({ t: "release", atBeat: 8 });
    expect(rig.e.engaged).toBe(false);
    rig.silence(Math.round(0.03 * fs));
    expect(rig.e.engaged).toBe(true);
    const x = new Float32Array(Math.round(9 * fpb)).fill(1);
    const [y] = rig.render(x);
    const start = rig.frame - x.length;
    expect(Math.abs(start + firstChange(y, y[Math.round(7 * fpb) - start], Math.round(7 * fpb) - start) - 1 - 8 * fpb)).toBeLessThanOrEqual(1);
  });
});

describe("worklet wrapper", () => {
  test("registers the processor, renders through the engine, and on a throw copies dry, resets and posts fault", async () => {
    const built = await Bun.build({ entrypoints: [new URL("../src/lib/fxRack/fx-rack.worklet.js", import.meta.url).pathname], format: "esm" });
    expect(built.success).toBe(true);
    const code = await built.outputs[0].text();
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    let name = "", Processor: any;
    const posted: unknown[] = [];
    class Base { port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => posted.push(m) }; }
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", code)(
      Base, (n: string, p: unknown) => { name = n; Processor = p; }, 48000, 0,
    );
    expect(name).toBe("cratemind-fx-rack");
    expect(Processor.parameterDescriptors.map((d: { name: string }) => d.name)).toEqual(["amount", "fader"]);
    const proc = new Processor();
    const x = sine(48000, 440, N), out = [new Float32Array(N), new Float32Array(N)];
    const params = { amount: new Float32Array([0.5]), fader: new Float32Array([1]) };
    expect(proc.process([[x, x]], [out], params)).toBe(true);
    expect(out[0]).toEqual(x);
    expect(posted).toEqual([{ t: "ready" }]);
    proc.port.onmessage({ data: { t: "preset", id: "lowpass", beats: 0 } });
    proc.port.onmessage({ data: { t: "engage", lag: 0 } });
    proc.engine.process = () => {
      throw new Error("boom");
    };
    out[0].fill(9);
    expect(proc.process([[x, x]], [out], params)).toBe(true);
    expect(out[0]).toEqual(x);
    expect(out[1]).toEqual(x);
    expect(posted.at(-1)).toEqual({ t: "fault" });
    expect(proc.engine.busy).toBe(false);
    // The engine again (the own property shadowed its method); no input connected renders silence.
    delete proc.engine.process;
    expect(proc.process([[]], [out], params)).toBe(true);
    expect(out[0].every((v: number) => v === 0)).toBe(true);
  });
});
