import { describe, expect, test } from "bun:test";
import { FRACTAL_TABLES, FX_PRESETS, SCRAMBLE_TABLES, presetById } from "../src/lib/fxRack/presets";
import { createSlicer } from "../src/lib/fxRack/slicer";
import {
  CaptureRing, type CurveInputs, type QuantumClock, type SlicerParams, type SlicerVoice, type StereoFilter,
} from "../src/lib/fxRack/types";

// The input encodes its own sample index, so every output sample says which input frame it came from.
const FS = 48000;
const N = 128;
const SCALE = 2 ** -19;
const F = Math.round(FS * 0.003); // slice-edge crossfade
const ramp = (n: number) => n * SCALE;

/** A one-pole low-pass standing in for blocks.ts's SVF; records every cutoff it is given. */
class OnePole implements StereoFilter {
  sets: number[] = [];
  private a = 1;
  private yl = 0;
  private yr = 0;
  set(hz: number): void {
    this.sets.push(hz);
    this.a = 1 - Math.exp((-2 * Math.PI * hz) / FS);
  }
  process(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      this.yl += this.a * (l[i] - this.yl);
      this.yr += this.a * (r[i] - this.yr);
      l[i] = this.yl;
      r[i] = this.yr;
    }
  }
  reset(): void {
    this.yl = 0;
    this.yr = 0;
  }
}

type Rig = {
  ring: CaptureRing; voice: SlicerVoice; lp: OnePole; frame: number; fpb: number; fader: number; playing: boolean;
  v: CurveInputs; sig: (n: number) => number; inL: Float32Array; outL: Float32Array; outR: Float32Array;
  /** Frame at which the ring is reset (a seek or a track message), or -1. */
  resetAt: number;
};

function rig(fpb: number, total: number, sig: (n: number) => number = ramp): Rig {
  const lp = new OnePole();
  return {
    ring: new CaptureRing(FS), voice: createSlicer(FS, () => lp), lp, frame: 0, fpb, fader: 1, playing: true,
    v: { a: 1, m: 1, rho: 0, t: 0 }, sig, inL: new Float32Array(total + N), outL: new Float32Array(total + N),
    outR: new Float32Array(total + N), resetAt: -1,
  };
}

const clockOf = (r: Rig, jumped = false): QuantumClock => ({
  beat: r.frame / r.fpb, beatsPerFrame: r.playing ? 1 / r.fpb : 0, framesPerBeat: r.fpb, playing: r.playing, jumped,
});

const qL = new Float32Array(N), qR = new Float32Array(N), oL = new Float32Array(N), oR = new Float32Array(N);

/** Renders `frames` (whole quanta) the way the core does: the ring is written first, then the voice runs. */
function run(r: Rig, frames: number): void {
  for (let end = r.frame + frames; r.frame < end; r.frame += N) {
    let jumped = false;
    if (r.frame === r.resetAt) {
      r.ring.reset();
      jumped = true;
    }
    for (let i = 0; i < N; i++) {
      qL[i] = r.sig(r.frame + i) * r.fader;
      qR[i] = -qL[i];
    }
    r.ring.write(qL, qR, r.fader >= 1e-3 ? 1 / r.fader : 0, N);
    r.voice.process(r.ring, clockOf(r, jumped), r.v, r.fader, qL, qR, oL, oR, N);
    r.inL.set(qL, r.frame);
    r.outL.set(oL, r.frame);
    r.outR.set(oR, r.frame);
  }
}

const slicer = (id: string): SlicerParams => presetById(id)!.ins!.slicer!;
const engage = (r: Rig, id: string, beats: number, lag = 0) => r.voice.start(slicer(id), beats, clockOf(r), lag);
const w = (k: number) => 0.5 - 0.5 * Math.cos((Math.PI * k) / F);

function expectExact(r: Rig, from: number, to: number, src: (n: number) => number): void {
  for (let n = from; n < to; n++) {
    if (r.outL[n] !== r.inL[src(n)]) throw new Error(`frame ${n}: ${r.outL[n]} != in[${src(n)}] = ${r.inL[src(n)]}`);
  }
}

function expectNear(r: Rig, from: number, to: number, want: (n: number) => number, tol: number): void {
  for (let n = from; n < to; n++) {
    if (Math.abs(r.outL[n] - want(n)) > tol) throw new Error(`frame ${n}: ${r.outL[n]} vs ${want(n)}`);
  }
}

describe("roll", () => {
  const E = 96000, L = 6000; // ¼ b at 120 BPM

  test("the first pass is live, then out[n] = in[n − L], repeating the window", () => {
    const r = rig(24000, E + 5 * L);
    run(r, E);
    engage(r, "roll", 1 / 4);
    run(r, 5 * L);
    expectExact(r, E, E + L, n => n);
    expectExact(r, E + L + F, E + 2 * L, n => n - L);
    for (let k = 2; k < 5; k++) expectExact(r, E + k * L + F, E + (k + 1) * L, n => E + ((n - E) % L));
    for (let n = E; n < E + 5 * L; n++) expect(r.outR[n]).toBe(-r.outL[n]);
  });

  test("slice edges crossfade over 3 ms with raised-cosine weights and no step", () => {
    const r = rig(24000, E + 3 * L);
    run(r, E);
    engage(r, "roll", 1 / 4);
    run(r, 3 * L);
    expectNear(r, E + L, E + L + F + 1, n => (1 - w(n - E - L)) * r.inL[n] + w(n - E - L) * r.inL[n - L], 1e-6);
    const jump = L * SCALE;
    let maxStep = 0;
    for (let n = E + L - 8; n < E + L + F + 8; n++) maxStep = Math.max(maxStep, Math.abs(r.outL[n + 1] - r.outL[n]));
    expect(maxStep).toBeLessThan(jump / 40);
  });

  test("starts from the step the DJ heard: lag reaches back into the previous step", () => {
    const late = E + 1024;
    const a = rig(24000, E + 4 * L);
    run(a, late);
    engage(a, "roll", 1 / 4);
    run(a, 3 * L);
    expectExact(a, late, E + L, n => n); // same step: still the live first pass
    expectExact(a, E + L + F, E + 2 * L, n => n - L);

    const b = rig(24000, E + 4 * L);
    run(b, late);
    engage(b, "roll", 1 / 4, 2048); // heard 2048 frames ago, before the step at E
    run(b, 3 * L);
    expectExact(b, late, E + L, n => n - L); // already repeating [E − L, E)
  });

  test("Rapid Fire accelerates ¼ → ⅛ → 1/16 b as ρ rises, always repeating from the same start", () => {
    const r = rig(24000, E + 12 * L);
    r.v = { a: 1, m: 0, rho: 0, t: 0 };
    run(r, E);
    engage(r, "rapid-fire", 2);
    run(r, 3 * L);
    for (const s of [E + L, E + 2 * L]) expectExact(r, s + F, s + L, n => E + ((n - E) % L));
    r.v = { ...r.v, rho: 0.5 };
    run(r, 4 * L);
    expectExact(r, E + 5 * L + F, E + 5 * L + 3000, n => E + ((n - E) % 3000));
    expectExact(r, E + 5 * L + 3000 + F, E + 6 * L, n => E + ((n - E) % 3000));
    r.v = { ...r.v, rho: 0.8 };
    run(r, 4 * L);
    for (let s = E + 9 * L; s < E + 11 * L; s += 1500) expectExact(r, s + F, s + 1500, n => E + ((n - E) % 1500));
  });

  test("a step release goes back to live at the next step and then copies the input exactly", () => {
    const r = rig(24000, E + 4 * L);
    run(r, E);
    engage(r, "roll", 1 / 4);
    run(r, L + 2048);
    r.voice.release("step", 0);
    run(r, 3 * L - 2048);
    expect(r.voice.idle).toBe(true);
    expectExact(r, E + L + F, E + 2 * L, n => n - L); // released at E + 2L, not before
    expectExact(r, E + 2 * L + F, E + 4 * L, n => n);
  });
});

describe("tape moves", () => {
  test("reverse: out[C + k] = in[C − 1 − k] from the press, then releases itself at ring/2 − 1 b", () => {
    const C = 240000;
    const r = rig(24000, C + 184000);
    run(r, C);
    engage(r, "reverse", 0);
    run(r, 184000);
    expectExact(r, C, C + 170000, n => 2 * C - 1 - n);
    expect(r.voice.idle).toBe(true);
    expectExact(r, C + 182000, C + 184000, n => n);
  });

  test("reverse and spinback never read before a ring reset: Reverse releases to live, Spinback fades to silence", () => {
    const R = 120064, C = R + 12800;
    const sig = (n: number) => (n - R + 0.5) * SCALE; // older audio is negative
    for (const [id, rho, speed] of [["reverse", 0, 1], ["spinback", 0.5, 2]] as const) {
      const r = rig(24000, C + 20000, sig);
      r.resetAt = R;
      r.v = { a: 1, m: 0, rho, t: 0 };
      run(r, C);
      engage(r, id, 1);
      run(r, 20000);
      const reach = Math.floor((C - R) / speed);
      for (let n = C; n < C + 20000; n++) expect(r.outL[n]).toBeGreaterThanOrEqual(0);
      expect(r.outL[C + 100]).toBeGreaterThan(0);
      if (id === "reverse") {
        expectExact(r, C, C + reach - 3 * F, n => 2 * C - 1 - n);
        expectExact(r, C + reach, C + 20000, n => n); // released to live, as at its cap
        expect(r.voice.idle).toBe(true);
      } else for (let n = C + reach; n < C + 20000; n++) expect(r.outL[n]).toBe(0);
    }
  });

  test("brake falls monotonically to exactly 0 over BEATS, and the follow low-pass ends there too", () => {
    const E = 96000, T = 12000; // ½ b
    for (const a of [0, 1]) {
      const r = rig(24000, E + T + 6000);
      r.v = { a, m: 0, rho: 0, t: 0 };
      run(r, E);
      engage(r, "brake", 1 / 2);
      run(r, T + 6000);
      if (a === 0) {
        const slopes: number[] = [];
        for (let k = 0; k + 128 <= 0.9 * T; k += 128) slopes.push(r.outL[E + k + 128] - r.outL[E + k]);
        expect(slopes[0] / (128 * SCALE)).toBeGreaterThan(0.98);
        for (let k = 1; k < slopes.length; k++) expect(slopes[k]).toBeLessThanOrEqual(slopes[k - 1] + 1e-9);
        for (let n = E + 0.9 * T; n < E + T; n++) expect(r.outL[n + 1]).toBeLessThanOrEqual(r.outL[n]);
        expect(r.lp.sets.length).toBe(0);
      } else {
        expect(r.lp.sets.length).toBeGreaterThan(0);
      }
      for (let n = E + T + 2 * F + 2; n < E + T + 6000; n++) expect(r.outL[n]).toBe(0);
    }
  });
});

describe("chromatic juggle", () => {
  const E = 96000, W = 12000; // ½ b window
  const sig = (n: number) => (n - (E - W)) * 2 ** -12; // the window reads 0 … (W − 1)·2⁻¹²

  test("slot k plays the last BEATS window at 2^(k/12), laddering up and wrapping after N = 13", () => {
    const r = rig(24000, E + 15 * W, sig);
    run(r, E);
    engage(r, "chromatic-juggle", 1 / 2);
    run(r, 15 * W);
    for (let j = 0; j < 15; j++) {
      const k = j % 13, a = E + j * W + F + 16;
      const slope = (r.outL[a + 1000] - r.outL[a]) / 1000 / 2 ** -12;
      expect(Math.abs(slope - 2 ** (k / 12))).toBeLessThanOrEqual(1e-4);
    }
  });

  test("a slot above ratio 1 loops inside its window", () => {
    const r = rig(24000, E + 13 * W, sig);
    run(r, E);
    engage(r, "chromatic-juggle", 1 / 2);
    run(r, 13 * W);
    const top = (W - 1) * 2 ** -12;
    for (let j = 1; j < 13; j++) {
      let lo = Infinity, hi = -Infinity;
      for (let n = E + j * W; n < E + (j + 1) * W; n++) {
        lo = Math.min(lo, r.outL[n]);
        hi = Math.max(hi, r.outL[n]);
      }
      expect(lo).toBeGreaterThanOrEqual(-1e-6);
      expect(hi).toBeLessThanOrEqual(top + 1e-6);
      expect(hi - lo).toBeGreaterThan(0.9 * top); // it really wrapped round the whole window
    }
  });
});

describe("anti-aliasing", () => {
  /** Amplitude of `hz` in out[from, from + len), Hann-windowed. */
  function amplitude(x: Float32Array, from: number, len: number, hz: number): number {
    let re = 0, im = 0, wsum = 0;
    for (let i = 0; i < len; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len), ph = (2 * Math.PI * hz * i) / FS;
      re += w * x[from + i] * Math.cos(ph);
      im += w * x[from + i] * Math.sin(ph);
      wsum += w;
    }
    return (2 * Math.hypot(re, im)) / wsum;
  }

  test("a read at 2× folds no 20 kHz content down to 8 kHz (Chromatic slot 12, Launch at +12 st)", () => {
    const E = 96000, W = 12000, amp = 0.5;
    const tone = (n: number) => amp * Math.sin((2 * Math.PI * 20000 * n) / FS);
    // Chromatic Juggle, ½ b window: slot 12 reads it at 2^(12/12) = 2.
    const c = rig(24000, E + 13 * W, tone);
    run(c, E);
    engage(c, "chromatic-juggle", 1 / 2);
    run(c, 13 * W);
    const at = E + 12 * W + F + 16;
    expect(amplitude(c.outL, at, 4096, 8000) / amp).toBeLessThan(0.01);
    // Launch at m = 1 (+12 st): a ⅛ b roll read at 2×, so measure across one slice between its edges.
    const l = rig(24000, E + 6 * 24000, tone);
    l.v = { a: 1, m: 1, rho: 0.6, t: 0 };
    run(l, E);
    engage(l, "launch", 4);
    run(l, 6 * 24000);
    const s = E + 2 * 24000 + F + 16;
    expect(amplitude(l.outL, s, 2048, 8000) / amp).toBeLessThan(0.01);
    expect(l.lp.sets.length).toBe(0);
  });
});

describe("replays and juggle patterns", () => {
  test("Flashback replays the bar 4 b back; a window that does not fit halves BEATS (rate 0.5)", () => {
    const fits = rig(24000, 288000);
    fits.v = { a: 0, m: 0, rho: 0, t: 0 }; // no reversed slices
    run(fits, 240000);
    engage(fits, "flashback", 2);
    run(fits, 48000);
    expectNear(fits, 240000, 288000, n => fits.inL[n - 4 * 24000], 1e-6);

    const slow = rig(96000, 480000); // 60 BPM at rate 0.5: 4 + 2 beats would need 12 s of ring
    slow.v = { a: 0, m: 0, rho: 0, t: 0 };
    run(slow, 384000);
    engage(slow, "flashback", 2);
    run(slow, 96000);
    expectNear(slow, 384000, 480000, n => slow.inL[n - 2 * 96000], 1e-6);
  });

  test("Flashback reverses whole ½ b slices by chance at amount 1", () => {
    const r = rig(24000, 336000);
    run(r, 240000); // beat 10: the 4 b cycle started at beat 8, so the window is beats 4–8
    engage(r, "flashback", 4);
    run(r, 96000);
    let reversed = 0;
    for (let j = 4; j < 12; j++) {
      const S = 192000 + j * 12000, src = 96000 + (j % 8) * 12000;
      const fwd = r.outL[S + 6000] === r.inL[src + 6000], rev = r.outL[S + 6000] === r.inL[src + 12000 - 1 - 6000];
      expect(fwd || rev).toBe(true);
      if (rev) {
        reversed++;
        expectExact(r, S + F, S + 12000, n => src + 12000 - 1 - (n - S));
      }
    }
    expect(reversed).toBeGreaterThan(0);
  });

  test("after a seek a replay rolls from the new audio until its window is captured, then resumes", () => {
    const R = 240000, C = 252288;
    const r = rig(24000, 432000, n => (n - R + 0.5) * SCALE);
    r.resetAt = R;
    r.v = { a: 0, m: 0, rho: 0, t: 0 };
    run(r, C);
    engage(r, "flashback", 2);
    run(r, 432000 - C);
    for (let n = C; n < 432000; n++) expect(r.outL[n]).toBeGreaterThan(0);
    expectExact(r, C, 264000, n => n); // live first pass of the ½ b roll from 252000
    for (let s = 264000; s < 384000; s += 12000) expectExact(r, s + F, s + 12000, n => 252000 + ((n - 252000) % 12000));
    expectNear(r, 384000 + F, 432000, n => r.inL[n - 96000], 1e-6); // [12 b, 14 b) is captured: replay resumes
  });

  test("Tri-Step plays ⅓ b slices of the last 2 b in the order 0, 0, 2, 0, 1, 2", () => {
    const E = 144000, S = 8000;
    const r = rig(24000, E + 6 * S);
    run(r, E);
    engage(r, "tri-step", 1 / 3);
    run(r, 6 * S);
    [0, 0, 2, 0, 1, 2].forEach((q, j) => {
      const from = E + j * S;
      expectNear(r, from + (j ? F : 0), from + S, n => r.inL[96000 + q * S + (n - from)], 1e-6);
    });
  });

  test("Scramble reorders the last bar's slices by its permutation tables, alternating per bar", () => {
    const E = 192000, S = 24000;
    const r = rig(24000, E + 8 * S);
    run(r, E);
    engage(r, "scramble", 1);
    run(r, 8 * S);
    const [p0, p1] = SCRAMBLE_TABLES[4];
    [...p0, ...p1].forEach((q, j) => {
      const from = E + j * S;
      expectNear(r, from + (j ? F : 0), from + S, n => r.inL[96000 + q * S + (n - from)], 1e-6);
    });
  });

  test("Fractal alters the table's steps: repeat, reverse and octaves of the step before; the rest stays live", () => {
    const E = 384000, S = 6000; // bar 4 → table 0, ¼ b steps
    const r = rig(24000, E + 16 * S);
    run(r, E);
    engage(r, "fractal", 1 / 4);
    run(r, 16 * S);
    const ops = new Map<number, string>(FRACTAL_TABLES[0].map(([s, op]) => [s, op]));
    expect(new Set(ops.values())).toEqual(new Set(["repeat", "reverse", "up", "down"]));
    for (let s = 0; s < 16; s++) {
      const B = E + s * S, from = B + 3 * F, op = ops.get(s);
      if (op === undefined) expectExact(r, from, B + S, n => n);
      else if (op === "repeat") expectExact(r, from, B + S, n => n - S);
      else if (op === "reverse") expectExact(r, from, B + S, n => 2 * B - 1 - n);
      else if (op === "up") expectNear(r, from, B + 2800, n => ramp(B - S + 2 * (n - B)), 1e-5);
      else expectNear(r, from, B + S, n => ramp(B - S + (n - B) / 2), 1e-6);
    }
  });

  test("Warp Hop draws whole slices of the last 2 bars, panned ±.6, the same way every time", () => {
    const E = 240000, S = 12000;
    const outs = [0, 1].map(() => {
      const r = rig(24000, E + 16 * S);
      run(r, E);
      engage(r, "warp-hop", 1 / 2);
      run(r, 16 * S);
      for (let j = 0; j < 16; j++) {
        const n = E + j * S + S / 2, ratio = r.outR[n] / r.outL[n];
        expect([-2.5, -0.4].some(x => Math.abs(ratio - x) < 1e-4)).toBe(true);
        const x = r.outL[n] / (ratio < -1 ? 0.4 : 1), q = (x / SCALE - (E - 8 * 24000) - S / 2) / S;
        expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-3);
        expect(Math.round(q)).toBeGreaterThanOrEqual(0);
        expect(Math.round(q)).toBeLessThan(16);
      }
      return r.outL;
    });
    expect(outs[0]).toEqual(outs[1]);
  });
});

describe("fader", () => {
  const E = 96000, L = 6000;

  test("fader .5 gives exactly half, and a closed fader silences replays until it opens again", () => {
    const full = rig(24000, E + 4 * L), half = rig(24000, E + 4 * L);
    half.fader = 0.5;
    for (const r of [full, half]) {
      run(r, E);
      engage(r, "roll", 1 / 4);
      run(r, 4 * L);
    }
    for (let n = E; n < E + 4 * L; n++) expect(half.outL[n]).toBe(full.outL[n] / 2);

    const r = rig(24000, E + 7 * L);
    run(r, E);
    engage(r, "roll", 1 / 4);
    run(r, 2 * L);
    const closed = r.frame;
    r.fader = 0;
    run(r, 2 * L);
    const opened = r.frame;
    for (let n = closed; n < opened; n++) expect(r.outL[n]).toBe(0);
    r.fader = 1;
    run(r, 2 * L);
    expectExact(r, Math.max(opened, E + 4 * L + F), E + 5 * L, n => E + ((n - E) % L)); // captured before it closed
    expectExact(r, E + 5 * L + F, E + 6 * L, n => E + ((n - E) % L));
  });

  test("a fader near 1e-3 stays bounded: replays read |x/fader| ≤ 4", () => {
    const r = rig(24000, E + 4 * L, () => 0.5);
    r.fader = 1.1e-3;
    run(r, E);
    engage(r, "roll", 1 / 4);
    run(r, 4 * L);
    for (let n = E; n < E + 4 * L; n++) {
      expect(Number.isFinite(r.outL[n])).toBe(true);
      expect(Math.abs(r.outL[n])).toBeLessThanOrEqual(4 * 1.1e-3 + 1e-9);
    }
  });
});

describe("fuzz", () => {
  test("every slicer preset stays finite and bounded through tempo, pause, seek, fader and release events", () => {
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const presets = FX_PRESETS.filter(p => p.ins?.slicer);
    expect(presets.length).toBe(20);
    for (let run_ = 0; run_ < 120; run_++) {
      const p = presets[run_ % presets.length];
      const opts = p.beats?.options.filter((o): o is number => typeof o === "number") ?? [];
      const beats = opts.length ? opts[Math.floor(rnd() * opts.length)] : 0;
      const lp = new OnePole();
      const voice = createSlicer(FS, () => lp);
      const ring = new CaptureRing(FS);
      let fpb = 15000 + rnd() * 45000, beat = rnd() * 64, playing = true, fader = 1, released = false;
      const v = { a: rnd(), m: rnd(), rho: 0, t: 0 };
      const pre = Math.floor((0.5 + rnd() * 2.5) * FS / N), len = Math.floor(0.5 * FS / N);
      for (let q = 0; q < pre + len; q++) {
        let jumped = false;
        if (q >= pre) {
          const e = rnd();
          if (e < 0.03) fpb *= 0.97 + rnd() * 0.06;
          else if (e < 0.045) playing = !playing;
          else if (e < 0.055) {
            beat += (rnd() - 0.5) * 16;
            jumped = true;
            if (rnd() < 0.5) ring.reset();
          } else if (e < 0.075) fader = rnd() < 0.2 ? rnd() * 2e-3 : rnd();
          else if (e < 0.085 && !released) {
            voice.release(rnd() < 0.5 ? "step" : "now", 5 + rnd() * 20);
            released = true;
          }
          v.a = Math.min(1, Math.max(0, v.a + (rnd() - 0.5) * 0.1));
          v.m = Math.min(1, Math.max(0, v.m + (rnd() - 0.5) * 0.1));
          v.rho = Math.min(1, v.rho + 0.01);
        }
        for (let i = 0; i < N; i++) {
          qL[i] = (rnd() * 2 - 1) * fader;
          qR[i] = (rnd() * 2 - 1) * fader;
        }
        ring.write(qL, qR, fader >= 1e-3 ? 1 / fader : 0, N);
        const clock = { beat, beatsPerFrame: playing ? 1 / fpb : 0, framesPerBeat: fpb, playing, jumped };
        if (q === pre) voice.start(p.ins!.slicer!, beats, clock, Math.floor(rnd() * 2400));
        voice.process(ring, clock, v, fader, qL, qR, oL, oR, N);
        for (let i = 0; i < N; i++) {
          if (!Number.isFinite(oL[i]) || !Number.isFinite(oR[i]) || Math.abs(oL[i]) > 1.5 || Math.abs(oR[i]) > 1.5) {
            throw new Error(`${p.id} run ${run_} quantum ${q}: ${oL[i]}, ${oR[i]}`);
          }
        }
        if (playing) beat += N / fpb;
      }
    }
  });
});
