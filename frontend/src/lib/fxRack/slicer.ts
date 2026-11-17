// Block S, the buffer slicer (plan §2 S): rolls, replays, juggles, the chromatic ladder and the tape moves (brake,
// reverse, spinback). Read heads play the core's CaptureRing and crossfade over 3 ms at every slice edge; a third head
// only carries a fade that overlaps the next one. Pure maths: no DOM or worklet globals, nothing allocated in process().
import { curveValue } from "./presets";
import type {
  BeatsRef, CaptureRing, CreateSlicer, CurveInputs, FilterFactory, QuantumClock, SliceOp, SlicerParams, SlicerVoice,
  StereoFilter,
} from "./types";

/** Slice-edge crossfade (§2 S) and the fade of a read that reaches unwritten frames. */
const XFADE_S = 0.003;
/** Reverse's own release when it reaches its cap: X, 5 ms. */
const REVERSE_EXIT_S = 0.005;
/** Above this read speed a head reads through a band-limited (windowed-sinc) kernel instead of the Hermite. */
const AA_RATIO = 1.5;
const EPS = 1e-6;
/** B-domain distance beyond which the next boundary is taken as stale (no grid is longer). */
const MAX_GRID = 4;
const FREEFORM_OPS: readonly SliceOp[] = ["repeat", "reverse", "up", "down", "skip"];

const mod = (x: number, m: number) => ((x % m) + m) % m;
/** Removes float dust from a frame position computed through beats, so whole-frame reads stay exact. */
const snap = (x: number) => (Math.abs(x - Math.round(x)) < EPS ? Math.round(x) : x);

/** Deterministic 0..1 from two integers and a salt (the seeded tables: per bar, per slice). */
function hash01(a: number, b: number, salt: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x632be5ab, 0x85ebca77) ^ Math.imul(salt, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** One read head. Positions are absolute frames (ring index + base), so audio from before a ring reset is never held. */
class Head {
  on = false;
  /** Plays the live input sample for sample (a roll's first pass, unaltered steps, the release). */
  live = false;
  pos = 0;
  /** Frames read per output frame; negative reads backwards. */
  ratio = 1;
  /** Per-frame ratio multiplier (glide). */
  mul = 1;
  /** Crossfade envelope 0..1 and its per-frame change. */
  env = 0;
  step = 0;
  gain = 1;
  gainStep = 0;
  gl = 1;
  gr = 1;
  /** Loops inside [lo, hi) with a crossfade instead of reading past its window. */
  bounded = false;
  lo = 0;
  hi = 0;
}

/** What the program asks for at a slice edge (preallocated, filled by `decide`). */
type Spec = Omit<Head, "on" | "env" | "step" | "gainStep">;

const TAPE = new Set<SlicerParams["prog"]>(["brake", "reverse", "spin"]);

class Slicer implements SlicerVoice {
  private readonly fs: number;
  private readonly fadeF: number;
  private readonly heads = [new Head(), new Head(), new Head()];
  private newest: Head = this.heads[0];
  private readonly spec: Spec = new Head();
  private readonly lp: StereoFilter;
  private lpMix = 0;
  private lpOn = false;
  private bufL = new Float32Array(128);
  private bufR = new Float32Array(128);

  private p: SlicerParams | null = null;
  private beats = 1;
  private lag = 0;
  private fresh = false;
  private tape = false;

  // Ring bookkeeping (absolute frame = ring index + base).
  private ring: CaptureRing | null = null;
  private base = 0;
  private lastWritten = -1;
  private heldLo = 0;
  private edgeMoves = false;
  private loR = 0;
  private hiR = 0;
  private rl = 0;
  private rr = 0;

  // Per quantum.
  private v: CurveInputs = { a: 0, m: 0, rho: 0, t: 0 };
  private fader = 1;
  private fpbNow = 0;

  // Program state.
  private fpbE = 0;
  private fit = 1;
  private nextB = NaN;
  private winB = 0;
  private winAbs = 0;
  private fbB = NaN;
  private fbAbs = 0;
  private rgain = 1;
  private slot = -1;
  private t = 0;
  private tapeT = 1;
  private cap = 0;
  private vibBase = 1;
  private vibSt = 0;

  private relStep = false;
  private relNow = -1;
  private releasing = false;

  constructor(sampleRate: number, filter: FilterFactory) {
    this.fs = sampleRate;
    this.fadeF = Math.max(1, Math.round(sampleRate * XFADE_S));
    this.lp = filter("lp");
  }

  get idle(): boolean {
    return this.p === null;
  }

  start(params: SlicerParams, beats: number, _clock: QuantumClock, lagFrames: number): void {
    for (const h of this.heads) h.on = false;
    this.p = params;
    this.beats = beats > 0 && Number.isFinite(beats) ? beats : 0.25;
    this.lag = lagFrames > 0 && Number.isFinite(lagFrames) ? Math.round(lagFrames) : 0;
    this.fresh = true;
    this.tape = TAPE.has(params.prog);
    this.nextB = NaN;
    this.relStep = false;
    this.relNow = -1;
    this.releasing = false;
    this.lpMix = 0;
    this.lpOn = false;
    this.vibBase = 1;
    this.vibSt = 0;
  }

  release(mode: "step" | "now", fadeMs: number): void {
    if (!this.p || this.releasing) return;
    if (mode === "now") this.relNow = Math.max(1, Math.round((fadeMs * this.fs) / 1000));
    else this.relStep = true;
  }

  process(
    ring: CaptureRing, clock: QuantumClock, v: CurveInputs, fader: number,
    inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number,
  ): void {
    const w0 = ring.written - n;
    // A ring reset restarts its indexes: move the base on, so every stored window falls below the held range.
    if (this.lastWritten >= 0 && w0 < this.lastWritten) this.base += this.lastWritten - w0;
    this.lastWritten = ring.written;
    this.loR = Math.max(0, ring.written - ring.size);
    this.hiR = ring.written - 1;
    this.heldLo = this.base + this.loR;
    this.edgeMoves = ring.written >= ring.size;
    const p = this.p;
    if (!p) {
      for (let i = 0; i < n; i++) {
        outL[i] = inL[i];
        outR[i] = inR[i];
      }
      return;
    }
    this.ring = ring;
    this.v = v;
    this.fader = fader;
    this.fpbNow = clock.framesPerBeat > 0 ? clock.framesPerBeat : this.fs / 2;
    const absFirst = w0 + this.base;
    const moving = clock.playing && clock.beatsPerFrame > 0;
    if (this.fresh) this.init(p, ring, clock, absFirst);
    if (this.relStep && !moving) {
      this.relStep = false;
      this.relNow = this.fadeF;
    }
    if (p.prog === "reverse" && !this.releasing && this.t >= this.cap) this.relNow = Math.round(this.fs * REVERSE_EXIT_S);
    if (this.relNow >= 0) {
      this.startRelease(this.relNow);
      this.relNow = -1;
    }
    for (let k = 0; k < 3; k++) this.heads[k].gainStep = 0;
    this.quantumMods(p, v, n);

    if (moving && this.grid(p) > 0) {
      const d = this.nextB - clock.beat;
      if (clock.jumped || !(d > -EPS) || d > MAX_GRID + EPS) {
        const g = this.grid(p);
        this.nextB = (Math.floor(clock.beat / g + EPS) + 1) * g;
      }
    }
    let i = 0;
    while (i < n) {
      let end = n;
      let edge = false;
      const g = this.grid(p);
      if (moving && g > 0) {
        const f = Math.ceil((this.nextB - clock.beat) * clock.framesPerBeat - EPS);
        if (f < n) {
          end = Math.max(f, i);
          edge = true;
        }
      }
      this.render(p, i, end, absFirst, inL, inR, outL, outR);
      this.postLowpass(p, v, outL, outR, i, end);
      i = end;
      if (edge) {
        const bb = this.nextB;
        this.boundary(p, bb, absFirst + i);
        this.nextB = bb + Math.max(this.grid(p), 1 / 64);
      }
    }

    if (this.releasing && this.lpMix === 0) {
      const h = this.newest;
      if (this.alone(h) && h.on && h.live && h.env === 1 && h.gain === 1 && h.gl === 1 && h.gr === 1) {
        h.on = false;
        this.p = null;
      }
    }
  }

  // ---- Setup ----

  private init(p: SlicerParams, ring: CaptureRing, clock: QuantumClock, absFirst: number): void {
    this.fresh = false;
    const fpb = this.fpbNow;
    this.fpbE = fpb;
    this.t = 0;
    this.rgain = 1;
    this.fbB = NaN;
    // A window that does not fit the ring halves every length of the program until it does (§2 S).
    const avail = ring.size - this.lag - this.fs * 0.05 - 256;
    const need = this.needBeats(p);
    this.fit = 1;
    while (this.fit > 1 / 64 && need * this.fit * fpb > avail) this.fit /= 2;

    const s = this.spec;
    if (this.tape) {
      this.setRead(p.prog === "brake" ? absFirst : absFirst - this.lag - 1, p.prog === "brake" ? 1 : -1);
      if (p.prog === "spin") s.ratio = Math.min(-EPS, curveValue(p.rate, this.v));
      this.tapeT = Math.max(1, this.beats * fpb);
      this.cap = Math.max(this.fadeF, Math.floor(ring.size / 2) - fpb - this.lag);
      this.begin(0, 0);
      return;
    }
    const g = this.grid(p);
    const bh = clock.beat - this.lag * clock.beatsPerFrame;
    const bc = Math.floor(clock.beat / g + EPS) * g;
    const absB = snap(absFirst + (bc - clock.beat) * fpb);
    this.anchor(p, bh, bc, absB);
    this.decide(p, bc, absB);
    this.begin(absFirst - absB, 0);
    this.nextB = bc + g;
  }

  /** Beats of audio behind now a program reads at most (for the fit check). */
  private needBeats(p: SlicerParams): number {
    switch (p.prog) {
      case "roll": {
        let size = p.schedule ? 0 : this.ref(p.sizeBeats);
        if (p.schedule) for (const s of p.schedule.sizes) size = Math.max(size, s);
        return 1 + 2 * size;
      }
      case "replay": return p.backBeats + this.ref(p.lenBeats);
      case "random": case "order": return p.sourceBeats + this.ref(p.sliceBeats);
      case "scramble": return 2 * p.sourceBeats;
      case "chromatic": return 2 * this.ref(p.windowBeats);
      case "fractal": case "freeform": return 2 * this.ref(p.stepBeats);
      case "glide": return 2 * this.ref(p.sliceBeats);
      default: return 0;
    }
  }

  private ref(r: BeatsRef): number {
    return r === "beats" ? this.beats : r;
  }

  /** Frames for a length in beats at the anchoring tempo. */
  private fr(beats: number): number {
    return snap(beats * this.fpbE);
  }

  /** The step grid in beats (0 = none). Tape moves only step for a pending B release. */
  private grid(p: SlicerParams): number {
    if (this.releasing) return 0;
    switch (p.prog) {
      case "roll": return this.rollSize(p);
      case "replay": return p.sliceBeats * this.fit;
      case "random": case "order": case "scramble": case "glide": return this.ref(p.sliceBeats) * this.fit;
      case "chromatic": return this.ref(p.windowBeats) * this.fit;
      case "fractal": case "freeform": return this.ref(p.stepBeats) * this.fit;
      default: return this.relStep ? 0.25 : 0;
    }
  }

  private rollSize(p: Extract<SlicerParams, { prog: "roll" }>): number {
    if (!p.schedule) return this.ref(p.sizeBeats) * this.fit;
    const { sizes, at } = p.schedule;
    let k = 0;
    for (let j = 1; j < sizes.length; j++) if (this.v.rho >= at[j]) k = j;
    return sizes[k] * this.fit;
  }

  /** Fixes the program's windows from the step heard (`bh`); `bc`/`absB` is the slice now starting and its frame. */
  private anchor(p: SlicerParams, bh: number, bc: number, absB: number): void {
    this.fpbE = this.fpbNow;
    switch (p.prog) {
      case "roll": {
        if (p.steps) {
          this.winB = NaN;
          break;
        }
        const size = this.rollSize(p);
        this.winB = p.anchor === "beat" ? Math.floor(bh + EPS) : Math.floor(bh / size + EPS) * size;
        this.winAbs = snap(absB + (this.winB - bc) * this.fpbE);
        break;
      }
      case "replay": {
        const len = this.ref(p.lenBeats) * this.fit;
        this.winB = Math.floor(bh / len + EPS) * len;
        this.winAbs = snap(absB + (this.winB - p.backBeats * this.fit - bc) * this.fpbE);
        break;
      }
      case "random": case "order": case "scramble": case "chromatic": {
        const step = p.prog === "chromatic" ? this.ref(p.windowBeats) * this.fit
          : p.prog === "scramble" ? p.sourceBeats * this.fit : this.ref(p.sliceBeats) * this.fit;
        const span = p.prog === "chromatic" ? step : p.sourceBeats * this.fit;
        this.winB = Math.floor(bh / step + EPS) * step;
        this.winAbs = snap(absB + (this.winB - span - bc) * this.fpbE);
        if (p.prog === "chromatic") this.slot = Math.round((bc - this.winB) / step) - 1;
        break;
      }
      default:
        break;
    }
  }

  // ---- Slice decisions ----

  /** True when [lo, lo + frames) stays held for a slice that reads it (the overwrite edge moves once the ring is full). */
  private held(lo: number, frames: number): boolean {
    return lo >= this.heldLo + 2 + (this.edgeMoves ? frames + this.fadeF : 0);
  }

  /** The anchored window of `frames` is complete by `absB` and its start stays held through a slice of `dur` frames. */
  private winOk(frames: number, dur: number, absB: number): boolean {
    return this.held(this.winAbs, dur) && this.winAbs + frames <= absB + EPS;
  }

  private setLive(gain: number): void {
    const s = this.spec;
    s.live = true;
    s.gain = gain;
    s.gl = 1;
    s.gr = 1;
    s.ratio = 1;
    s.mul = 1;
    s.bounded = false;
  }

  private setRead(pos: number, ratio: number, gain = 1): void {
    const s = this.spec;
    s.live = false;
    s.pos = pos;
    s.ratio = ratio;
    s.mul = 1;
    s.gain = gain;
    s.gl = 1;
    s.gr = 1;
    s.bounded = false;
  }

  private setBounds(lo: number, hi: number): void {
    this.spec.bounded = true;
    this.spec.lo = lo;
    this.spec.hi = hi;
  }

  /** Fills `spec` for the slice starting at beat `bb`, whose first frame is `absB`. */
  private decide(p: SlicerParams, bb: number, absB: number): void {
    const v = this.v;
    switch (p.prog) {
      case "roll": {
        const size = this.rollSize(p);
        if (p.steps) {
          const s = Math.floor(mod(bb, 4) / 0.25 + EPS) + 1;
          if (s < p.steps[0] || s > p.steps[1]) {
            this.winB = NaN;
            return this.setLive(1);
          }
          if (Number.isNaN(this.winB)) {
            this.winB = bb;
            this.winAbs = absB;
            return this.setLive(1);
          }
        }
        if (bb - this.winB < EPS) return this.setLive(1); // the first pass is live: slip by construction
        const frames = this.fr(size);
        if (!this.held(this.winAbs, frames)) {
          this.winB = bb;
          this.winAbs = absB;
          return this.setLive(1);
        }
        if (p.repeatGain !== undefined) this.rgain *= curveValue(p.repeatGain, v);
        const ratio = p.pitchSt !== undefined ? 2 ** (curveValue(p.pitchSt, v) / 12) : 1;
        this.setRead(this.winAbs, ratio, this.rgain);
        if (p.pitchSt !== undefined) this.setBounds(this.winAbs, this.winAbs + frames);
        return;
      }
      case "replay": {
        const len = this.ref(p.lenBeats) * this.fit, sl = p.sliceBeats * this.fit;
        if (!this.winOk(this.fr(len), this.fr(sl), absB)) this.anchor(p, bb, bb, absB);
        if (!this.winOk(this.fr(len), this.fr(sl), absB)) return this.fallback(bb, absB, sl);
        this.fbB = NaN;
        const count = Math.max(1, Math.round(len / sl));
        const start = this.winAbs + this.fr(mod(Math.round((bb - this.winB) / sl), count) * sl);
        if (hash01(Math.round(bb / sl), 0, 11) < curveValue(p.reverseChance, v)) {
          this.setRead(start + this.fr(sl) - 1, -1);
        } else {
          this.setRead(start, 1);
        }
        return;
      }
      case "random": case "order": case "scramble": {
        const src = p.sourceBeats * this.fit, sl = this.ref(p.sliceBeats) * this.fit;
        if (!this.winOk(this.fr(src), this.fr(sl), absB)) this.anchor(p, bb, bb, absB);
        if (!this.winOk(this.fr(src), this.fr(sl), absB)) return this.fallback(bb, absB, sl);
        this.fbB = NaN;
        const count = Math.max(1, Math.round(src / sl));
        const j = Math.round((bb - this.winB) / sl);
        let q: number;
        let pan = 0;
        if (p.prog === "random") {
          const bar = Math.floor(bb / 4 + EPS), k = Math.round((bb - bar * 4) / sl);
          q = Math.min(count - 1, Math.floor(hash01(bar, k, 1) * count));
          pan = hash01(bar, k, 2) < 0.5 ? -p.pan : p.pan;
        } else if (p.prog === "order") {
          q = p.order.length ? mod(p.order[mod(j, p.order.length)], count) : mod(j, count);
        } else {
          const perms = p.tables[count];
          const perm = perms?.length ? perms[mod(Math.floor(j / count), perms.length)] : null;
          q = perm ? mod(perm[mod(j, count)] ?? 0, count) : mod(j, count);
        }
        this.setRead(this.winAbs + this.fr(q * sl), 1);
        this.spec.gl = Math.min(1, 1 - pan);
        this.spec.gr = Math.min(1, 1 + pan);
        return;
      }
      case "chromatic": {
        const w = this.ref(p.windowBeats) * this.fit;
        if (!this.winOk(this.fr(w), this.fr(w), absB)) {
          this.fpbE = this.fpbNow;
          this.winB = bb;
          this.winAbs = absB - this.fr(w);
        }
        const frames = this.fr(w);
        if (!this.winOk(frames, frames, absB)) return this.fallback(bb, absB, w);
        this.fbB = NaN;
        const n = Math.max(1, Math.round(curveValue(p.slots, v)));
        this.slot = this.slot + 1 >= n ? 0 : this.slot + 1;
        this.setRead(this.winAbs, 2 ** (this.slot / 12));
        this.setBounds(this.winAbs, this.winAbs + frames);
        return;
      }
      case "fractal": case "freeform": {
        const st = this.ref(p.stepBeats) * this.fit;
        let op: SliceOp | null = null;
        if (p.prog === "fractal") {
          const idx = Math.round(bb / st), s = mod(idx, 16);
          const table = p.tables[mod(Math.floor(idx / 16), p.tables.length)] ?? [];
          const count = Math.round(curveValue(p.altered, v));
          for (let k = 0; k < count && k < table.length; k++) if (table[k][0] === s) op = table[k][1];
        } else {
          const bar = Math.floor(bb / 4 + EPS), k = Math.round((bb - bar * 4) / st);
          if (hash01(bar, k, 3) < curveValue(p.chance, v)) op = FREEFORM_OPS[Math.floor(hash01(bar, k, 4) * 5)];
        }
        return this.stepOp(op, absB, this.fr(st));
      }
      case "glide": {
        const sl = this.ref(p.sliceBeats) * this.fit, frames = this.fr(sl);
        if (!this.held(absB - frames, frames)) return this.setLive(1);
        const sign = mod(Math.round(bb / sl), 2) === 1 ? -1 : 1;
        this.setRead(absB - frames, 1);
        this.spec.mul = 2 ** ((sign * curveValue(p.glideSt, v)) / 12 / Math.max(1, frames));
        return;
      }
      default:
        return this.setLive(1);
    }
  }

  /** A step that replays the step just before it (repeat, reverse, an octave up or down), skips, or stays live. */
  private stepOp(op: SliceOp | null, absB: number, frames: number): void {
    if (op === null) return this.setLive(1);
    if (op === "skip") return this.setLive(0);
    const lo = absB - frames;
    if (!this.held(lo, frames)) return this.setLive(1);
    if (op === "repeat") return this.setRead(lo, 1);
    if (op === "reverse") return this.setRead(absB - 1, -1);
    this.setRead(lo, op === "up" ? 2 : 0.5);
    this.setBounds(lo, absB);
  }

  /** After a seek, a replay rolls from where capture restarted until its window is captured (§2 S). */
  private fallback(bb: number, absB: number, sl: number): void {
    if (Number.isNaN(this.fbB) || !this.held(this.fbAbs, this.fr(sl))) {
      this.fbB = bb;
      this.fbAbs = absB;
    }
    if (bb - this.fbB < EPS) return this.setLive(1);
    this.setRead(this.fbAbs, 1);
  }

  private boundary(p: SlicerParams, bb: number, absB: number): void {
    if (this.releasing) return;
    if (this.relStep) {
      this.relStep = false;
      this.startRelease(this.fadeF);
      return;
    }
    if (this.tape) return;
    this.decide(p, bb, absB);
    this.begin(0, this.fadeF);
  }

  private startRelease(fade: number): void {
    this.releasing = true;
    this.relStep = false;
    this.setLive(1);
    this.begin(0, fade, true);
  }

  // ---- Heads ----

  /** Starts `spec` as the newest head, `offset` frames into its slice, fading in over `fade` frames (0 = at once). */
  private begin(offset: number, fade: number, force = false): void {
    const s = this.spec;
    const cur = this.newest;
    if (!force && s.live && cur.on && cur.live && cur.step >= 0 && cur.gain === s.gain) return;
    if (force && s.live && cur.on && cur.live && cur.step === 0 && cur.env === 1 && cur.gain === 1 && this.alone(cur)) return;
    const h = this.spawn(fade);
    h.live = s.live;
    h.ratio = s.ratio;
    h.mul = s.mul;
    h.gain = s.gain;
    h.gl = s.gl;
    h.gr = s.gr;
    h.bounded = s.bounded;
    h.lo = s.lo;
    h.hi = s.hi;
    let pos = s.pos + offset * s.ratio;
    if (s.bounded && s.hi - s.lo > 1) pos = s.lo + mod(pos - s.lo, s.hi - s.lo);
    h.pos = pos;
    this.vibBase = s.ratio;
  }

  /** True when no head but `h` is sounding. */
  private alone(h: Head): boolean {
    for (let k = 0; k < 3; k++) if (this.heads[k] !== h && this.heads[k].on) return false;
    return true;
  }

  /** Takes a free head (or the quietest one) and fades every other head out. */
  private spawn(fade: number): Head {
    let h: Head | null = null;
    for (let k = 0; k < 3; k++) if (!this.heads[k].on) h = h ?? this.heads[k];
    if (!h) {
      h = this.heads[0];
      for (let k = 1; k < 3; k++) if (this.heads[k].env < h.env) h = this.heads[k];
    }
    const out = fade > 0 ? -1 / fade : -1;
    for (let k = 0; k < 3; k++) {
      const o = this.heads[k];
      if (o.on && o !== h) o.step = Math.min(o.step, out);
    }
    h.on = true;
    h.env = fade > 0 ? 0 : 1;
    h.step = fade > 0 ? 1 / fade : 0;
    h.gainStep = 0;
    this.newest = h;
    return h;
  }

  /**
   * A read reached frames that are not held: it fades out over 3 ms, and a step program goes live behind it. Reverse
   * releases to live, as at its cap; Spinback and Brake fade to silence.
   */
  private kill(h: Head): void {
    if (h.step < 0) return;
    h.step = -1 / this.fadeF;
    if (h !== this.newest || this.releasing) return;
    if (!this.tape) {
      this.setLive(1);
      this.begin(0, this.fadeF);
    } else if (this.p?.prog === "reverse") this.startRelease(this.fadeF);
  }

  /** Per-quantum program moves on the newest head: roll pitch and vibrato depth, the spinback rate and fade. */
  private quantumMods(p: SlicerParams, v: CurveInputs, n: number): void {
    if (p.prog === "roll") this.vibSt = p.vibrato ? curveValue(p.vibrato.st, v) : 0;
    const h = this.newest;
    if (!h.on || h.live || h.step < 0) return;
    if (p.prog === "roll") {
      if (p.pitchSt !== undefined) {
        h.ratio = 2 ** (curveValue(p.pitchSt, v) / 12);
        this.vibBase = h.ratio;
      }
    } else if (p.prog === "spin") {
      h.ratio = Math.min(-EPS, curveValue(p.rate, v));
      h.gainStep = (1 - Math.max(0, Math.min(1, v.rho)) - h.gain) / Math.max(1, n);
    }
  }

  private render(
    p: SlicerParams, from: number, to: number, absFirst: number,
    inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array,
  ): void {
    const fader = this.fader, fadeF = this.fadeF;
    const vib = p.prog === "roll" && p.vibrato !== undefined && this.vibSt !== 0 ? (2 * Math.PI * p.vibrato.hz) / this.fs : 0;
    const brake = p.prog === "brake";
    for (let i = from; i < to; i++) {
      const cur = absFirst + i;
      const nh = this.newest;
      if (nh.on && !nh.live && nh.step >= 0) {
        if (brake) {
          const x = this.t / this.tapeT;
          nh.ratio = x < 1 ? (1 - x) ** 1.5 : 0;
          nh.gain = x < 0.9 ? 1 : x < 1 ? (1 - x) * 10 : 0;
        } else if (vib !== 0) {
          nh.ratio = this.vibBase * 2 ** ((this.vibSt * Math.sin(vib * this.t)) / 12);
        }
      }
      let oL = 0, oR = 0;
      for (let k = 0; k < 3; k++) {
        const h = this.heads[k];
        if (!h.on) continue;
        let sl: number, sr: number;
        if (h.live) {
          sl = inL[i];
          sr = inR[i];
        } else {
          let pos = h.pos;
          if (h.bounded) pos = pos < h.lo ? h.lo : pos > h.hi - 1 ? h.hi - 1 : pos;
          if (pos > cur) pos = cur;
          if (pos < this.heldLo + 1) {
            pos = this.heldLo + 1;
            this.kill(h);
          } else if (h.ratio < 0 && !h.bounded && h.step >= 0 && pos + (h.ratio - 1) * fadeF - 2 < this.heldLo) {
            this.kill(h);
          }
          h.pos = pos;
          this.read(pos, Math.abs(h.ratio));
          sl = this.rl * fader;
          sr = this.rr * fader;
        }
        const w = h.env >= 1 ? h.gain : (0.5 - 0.5 * Math.cos(Math.PI * h.env)) * h.gain;
        oL += sl * w * h.gl;
        oR += sr * w * h.gr;
        if (!h.live) {
          h.pos += h.ratio;
          if (h.mul !== 1) h.ratio *= h.mul;
        }
        if (h.step !== 0) {
          h.env += h.step;
          if (h.env >= 1 - 1e-9) {
            h.env = 1;
            h.step = 0;
          } else if (h.env <= 1e-9) {
            h.on = false;
          }
        }
        if (h.gainStep !== 0) h.gain += h.gainStep;
      }
      outL[i] = oL;
      outR[i] = oR;
      // A bounded head loops inside its window: the next pass fades in while this one ends exactly at the edge.
      const b = this.newest;
      if (b.on && b.bounded && !b.live && b.step >= 0 && b.hi - b.lo > 2 * fadeF * Math.abs(b.ratio)
        && (b.ratio > 0 ? b.pos + fadeF * b.ratio >= b.hi - 1 : b.ratio < 0 && b.pos + fadeF * b.ratio <= b.lo)) {
        const s = this.spec;
        s.live = false;
        s.pos = b.ratio > 0 ? b.lo : b.hi - 1;
        s.ratio = b.ratio;
        s.mul = b.mul;
        s.gain = b.gain;
        s.gl = b.gl;
        s.gr = b.gr;
        s.bounded = true;
        s.lo = b.lo;
        s.hi = b.hi;
        this.begin(0, fadeF);
      }
      this.t++;
    }
  }

  /**
   * Reads both channels at absolute position `pos` (held, clamped to the written range) for a head moving at speed `r`:
   * a cubic Hermite up to 1.5×, above it a windowed sinc with its cutoff scaled by 1/r, so the read itself cannot fold
   * the top octave down (the anti-alias low-pass, §2 S).
   */
  private read(pos: number, r: number): void {
    const ring = this.ring!;
    const rp = pos - this.base;
    const i0 = Math.floor(rp);
    const f = rp - i0;
    const lo = this.loR, hi = this.hiR;
    if (r > AA_RATIO) {
      const fc = 0.45 / r, W = Math.ceil(4 * r); // cutoff in cycles per source frame; half-width in frames
      let l = 0, rr = 0, sum = 0;
      for (let k = 1 - W; k <= W; k++) {
        const x = k - f;
        const c = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / W));
        const j = i0 + k < lo ? lo : i0 + k > hi ? hi : i0 + k;
        l += c * ring.at(0, j);
        rr += c * ring.at(1, j);
        sum += c;
      }
      this.rl = l / sum;
      this.rr = rr / sum;
      return;
    }
    if (f === 0) {
      this.rl = ring.at(0, i0);
      this.rr = ring.at(1, i0);
      return;
    }
    const im = i0 - 1 < lo ? lo : i0 - 1;
    const i1 = i0 + 1 > hi ? hi : i0 + 1;
    const i2 = i0 + 2 > hi ? hi : i0 + 2;
    this.rl = hermite(ring.at(0, im), ring.at(0, i0), ring.at(0, i1), ring.at(0, i2), f);
    this.rr = hermite(ring.at(1, im), ring.at(1, i0), ring.at(1, i1), ring.at(1, i2), f);
  }

  /**
   * Brake's low-pass that follows its rate, on frames [from, to), faded in and out over 3 ms. It runs per segment
   * between slice edges. (The anti-alias filtering of fast heads happens at the read.)
   */
  private postLowpass(p: SlicerParams, v: CurveInputs, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    let on = false, hz = 0;
    if (p.prog === "brake") {
      const follow = curveValue(p.lpFollow, v);
      const h = this.newest;
      if (follow > 1e-3 && h.on && !h.live && h.gain > 0 && !this.releasing) {
        on = true;
        hz = 20000 * Math.max(h.ratio, 1e-3) ** follow;
      }
    }
    if (!on && this.lpMix === 0) return;
    if (on) {
      hz = Math.max(40, Math.min(0.45 * this.fs, hz));
      if (this.lpMix === 0 && !this.lpOn) {
        this.lp.reset();
        this.lp.set(hz, Math.SQRT1_2, true);
      } else {
        this.lp.set(hz, Math.SQRT1_2);
      }
    }
    this.lpOn = on;
    if (this.bufL.length < to) {
      this.bufL = new Float32Array(to);
      this.bufR = new Float32Array(to);
    }
    const bl = this.bufL, br = this.bufR;
    for (let i = from; i < to; i++) {
      bl[i] = outL[i];
      br[i] = outR[i];
    }
    this.lp.process(bl, br, from, to);
    const d = (on ? 1 : -1) / this.fadeF;
    let mix = this.lpMix;
    for (let i = from; i < to; i++) {
      mix = Math.max(0, Math.min(1, mix + d));
      outL[i] += mix * (bl[i] - outL[i]);
      outR[i] += mix * (br[i] - outR[i]);
    }
    this.lpMix = mix;
    if (mix === 0) this.lp.reset();
  }
}

function hermite(xm: number, x0: number, x1: number, x2: number, f: number): number {
  const c1 = 0.5 * (x1 - xm);
  const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Builds a slicer voice (block S) at the node's sample rate; `filter` supplies Brake's low-pass. */
export const createSlicer: CreateSlicer = (sampleRate, filter) => new Slicer(sampleRate, filter);
