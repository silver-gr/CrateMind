// Deck FX rack engine (§1, §2, §7): three voice slots, the preset interpreter and macro, engage/switch/release, exits,
// the capture ring, bypass and output safety. No DOM or worklet globals: fx-rack.worklet.js wraps it, and the tests and
// the bench drive it directly.
import {
  Crusher, DELAY_MODES, DcBlock, DelayBlock, GATE_SHAPES, GEN_KINDS, Gate, Generator, HIT_KINDS, Phaser, Reverb,
  ShortDelay, Svf, lfoShape, panGain, smoothed, tanhR,
} from "./blocks";
import { NodeClock } from "./clock";
import { SLICE_GATE_PATTERNS, curveValue, keyHz, presetById } from "./presets";
import {
  CaptureRing, type BeatsRef, type BeatsValue, type CreateSlicer, type Curve, type CurveInputs, type DelaySend,
  type FilterParams, type FxFromNode, type FxPreset, type FxRackParamValues, type FxReleaseMsg, type FxToNode,
  type GateParams, type KeyTune, type QuantumClock, type ReverbSend, type ShortDelayParams, type SlicerVoice, type SvfMode,
} from "./types";

/** Frames per internal step; a longer render quantum is processed in chunks. */
const CHUNK = 128;
const SLOTS = 3;
/** A released voice sleeps after 200 ms below −90 dBFS, and is faded out 32 beats after its release at the latest. */
const SLEEP_LEVEL = 10 ** (-90 / 20);
const SLEEP_SECONDS = 0.2;
const TAIL_CAP_BEATS = 32;
/** The insert law k = min(1, a/0.15). */
const INS_KNEE = 0.15;
/** A pre-clip peak above this is a runaway: hot input (trim +12 dB, limiter off) peaks near 4. */
const FAULT_PEAK = 16;

const IDLE = 0, ACTIVE = 1, RELEASED = 2, KILLING = 3;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const dbGain = (db: number) => 10 ** (db / 20);

/** Final soft clip: identity to 0.9, approaching 1.0 (reaches it from 1.2). */
export function softClip(y: number): number {
  if (y <= 0.9 && y >= -0.9) return y;
  return y > 0 ? 0.9 + 0.1 * tanhR((y - 0.9) / 0.1) : -0.9 - 0.1 * tanhR((-y - 0.9) / 0.1);
}

/** A per-sample gain ramp that can start part-way into a chunk. */
class Ramp {
  v = 0;
  private target = 0;
  private from = 0;
  /** Length of the running ramp in frames; 0 = still. */
  private len = 0;
  private pos = 0;
  private at = 0;

  set(v: number): void {
    this.v = this.target = this.from = v;
    this.len = this.pos = this.at = 0;
  }

  /** Ramps to `target` over `frames` on a raised-cosine curve (no slope step at either end), from frame `at` of the next fill. */
  to(target: number, frames: number, at = 0): void {
    this.target = target;
    this.from = this.v;
    this.len = target === this.v ? 0 : Math.max(1, frames);
    this.pos = 0;
    this.at = at;
  }

  get moving(): boolean {
    return this.len !== 0;
  }

  get goal(): number {
    return this.target;
  }

  fill(buf: Float32Array, n: number): void {
    if (this.len === 0) {
      buf.fill(this.v, 0, n);
      return;
    }
    let i = 0;
    for (; i < this.at && i < n; i++) buf[i] = this.v;
    const from = this.from, d = this.target - from, len = this.len;
    for (; i < n; i++) {
      if (++this.pos >= len) {
        this.v = this.target;
        this.len = 0;
        buf.fill(this.v, i, n);
        break;
      }
      this.v = from + d * (0.5 - 0.5 * Math.cos((Math.PI * this.pos) / len));
      buf[i] = this.v;
    }
    this.at = Math.max(0, this.at - n);
  }
}

/** What a preset's blocks need besides the curve inputs. */
export type BlockContext = {
  fs: number;
  /** Frames per beat (a 120 BPM stand-in when the deck has none). */
  fpb: number;
  /** The selected BEATS value as a number (1 when it is not one). */
  beats: number;
  beatsValue: BeatsValue | null;
  rootPc: number | null;
  /** 1 with key lock, else the deck rate (K presets follow the heard pitch). */
  keyRate: number;
};

const ref = (r: BeatsRef, ctx: BlockContext) => (r === "beats" ? ctx.beats : r);
const keyEnd = (key: KeyTune | undefined, ctx: BlockContext) =>
  key && ctx.rootPc !== null ? keyHz(ctx.rootPc, key, 0) * ctx.keyRate : null;

/** A curve with its end value replaced (a filter's key, §1 contract notes); no allocation. */
function curveTo(c: Curve, v: CurveInputs, end: number | null): number {
  if (end === null) return curveValue(c, v);
  if (typeof c === "number") return end;
  const raw = c.by === "m" ? v.m : c.by === "rho" ? v.rho : c.by === "t" ? v.t / (c.overBeats ?? 1) : v.a;
  const x = clamp(raw, 0, 1) ** (c.pow ?? 1);
  return c.c === "E" ? c.from * (end / c.from) ** x : c.from + (end - c.from) * x;
}

/** Cutoff of a filter at the inputs, its key applied. */
const filterHz = (f: FilterParams, v: CurveInputs, ctx: BlockContext) => curveTo(f.hz, v, keyEnd(f.key, ctx));

/** An LFO-swept cutoff (or delay length): from `lo` up to `value` on a log scale, at shape s ∈ 0..1. */
const swept = (value: number, lo: number, depth: number, s: number) => value * (lo / value) ** (depth * (1 - s));

/** Configures a D block for one quantum: mode, feedback, loop filters, modulation and read lengths. */
export function setupDelay(b: DelayBlock, d: DelaySend, v: CurveInputs, ctx: BlockContext, clock: QuantumClock, snap: boolean): void {
  const mode = DELAY_MODES[d.mode];
  b.mode = mode;
  const fb = clamp(curveValue(d.fb, v), 0, 0.98);
  b.fb = snap ? fb : smoothed(b.fb, fb, CHUNK, 0.02 * ctx.fs);
  b.drive = d.drive === undefined ? 1 : Math.max(0.1, curveValue(d.drive, v));
  b.cross = d.cross ?? 0;
  b.norm = mode === DELAY_MODES.comb ? Math.sqrt(1 - fb * fb) : 1;
  if (mode === DELAY_MODES.dual) {
    b.p0L = panGain(d.pan?.[0] ?? -0.7, 0);
    b.p0R = panGain(d.pan?.[0] ?? -0.7, 1);
    b.p1L = panGain(d.pan?.[1] ?? 0.7, 0);
    b.p1R = panGain(d.pan?.[1] ?? 0.7, 1);
  }
  b.setMod(d.wow?.hz ?? 0, d.wow?.ms ?? 0, d.flutter?.hz ?? 0, d.flutter?.ms ?? 0);
  const comb = mode === DELAY_MODES.comb;
  // The comb's DC blocker sits lower (0.5 Hz) so its phase lead barely moves the peaks above f0.
  b.dc.setCorner(comb ? 0.5 : 3.8);
  let i = 0, hasHp = false;
  const loop = d.loop;
  for (let j = 0; loop && j < loop.length; j++) {
    const f = loop[j];
    let hz = filterHz(f, v, ctx);
    if (f.lfo) {
      const s = lfoShape(f.lfo.shape === "sine" ? 1 : 2, clock.beat / Math.max(1e-6, ref(f.lfo.periodBeats ?? 1, ctx)));
      hz = swept(hz, f.lfo.lo, f.lfo.depth === undefined ? 1 : curveValue(f.lfo.depth, v), s);
    }
    if (f.type === "hp") {
      hasHp = true;
      if (!comb) hz = Math.max(80, hz);
    }
    b.setLoop(i++, f.type === "peak" ? "bp" : f.type, hz, f.q === undefined ? 0.7071 : curveValue(f.q, v), snap);
  }
  if (!comb && !hasHp) b.setLoop(i++, "hp", 80, 0.7071, snap);
  b.nLoop = i;
  const slew = (mode === DELAY_MODES.tape ? d.slewMs ?? 100 : 50) * ctx.fs / 1000;
  if (comb) {
    const f0 = keyHz(ctx.rootPc, d.key ?? { lo: 55, hi: 110 }, d.combHz ?? 110) * (ctx.rootPc === null ? 1 : ctx.keyRate);
    b.setTimes(ctx.fs / f0, ctx.fs / f0, slew, f0);
    return;
  }
  const t = d.timeBeats ?? "beats";
  const pair = t === "beats" && Array.isArray(ctx.beatsValue) ? (ctx.beatsValue as readonly [number, number]) : null;
  b.setTimes(fitFrames(pair ? pair[0] : ref(t, ctx), ctx.fpb, b.maxFrames), fitFrames(pair ? pair[1] : ref(t, ctx), ctx.fpb, b.maxFrames), slew, 1000);
}

/** A delay time in frames; one that does not fit the line halves BEATS until it does. */
function fitFrames(beats: number, fpb: number, max: number): number {
  let frames = beats * fpb;
  while (frames > max) frames /= 2;
  return frames;
}

/** A generator's own reverb (Lift's noise): plain plate, `t60Beats` long. */
const GEN_REVERB: ReverbSend = { t60Beats: 4, send: 0 };

/**
 * Configures an R block: T60 (beats → seconds), size, pre-delay, damping, input HP, modulation, shimmer and gate.
 * `t60Beats` overrides the preset's T60 (a generator's reverb).
 */
export function setupReverb(r: Reverb, full: ReverbSend, v: CurveInputs, ctx: BlockContext, snap: boolean, t60Beats?: number): void {
  const t60 = t60Beats ?? (full.t60Beats === "beats" ? ctx.beats : curveValue(full.t60Beats, v));
  r.t60 = (t60 * ctx.fpb) / ctx.fs;
  r.size = full.size ?? 1;
  r.preFrames = (full.preDelayBeats ?? 0) * ctx.fpb;
  r.damp = full.damp ?? 0.35;
  r.mod = full.mod ?? 1;
  r.shimmer = full.shimmer === undefined ? 0 : curveValue(full.shimmer, v);
  r.inHp.set(Math.max(80, full.inHp === undefined ? 80 : curveValue(full.inHp, v)), 0.7071, snap);
  r.useGate = !!full.gate;
  if (full.gate) setupGate(r.gate, full.gate, v, ctx);
}

/** Configures a G block. */
export function setupGate(g: Gate, p: GateParams, v: CurveInputs, ctx: BlockContext): void {
  g.shape = GATE_SHAPES[p.shape];
  g.cycleBeats = ref(p.stepBeats, ctx) * (p.stepMul ?? 1);
  g.duty = p.duty ?? 0.5;
  g.edgeMs = p.edgeMs ?? 2;
  g.depth = clamp(curveValue(p.depth, v), 0, 1);
  g.tauBeats = p.tauBeats === undefined ? 0.25 : curveValue(p.tauBeats, v);
  g.attackMs = p.attackMs ?? 1;
  g.invert = !!p.invert;
  const bv = ctx.beatsValue;
  if (p.shape === "pattern") g.setPattern(SLICE_GATE_PATTERNS[bv && typeof bv === "object" && "pattern" in bv ? bv.pattern : 0]);
}

function setupShort(s: ShortDelay, p: ShortDelayParams, v: CurveInputs, ctx: BlockContext): void {
  s.msHi = curveValue(p.ms, v);
  s.fb = clamp(curveValue(p.fb, v), 0, 0.95);
  s.mix = clamp(curveValue(p.mix, v), 0, 1);
  if (p.lfo) {
    s.lfo = p.lfo.shape === "sine" ? 1 : 2;
    s.msLo = p.lfo.lo;
    s.depth = p.lfo.depth === undefined ? 1 : curveValue(p.lfo.depth, v);
    s.hz = p.lfo.hz ?? 0;
    s.periodBeats = ref(p.lfo.periodBeats ?? 1, ctx);
  } else {
    s.lfo = 0;
    s.msLo = s.msHi;
    s.depth = 0;
    s.hz = 0;
  }
}

/** One voice slot: the blocks of any preset, preallocated, and the state of the preset it plays. */
class Voice {
  state = IDLE;
  preset: FxPreset | null = null;
  order = 0;
  slicer: SlicerVoice | null;
  private beatsValue: BeatsValue | null = null;
  private beats = 1;
  private pendingBeats = -1;
  private beatsAt = Number.NaN;
  private engageBeat = 0;
  private rampEnd = Number.NaN;
  private releaseAt = Number.NaN;
  /** Beats played since the release (counted, so a seek cannot stall the tail cap). */
  private tailBeats = 0;
  private waitSlicer = false;
  private quiet = 0;
  private first = true;
  private exitStart = Number.NaN;
  private exitReturning = false;
  private dryLast = 1;
  private readonly exitRet = new Ramp();
  readonly ins = new Ramp();
  readonly send = new Ramp();
  readonly gen = new Ramp();
  readonly kill = new Ramp();
  private readonly v: CurveInputs = { a: 0, m: 0, rho: 0, t: 0 };
  private readonly ctx: BlockContext;
  // Smoothed per-quantum gains (start of the next quantum).
  private kPrev = 0;
  private mixPrev = 0;
  private gainPrev = 1;
  private dSendPrev = 0;
  private rSendPrev = 0;
  private readonly genPrev = new Float64Array(2);
  // Blocks.
  readonly delay: DelayBlock;
  readonly reverb: Reverb;
  private readonly short: ShortDelay;
  private readonly phaser: Phaser;
  private readonly gate: Gate;
  private readonly crusher: Crusher;
  private readonly filters: Svf[];
  private readonly gens: Generator[];
  // Buffers.
  private readonly yL = new Float32Array(CHUNK);
  private readonly yR = new Float32Array(CHUNK);
  private readonly sL = new Float32Array(CHUNK);
  private readonly sR = new Float32Array(CHUNK);
  private readonly dL = new Float32Array(CHUNK);
  private readonly dR = new Float32Array(CHUNK);
  private readonly rL = new Float32Array(CHUNK);
  private readonly rR = new Float32Array(CHUNK);
  private readonly gL = new Float32Array(CHUNK);
  private readonly gR = new Float32Array(CHUNK);
  private readonly tL = new Float32Array(CHUNK);
  private readonly tR = new Float32Array(CHUNK);
  private readonly vL = new Float32Array(CHUNK);
  private readonly vR = new Float32Array(CHUNK);
  private readonly insE = new Float32Array(CHUNK);
  private readonly sendE = new Float32Array(CHUNK);
  private readonly genE = new Float32Array(CHUNK);
  private readonly killE = new Float32Array(CHUNK);
  readonly dry = new Float32Array(CHUNK);

  constructor(private readonly fs: number, slicer: SlicerVoice | null) {
    this.slicer = slicer;
    this.ctx = { fs, fpb: fs / 2, beats: 1, beatsValue: null, rootPc: null, keyRate: 1 };
    this.delay = new DelayBlock(fs);
    this.reverb = new Reverb(fs);
    this.short = new ShortDelay(fs);
    this.phaser = new Phaser(fs);
    this.gate = new Gate(fs);
    this.crusher = new Crusher(fs);
    this.filters = [new Svf(fs), new Svf(fs)];
    this.gens = [new Generator(fs), new Generator(fs)];
  }

  get sounding(): boolean {
    return this.state === ACTIVE || this.state === RELEASED;
  }

  private setBeats(index: number): void {
    const p = this.preset!;
    this.beatsValue = p.beats ? p.beats.options[clamp(index, 0, p.beats.options.length - 1)] ?? p.beats.options[p.beats.def] : null;
    this.beats = typeof this.beatsValue === "number" ? this.beatsValue : 1;
    this.ctx.beatsValue = this.beatsValue;
    this.ctx.beats = this.beats;
  }

  start(p: FxPreset, beatsIndex: number, fadeFrames: number, beat: number, lagFrames: number, clock: QuantumClock, order: number, seed: number): void {
    this.preset = p;
    this.order = order;
    this.state = ACTIVE;
    this.setBeats(beatsIndex);
    this.pendingBeats = -1;
    this.beatsAt = this.rampEnd = this.releaseAt = Number.NaN;
    this.waitSlicer = false;
    this.quiet = 0;
    this.first = true;
    this.engageBeat = beat;
    this.exitStart = p.exit ? Math.floor(beat + 1e-9) + 1 : Number.NaN;
    this.exitReturning = false;
    this.dryLast = 1;
    this.exitRet.set(1);
    for (const r of [this.ins, this.send, this.gen]) {
      r.set(0);
      r.to(1, fadeFrames);
    }
    this.kill.set(1);
    this.kPrev = this.mixPrev = this.dSendPrev = this.rSendPrev = 0;
    this.gainPrev = 1;
    this.genPrev.fill(0);
    if (p.delay) this.delay.reset();
    if (p.reverb || p.gens?.some(g => g.reverb)) this.reverb.reset();
    this.short.reset();
    this.phaser.reset();
    this.gate.reset();
    this.crusher.reset();
    for (const f of this.filters) f.reset();
    this.gens.forEach((g, i) => g.reset(seed + i * 7919));
    if (p.ins?.slicer && this.slicer) this.slicer.start(p.ins.slicer, this.beats, clock, lagFrames);
  }

  /** A BEATS change: at once, or at the next step boundary for gates and slicers. */
  changeBeats(index: number, beat: number): void {
    const p = this.preset!;
    if (p.ins?.gate || p.ins?.slicer || p.gens?.some(g => g.gate)) {
      this.pendingBeats = index;
      this.beatsAt = this.nextStep(beat);
    } else this.setBeats(index);
  }

  /** The step a B release waits for: the gate cycle, else the BEATS value. */
  private stepBeats(): number {
    const p = this.preset!;
    const g = p.ins?.gate ?? p.gens?.find(x => x.gate)?.gate;
    return g ? ref(g.stepBeats, this.ctx) * (g.stepMul ?? 1) : this.beats;
  }

  private nextStep(beat: number): number {
    const s = Math.max(1e-6, this.stepBeats());
    return Math.ceil(beat / s - 1e-9) * s;
  }

  /**
   * Release: null = now (B waits for the next step and C for the next beat while playing), a beat = then. A Φ preset
   * takes it as its ramp end too. While paused nothing advances, so a release (or a pending one) happens at once, except
   * a Φ voice's ramp target, which waits for play to reach its line.
   */
  release(atBeat: number | null, beat: number, fpb: number, playing: boolean): void {
    if (this.state !== ACTIVE) return;
    if (atBeat !== null) {
      if (this.beatsValue === "phrase" && Number.isNaN(this.rampEnd)) this.rampEnd = atBeat;
      this.releaseAt = atBeat;
      return;
    }
    const kind = this.preset!.release.kind;
    if (kind === "B" && fpb > 0 && playing) {
      if (this.preset!.ins?.slicer && this.slicer) {
        this.slicer.release("step", 3);
        this.waitSlicer = true;
        this.state = RELEASED;
        this.tailBeats = 0;
        this.exitBack(0);
      } else this.releaseAt = this.nextStep(beat);
      return;
    }
    if (kind === "C" && fpb > 0 && playing) {
      this.releaseAt = Math.ceil(beat - 1e-9);
      return;
    }
    this.doRelease(0, fpb);
  }

  /** Cancels a pending release (a re-engage). */
  cancelRelease(): boolean {
    if (this.state !== ACTIVE || Number.isNaN(this.releaseAt)) return false;
    this.releaseAt = Number.NaN;
    return true;
  }

  private doRelease(at: number, fpb: number): void {
    this.tailBeats = 0;
    const r = this.preset!.release, ms = this.fs / 1000;
    let fade = 20 * ms, genFade = fade;
    if (r.kind === "B" || r.kind === "C") fade = genFade = 3 * ms;
    if (r.kind === "X") fade = genFade = r.fadeMs !== undefined ? r.fadeMs * ms : r.fadeBeats !== undefined && fpb > 0 ? r.fadeBeats * fpb : 5 * ms;
    if (r.kind === "C" && r.genFadeBeats !== undefined && fpb > 0) genFade = r.genFadeBeats * fpb;
    if (r.kind === "B" && fpb <= 0) fade = genFade = 5 * ms;
    this.ins.to(0, fade, at);
    this.send.to(0, fade, at);
    // Hit generators (clap, snare) stop triggering and let the last hit ring; the others fade.
    const gens = this.preset!.gens;
    if (r.kind === "T" && gens && gens.every(g => g.hits)) for (const g of this.gens) g.triggers = false;
    else this.gen.to(0, genFade, at);
    if (this.preset!.ins?.slicer && this.slicer) this.slicer.release("now", fade / ms);
    this.exitBack(at);
    this.state = RELEASED;
    this.quiet = 0;
  }

  /** The old voice of a switch: input fades out over 20 ms, feedback rings on. */
  retire(): void {
    if (this.state !== ACTIVE) return;
    const f = 0.02 * this.fs;
    this.ins.to(0, f);
    this.send.to(0, f);
    this.gen.to(0, f);
    if (this.preset!.ins?.slicer && this.slicer) this.slicer.release("now", 20);
    this.exitBack(0);
    this.state = RELEASED;
    this.tailBeats = 0;
    this.quiet = 0;
  }

  /** A third voice: fades all of this one out over 20 ms in its own slot. */
  fadeOut(): void {
    this.kill.to(0, 0.02 * this.fs);
    this.state = KILLING;
  }

  /** Exits: the dry returns over 20 ms from frame `at`. */
  exitBack(at: number): void {
    if (!this.preset?.exit || this.exitReturning) return;
    this.exitReturning = true;
    this.exitRet.set(this.dryLast);
    this.exitRet.to(1, 0.02 * this.fs, at);
  }

  idle(): void {
    this.state = IDLE;
    this.preset = null;
  }

  /**
   * Renders n frames. Adds the insert part (k·(y − x)) to insL/insR and the sends and generators to wetL/wetR, and
   * lowers `dry` for an exit. Returns the contribution's peak.
   */
  process(
    e: FxRackEngine, n: number, q: QuantumClock, a: number, fader: number, inL: Float32Array, inR: Float32Array,
    run: Float32Array, insL: Float32Array, insR: Float32Array, wetL: Float32Array, wetR: Float32Array, dry: Float32Array,
  ): number {
    const p = this.preset!, ctx = this.ctx, v = this.v, fs = this.fs;
    ctx.fpb = q.framesPerBeat > 0 ? q.framesPerBeat : fs / 2;
    ctx.rootPc = e.rootPc;
    ctx.keyRate = e.keylock ? 1 : e.clock.rate;
    const hasBpm = q.framesPerBeat > 0;
    // Pending BEATS change at its step boundary.
    if (this.pendingBeats >= 0 && q.beat >= this.beatsAt - 1e-9) {
      this.setBeats(this.pendingBeats);
      this.pendingBeats = -1;
      if (p.ins?.slicer && this.slicer && this.state === ACTIVE) this.slicer.start(p.ins.slicer, this.beats, q, 0);
    }
    // Curve inputs.
    const t = hasBpm ? Math.max(0, q.beat - this.engageBeat) : 0;
    let rho: number;
    if (this.beatsValue === "phrase") rho = Number.isNaN(this.rampEnd) ? 0 : t / Math.max(1e-6, this.rampEnd - this.engageBeat);
    else rho = t / Math.max(1e-6, this.beats);
    rho = clamp(rho, 0, 1);
    v.a = a;
    v.t = t;
    v.rho = rho;
    v.m = p.macro ? a * rho ** 1.5 : a;
    // A release on its beat, at the exact frame.
    let relAt = -1;
    if (this.state === ACTIVE && !Number.isNaN(this.releaseAt)) {
      if (q.beat >= this.releaseAt - 1e-9 || (!q.playing && this.beatsValue !== "phrase")) relAt = 0;
      else if (q.beatsPerFrame > 0) {
        const i = Math.ceil((this.releaseAt - q.beat) / q.beatsPerFrame - 1e-6);
        if (i < n) relAt = Math.max(0, i);
      }
    }
    // Exit: the dry formula until the release frame.
    if (p.exit && !this.exitReturning) {
      const over = Math.max(1e-6, ref(p.exit.overBeats, ctx));
      // A seek or a large re-phase moves B: keep the dry where it was.
      if (q.jumped && this.dryLast < 1) this.exitStart = q.beat - (1 - this.dryLast) * over;
      for (let i = 0; i < n; i++) {
        const d = 1 - clamp((q.beat + i * q.beatsPerFrame - this.exitStart) / over, 0, 1);
        this.dry[i] = d;
      }
    }
    if (relAt >= 0) {
      this.releaseAt = Number.NaN;
      if (p.exit && !this.exitReturning) this.dryLast = this.dry[relAt];
      this.doRelease(relAt, q.framesPerBeat);
    }
    if (p.exit) {
      if (this.exitReturning) this.exitRet.fill(this.dry, n);
      else if (relAt < 0) this.dryLast = this.dry[n - 1];
      for (let i = 0; i < n; i++) if (this.dry[i] < dry[i]) dry[i] = this.dry[i];
    }
    if (this.waitSlicer && this.slicer && this.slicer.idle) {
      this.waitSlicer = false;
      const f = 0.003 * fs;
      this.ins.to(0, f);
      this.send.to(0, f);
      this.gen.to(0, f);
    }
    this.ins.fill(this.insE, n);
    this.send.fill(this.sendE, n);
    this.gen.fill(this.genE, n);
    this.kill.fill(this.killE, n);
    const snap = this.first;
    this.first = false;
    let peak = 0;
    const yL = this.yL, yR = this.yR, insE = this.insE, killE = this.killE;

    // ---- Inserts: S → G → C → F → short D ----
    const ins = p.ins;
    if (ins) {
      if (ins.slicer && this.slicer) {
        this.slicer.process(e.ring, q, v, fader, inL, inR, yL, yR, n);
        // Reverse releases itself at its cap: the voice ends with it, as after a B release.
        if (this.state === ACTIVE && this.slicer.idle) {
          this.state = RELEASED;
          this.waitSlicer = true;
          this.releaseAt = Number.NaN;
          this.tailBeats = 0;
          this.quiet = 0;
        }
      } else {
        for (let i = 0; i < n; i++) {
          yL[i] = inL[i];
          yR[i] = inR[i];
        }
      }
      if (ins.gate) {
        setupGate(this.gate, ins.gate, v, ctx);
        this.gate.process(yL, yR, n, q);
      }
      if (ins.crusher) {
        this.crusher.bits = curveValue(ins.crusher.bits, v);
        this.crusher.rateHz = curveValue(ins.crusher.rateHz, v);
        this.crusher.postLp = ins.crusher.postLp ?? 0;
        this.crusher.process(yL, yR, n);
      }
      let fi = 0;
      const filters = ins.filters;
      for (let j = 0; filters && j < filters.length; j++) {
        const f = filters[j];
        if (f.type === "phaser") {
          const ph = this.phaser;
          ph.stages = f.stages;
          ph.lo = f.lo;
          ph.hi = f.hi;
          ph.fb = clamp(curveValue(f.fb, v), 0, 0.95);
          ph.mix = curveValue(f.mix, v);
          ph.periodBeats = ref(f.periodBeats, ctx);
          ph.process(yL, yR, n, q);
          continue;
        }
        const svf = this.filters[fi++];
        svf.setMode(f.type);
        const hz = filterHz(f, v, ctx), qv = f.q === undefined ? 0.7071 : curveValue(f.q, v);
        if (f.type === "peak") svf.setGain(f.gainDb === undefined ? 0 : curveValue(f.gainDb, v));
        if (f.lfo) {
          const lfo = f.lfo, shape = lfo.shape === "sine" ? 1 : 2, depth = lfo.depth === undefined ? 1 : curveValue(lfo.depth, v);
          const period = Math.max(1e-6, ref(lfo.periodBeats ?? 1, ctx));
          for (let s = 0; s < n; s += 16) {
            const sh = lfoShape(shape, (q.beat + s * q.beatsPerFrame) / period);
            svf.set(swept(hz, lfo.lo, depth, sh), qv, true);
            svf.process(yL, yR, s, Math.min(n, s + 16));
          }
        } else {
          svf.set(hz, qv, snap);
          if (snap && f.type === "lp") svf.prime(yL[0], yR[0]);
          svf.process(yL, yR, 0, n);
        }
      }
      if (ins.shortDelay) {
        setupShort(this.short, ins.shortDelay, v, ctx);
        this.short.process(yL, yR, n, q);
      }
      const gain = ins.gainDb === undefined ? 1 : dbGain(curveValue(ins.gainDb, v));
      const mix = ins.mix === undefined ? 1 : clamp(curveValue(ins.mix, v), 0, 1);
      const k = Math.min(1, a / INS_KNEE);
      if (snap) {
        this.kPrev = k;
        this.mixPrev = mix;
        this.gainPrev = gain;
      }
      const kS = (k - this.kPrev) / n, mS = (mix - this.mixPrev) / n, gS = (gain - this.gainPrev) / n;
      let kk = this.kPrev, mm = this.mixPrev, gg = this.gainPrev;
      for (let i = 0; i < n; i++) {
        kk += kS;
        mm += mS;
        gg += gS;
        const xl = inL[i], xr = inR[i];
        // y = x + mix·(gain·y − x); the voice adds k·(y − x).
        const ol = mm * (gg * yL[i] - xl), or = mm * (gg * yR[i] - xr);
        yL[i] = xl + ol;
        yR[i] = xr + or;
        const w = kk * insE[i] * killE[i] * run[i];
        const cl = w * ol, cr = w * or;
        insL[i] += cl;
        insR[i] += cr;
        const m = Math.abs(cl) > Math.abs(cr) ? Math.abs(cl) : Math.abs(cr);
        if (m > peak) peak = m;
      }
      this.kPrev = k;
      this.mixPrev = mix;
      this.gainPrev = gain;
    }
    const srcL = ins ? yL : inL, srcR = ins ? yR : inR;

    // ---- Generators ----
    const gens = p.gens;
    let genRev: { t60Beats: number; wet: number } | null = null;
    if (gens) {
      const genE = this.genE;
      this.gL.fill(0, 0, n);
      this.gR.fill(0, 0, n);
      this.vL.fill(0, 0, n);
      this.vR.fill(0, 0, n);
      for (let j = 0; j < gens.length && j < 2; j++) {
        const gp = gens[j], g = this.gens[j], src = gp.source;
        g.kind = GEN_KINDS[src.kind];
        if (src.kind === "tones") {
          const tr = src.transposeSt === undefined ? 0 : curveValue(src.transposeSt, v);
          g.f1 = keyHz(ctx.rootPc, src.key, src.hz) * (ctx.rootPc === null ? 1 : ctx.keyRate) * 2 ** (tr / 12);
          g.interval = src.interval;
          g.stepBeats = ref(src.stepBeats, ctx);
        } else if (src.kind === "clap") {
          g.bursts = src.bursts;
          g.gapMs = src.gapMs;
          g.tailMs = src.tailMs;
        } else if (src.kind === "snare") {
          g.bodyHz = src.bodyHz;
          g.dropPct = src.dropPct;
          g.dropMs = src.dropMs;
          g.bodyDecayMs = src.bodyDecayMs;
          g.noiseDecayMs = src.noiseDecayMs;
        }
        const bv = this.beatsValue;
        g.hits = gp.hits && bv && typeof bv === "object" && "hits" in bv ? HIT_KINDS[bv.hits] : -1;
        if (!hasBpm && g.hits >= 0) g.hits = -1;
        g.follow = gp.follow ? 1 : gp.rms ? 2 : 0;
        if (gp.follow) {
          g.attackMs = gp.follow.attackMs;
          g.releaseMs = gp.follow.releaseMs;
        }
        g.nFilters = 0;
        const gf = gp.filters;
        for (let h = 0; gf && h < gf.length; h++) {
          const f = gf[h], svf = g.filters[g.nFilters++];
          svf.setMode(f.type);
          svf.set(filterHz(f, v, ctx), f.q === undefined ? 0.7071 : curveValue(f.q, v), snap);
        }
        g.useGate = !!gp.gate;
        if (gp.gate) setupGate(g.gate, gp.gate, v, ctx);
        g.useFlanger = !!gp.flanger;
        if (gp.flanger) setupShort(g.flanger, gp.flanger, v, ctx);
        g.process(this.tL, this.tR, n, q, inL, inR);
        const level = curveValue(gp.level, v) * fader;
        if (snap) this.genPrev[j] = level;
        const lS = (level - this.genPrev[j]) / n;
        let lv = this.genPrev[j];
        const toRev = !!gp.reverb && !p.reverb;
        if (toRev) genRev = gp.reverb!;
        for (let i = 0; i < n; i++) {
          lv += lS;
          const w = lv * genE[i] * run[i];
          const ol = w * this.tL[i], or = w * this.tR[i];
          this.gL[i] += ol;
          this.gR[i] += or;
          if (toRev) {
            this.vL[i] += ol;
            this.vR[i] += or;
          }
        }
        this.genPrev[j] = level;
      }
    }

    // ---- Sends: D → R ----
    const d = p.delay, r = p.reverb;
    const useRev = !!r || genRev !== null;
    if (d || r) {
      const sendE = this.sendE;
      for (let i = 0; i < n; i++) {
        // An exit closes the send with the dry: the tail keeps only what played before and during the fade.
        const g = p.exit ? sendE[i] * (this.exitReturning ? this.dryLast : this.dry[i]) : sendE[i];
        this.sL[i] = g * srcL[i];
        this.sR[i] = g * srcR[i];
      }
    }
    let dSend = 0, rSend = 0;
    if (d) {
      setupDelay(this.delay, d, v, ctx, q, snap);
      this.delay.process(this.sL, this.sR, this.dL, this.dR, n);
      dSend = curveValue(d.send, v);
    }
    if (useRev) {
      if (r) {
        setupReverb(this.reverb, r, v, ctx, snap);
        rSend = curveValue(r.send, v);
      } else {
        setupReverb(this.reverb, GEN_REVERB, v, ctx, snap, genRev!.t60Beats);
        rSend = genRev!.wet;
      }
      const inRL = r ? (d?.intoReverb ? this.dL : this.sL) : this.vL, inRR = r ? (d?.intoReverb ? this.dR : this.sR) : this.vR;
      this.reverb.process(inRL, inRR, this.rL, this.rR, n, q);
    }
    if (snap) {
      this.dSendPrev = dSend;
      this.rSendPrev = rSend;
    }
    const dS = (dSend - this.dSendPrev) / n, rS = (rSend - this.rSendPrev) / n;
    let ds = this.dSendPrev, rs = this.rSendPrev;
    for (let i = 0; i < n; i++) {
      ds += dS;
      rs += rS;
      let ol = 0, or = 0;
      if (d) {
        ol += ds * this.dL[i];
        or += ds * this.dR[i];
      }
      if (useRev) {
        ol += rs * this.rL[i];
        or += rs * this.rR[i];
      }
      if (gens) {
        ol += this.gL[i];
        or += this.gR[i];
      }
      const kv = killE[i];
      ol *= kv;
      or *= kv;
      wetL[i] += ol;
      wetR[i] += or;
      const m = Math.abs(ol) > Math.abs(or) ? Math.abs(ol) : Math.abs(or);
      if (m > peak) peak = m;
    }
    this.dSendPrev = dSend;
    this.rSendPrev = rSend;

    // ---- Lifecycle ----
    if (this.state === KILLING) {
      if (!this.kill.moving && this.kill.v === 0) this.idle();
    } else if (this.state === RELEASED) {
      const settled = !this.ins.moving && !this.send.moving && !this.gen.moving && !this.waitSlicer
        && (!this.slicer || !p.ins?.slicer || this.slicer.idle);
      this.quiet = settled && peak < SLEEP_LEVEL ? this.quiet + n : 0;
      if (this.quiet >= SLEEP_SECONDS * fs) this.idle();
      else if ((this.tailBeats += n * Math.max(0, q.beatsPerFrame)) > TAIL_CAP_BEATS) this.fadeOut();
    }
    return peak;
  }
}

/** Options of the engine: the slicer factory (Integrate phase) and the PRNG seed. */
export type FxRackOptions = { createSlicer?: CreateSlicer; seed?: number };

/**
 * The FX rack of one deck. `message()` takes the host's messages, `process()` renders one quantum:
 * out = g·x + Σ inserts + DC(Σ sends and generators), then the soft clip while a voice sounds. With no voice the input
 * is copied through bit-exact; the capture ring is written in every path.
 */
export class FxRackEngine {
  readonly ring: CaptureRing;
  readonly clock: NodeClock;
  rootPc: number | null = null;
  minor = false;
  keylock = false;
  /** Level statistics of the last quantum (tests): the peak before the clip, and samples the clip changed. */
  prePeak = 0;
  clipped = 0;
  private readonly fs: number;
  private readonly post: (msg: FxFromNode) => void;
  private readonly voices: Voice[] = [];
  private preset: FxPreset | null = null;
  private beatsIndex = 0;
  /** A start waiting for a free slot, and a release posted for it meanwhile (a Φ target). */
  private pendingStart: { lag: number; fade: number; engage: boolean; release: number | null } | null = null;
  /** A release target posted while a seek clock is pending: it belongs to the post-seek B, so it waits for that clock. */
  private heldRelease: FxReleaseMsg | null = null;
  private amount = 0;
  private started = false;
  private order = 0;
  private seed: number;
  private lastEngaged = false;
  private lastTail = false;
  private readonly runRamp = new Ramp();
  private readonly clipRamp = new Ramp();
  private readonly dc: DcBlock;
  private readonly inL = new Float32Array(CHUNK);
  private readonly inR = new Float32Array(CHUNK);
  private readonly insL = new Float32Array(CHUNK);
  private readonly insR = new Float32Array(CHUNK);
  private readonly wetL = new Float32Array(CHUNK);
  private readonly wetR = new Float32Array(CHUNK);
  private readonly dry = new Float32Array(CHUNK);
  private readonly run = new Float32Array(CHUNK);
  private readonly clip = new Float32Array(CHUNK);

  constructor(sampleRate: number, post: (msg: FxFromNode) => void = () => {}, options: FxRackOptions = {}) {
    this.fs = sampleRate;
    this.post = post;
    this.seed = options.seed ?? 0x2545f491;
    this.ring = new CaptureRing(sampleRate);
    this.clock = new NodeClock(sampleRate);
    this.dc = new DcBlock(sampleRate);
    const filter = (mode: SvfMode) => new Svf(sampleRate, mode);
    for (let i = 0; i < SLOTS; i++) this.voices.push(new Voice(sampleRate, options.createSlicer?.(sampleRate, filter) ?? null));
    this.runRamp.set(1);
    this.clipRamp.set(0);
  }

  /** True while any voice sounds (engaged or ringing). */
  get busy(): boolean {
    return this.count(IDLE, true) > 0;
  }

  /** Node state as posted: engaged = a voice is on; tail = a released voice still rings. */
  get engaged(): boolean {
    return this.count(ACTIVE, false) > 0;
  }

  get tail(): boolean {
    return this.count(RELEASED, false) + this.count(KILLING, false) > 0;
  }

  /** Voices in `state` (or, with `not`, in any other state). */
  private count(state: number, not: boolean): number {
    let c = 0;
    for (let i = 0; i < SLOTS; i++) if ((this.voices[i].state === state) !== not) c++;
    return c;
  }

  message(msg: FxToNode): void {
    switch (msg.t) {
      case "clock":
        this.clock.set(msg);
        break;
      case "track":
        this.rootPc = msg.rootPc;
        this.minor = msg.minor;
        this.keylock = msg.keylock;
        if (msg.keep) break;
        this.ring.reset();
        for (const v of this.voices) v.exitBack(0);
        break;
      case "preset": {
        const p = presetById(msg.id);
        if (!p) return;
        const active = this.active();
        const changed = p !== this.preset;
        this.preset = p;
        this.beatsIndex = msg.beats;
        if (!active) return;
        if (changed) this.startVoice(0, 0.02 * this.fs, true);
        else active.changeBeats(msg.beats, this.clock.beat);
        break;
      }
      case "engage": {
        this.heldRelease = null;
        const active = this.active();
        if (active) {
          active.cancelRelease();
          return;
        }
        this.startVoice(Math.max(0, msg.lag) * this.fs, 0.005 * this.fs, false);
        break;
      }
      case "release": {
        if (msg.atBeat !== null && this.clock.seekPending) {
          this.heldRelease = msg;
          return;
        }
        this.heldRelease = null;
        const active = this.active();
        const at = msg.atBeat === "bar" ? this.clock.nextBar() : msg.atBeat;
        if (this.pendingStart) {
          if (at === null) this.pendingStart = null;
          else this.pendingStart.release = at;
        }
        if (!active) return;
        active.release(at, this.clock.beat, this.clock.q.framesPerBeat, this.clock.q.playing);
        break;
      }
    }
  }

  /** Back to dry at once: every voice idle (after a fault). */
  reset(): void {
    for (const v of this.voices) v.idle();
    this.pendingStart = null;
    this.heldRelease = null;
    this.clipRamp.set(0);
    this.dc.reset();
  }

  private active(): Voice | undefined {
    for (let i = 0; i < SLOTS; i++) if (this.voices[i].state === ACTIVE) return this.voices[i];
    return undefined;
  }

  private startVoice(lagFrames: number, fade: number, isSwitch: boolean): void {
    if (!this.preset) return;
    if (isSwitch) this.active()?.retire();
    // A third voice fades the oldest ringing one out over 20 ms in its own slot.
    const ringing = this.voices.filter(v => v.sounding);
    if (ringing.length >= 2) {
      const oldest = ringing.filter(v => v.state === RELEASED).sort((x, y) => x.order - y.order)[0];
      oldest?.fadeOut();
    }
    this.pendingStart = { lag: lagFrames, fade, engage: !isSwitch, release: null };
    this.tryStart();
  }

  private tryStart(): void {
    const s = this.pendingStart;
    if (!s || !this.preset) return;
    let slot: Voice | undefined;
    for (let i = 0; i < SLOTS && !slot; i++) if (this.voices[i].state === IDLE) slot = this.voices[i];
    if (!slot) return;
    this.pendingStart = null;
    // B counts from here on an untrusted grid (a switch keeps the running count).
    if (s.engage) this.clock.markEngage();
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
    slot.start(this.preset, this.beatsIndex, s.fade, this.clock.beat, s.lag, this.clock.q, ++this.order, this.seed);
    if (s.release !== null) slot.release(s.release, this.clock.beat, this.clock.q.framesPerBeat, this.clock.q.playing);
  }

  /** Renders one quantum (any length; it runs in chunks of 128). */
  process(input: readonly Float32Array[], output: Float32Array[], params: FxRackParamValues, currentFrame: number): void {
    const outL = output[0];
    if (!outL) return;
    const outR = output[1] ?? outL;
    const total = outL.length;
    if (!this.started) {
      this.started = true;
      this.post({ t: "ready" });
    }
    const amount = clamp(params.amount?.[0] ?? 0, 0, 1);
    const fader = clamp(params.fader?.[0] ?? 1, 0, 1);
    for (let off = 0; off < total; off += CHUNK) {
      const n = Math.min(CHUNK, total - off);
      this.chunk(input, outL, outR, off, n, amount, fader, currentFrame + off);
    }
    const engaged = this.engaged, tail = this.tail;
    if (engaged !== this.lastEngaged || tail !== this.lastTail) {
      this.lastEngaged = engaged;
      this.lastTail = tail;
      this.post({ t: "state", engaged, tail });
    }
  }

  private chunk(
    input: readonly Float32Array[], outL: Float32Array, outR: Float32Array, off: number, n: number, amount: number,
    fader: number, frame: number,
  ): void {
    const inL = this.inL, inR = this.inR;
    const srcL = input[0], srcR = input[1] ?? srcL;
    if (srcL) {
      for (let i = 0; i < n; i++) {
        const l = srcL[off + i], r = srcR[off + i];
        // x − x is 0 only for finite x.
        inL[i] = l - l === 0 ? l : 0;
        inR[i] = r - r === 0 ? r : 0;
      }
    } else {
      inL.fill(0, 0, n);
      inR.fill(0, 0, n);
    }
    const q = this.clock.advance(frame, n);
    if (this.clock.takeSeek()) this.ring.reset();
    if (this.heldRelease && !this.clock.seekPending) this.message(this.heldRelease);
    this.ring.write(inL, inR, fader < 1e-3 ? 0 : 1 / fader, n);
    this.amount = smoothed(this.amount, amount, n, 0.01 * this.fs);
    this.tryStart();
    const busy = this.busy;
    if (!busy && this.clipRamp.v === 0 && !this.clipRamp.moving) {
      // Bypass: bit-exact copy.
      for (let i = 0; i < n; i++) {
        outL[off + i] = inL[i];
        if (outR !== outL) outR[off + i] = inR[i];
      }
      this.prePeak = 0;
      this.clipped = 0;
      this.dc.reset();
      return;
    }
    const run = q.playing ? 1 : 0, clip = busy ? 1 : 0;
    if (this.runRamp.goal !== run) this.runRamp.to(run, 0.005 * this.fs);
    this.runRamp.fill(this.run, n);
    if (this.clipRamp.goal !== clip) this.clipRamp.to(clip, 0.005 * this.fs);
    this.clipRamp.fill(this.clip, n);
    this.insL.fill(0, 0, n);
    this.insR.fill(0, 0, n);
    this.wetL.fill(0, 0, n);
    this.wetR.fill(0, 0, n);
    this.dry.fill(1, 0, n);
    for (let j = 0; j < SLOTS; j++) {
      const v = this.voices[j];
      if (v.state === IDLE) continue;
      v.process(this, n, q, this.amount, fader, inL, inR, this.run, this.insL, this.insR, this.wetL, this.wetR, this.dry);
    }
    this.dc.process(this.wetL, this.wetR, n);
    let pre = 0, clipped = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      let yl = this.dry[i] * inL[i] + this.insL[i] + this.wetL[i];
      let yr = this.dry[i] * inR[i] + this.insR[i] + this.wetR[i];
      const al = Math.abs(yl), ar = Math.abs(yr);
      if (al > pre) pre = al;
      if (ar > pre) pre = ar;
      const c = this.clip[i];
      if (c > 0) {
        if (al > 0.9 || ar > 0.9) clipped++;
        yl += c * (softClip(yl) - yl);
        yr += c * (softClip(yr) - yr);
      }
      sum += Math.abs(yl) + Math.abs(yr);
      outL[off + i] = yl;
      if (outR !== outL) outR[off + i] = yr;
    }
    this.prePeak = pre;
    this.clipped = clipped;
    // NaN never raises `pre` (NaN > pre is false), so the sum catches it; `pre` catches a finite runaway.
    if (!(sum < 1e12) || pre > FAULT_PEAK) {
      // A non-finite sample or a runaway (pre-clip peak far above any preset): back to dry and report.
      this.reset();
      for (let i = 0; i < n; i++) {
        outL[off + i] = inL[i];
        if (outR !== outL) outR[off + i] = inR[i];
      }
      this.post({ t: "fault" });
    }
  }
}
