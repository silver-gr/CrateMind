// Node-side beat clock (§1 Clock): turns the host's clock messages into B for each render quantum, read where the audio
// is. Pure maths, no DOM or worklet globals.
import type { FxClockMsg, QuantumClock } from "./types";

/** Residuals under this many beats slew over SLEW_SECONDS; larger ones jump and re-phase (§1 Continuity). */
export const SLEW_BEATS = 0.05;
const SLEW_SECONDS = 0.02;

/**
 * B for the node. Raw beats come from the knots (piecewise linear, the last slope extrapolates), or, for an element deck
 * (`knots: null`) or while paused, from a linear model that continues the current B. B = raw − origin + offset: origin
 * is set at engage on an untrusted grid (B = 0 there), offset is a decaying residual that hides a small re-phase.
 */
export class NodeClock {
  /** The clock of the last `advance()`, reused (no allocation per quantum). */
  readonly q: QuantumClock = { beat: 0, beatsPerFrame: 0, framesPerBeat: 0, playing: true, jumped: false };
  private readonly fs: number;
  private msg: FxClockMsg | null = null;
  private pending: FxClockMsg | null = null;
  /** Linear model (element deck, paused, or no clock yet): raw = linBeat + (f − linFrame)·linSlope. */
  private linFrame = 0;
  private linBeat = 0;
  private linSlope = 0;
  private origin = 0;
  private offset = 0;
  private offsetStep = 0;
  /** Next frame to render, and the last non-zero frames per beat (kept while paused). */
  private frame = 0;
  private lastFpb = 0;
  private seeked = false;
  private rawSlope = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
  }

  /** Queues a clock; it applies from the first quantum that starts at or after `validFrom`. */
  set(msg: FxClockMsg): void {
    const seek = msg.seek || (this.pending?.seek ?? false);
    this.pending = seek === msg.seek ? msg : { ...msg, seek };
  }

  get trusted(): boolean {
    return this.msg?.trusted ?? false;
  }

  get rate(): number {
    return this.msg?.rate ?? 1;
  }

  /** B at the next frame to render. */
  get beat(): number {
    return this.rawAt(this.frame) - this.origin + this.offset;
  }

  /** True while a seek clock waits for its `validFrom`: B still runs on the pre-seek clock. */
  get seekPending(): boolean {
    return this.pending?.seek ?? false;
  }

  /** True once after a seek clock has applied (the core then resets the capture ring). */
  takeSeek(): boolean {
    const s = this.seeked;
    this.seeked = false;
    return s;
  }

  /** On an untrusted grid, B counts from the engage frame: B = 0 now. */
  markEngage(): void {
    if (this.trusted) return;
    this.origin = this.rawAt(this.frame) + this.offset;
  }

  /** The next bar line after now: the next multiple of 4 of B (`"bar"` releases). */
  nextBar(): number {
    return (Math.floor(this.beat / 4 + 1e-9) + 1) * 4;
  }

  /** Clock for frames [frame0, frame0 + n). */
  advance(frame0: number, n: number): QuantumClock {
    const q = this.q;
    q.jumped = false;
    if (frame0 !== this.frame) this.decay(frame0 - this.frame);
    this.frame = frame0;
    const p = this.pending;
    if (p && frame0 >= p.validFrom) {
      this.pending = null;
      this.apply(p, frame0);
    }
    const raw = this.rawAt(frame0);
    const slope = this.rawSlope;
    q.playing = this.msg?.playing ?? true;
    q.beat = raw - this.origin + this.offset;
    q.beatsPerFrame = slope + this.offsetStep;
    const ref = slope > 0 ? slope : this.bpmSlope(this.msg);
    if (ref > 0) this.lastFpb = 1 / ref;
    else if (!this.msg?.knots) this.lastFpb = 0;
    q.framesPerBeat = this.lastFpb;
    this.decay(n);
    this.frame = frame0 + n;
    return q;
  }

  private decay(frames: number): void {
    if (this.offsetStep === 0) return;
    const next = this.offset + this.offsetStep * frames;
    if (Math.sign(next) !== Math.sign(this.offset) || next === 0) {
      this.offset = 0;
      this.offsetStep = 0;
    } else this.offset = next;
  }

  private apply(p: FxClockMsg, frame: number): void {
    const before = this.rawAt(frame) - this.origin + this.offset;
    this.msg = p;
    if (p.trusted) this.origin = 0;
    if (!p.playing || p.knots === null) {
      // Continue the current B linearly: frozen while paused, at bpm × rate on an element deck.
      this.linFrame = frame;
      this.linBeat = before + this.origin - this.offset;
      this.linSlope = p.playing ? this.bpmSlope(p) : 0;
      if (p.seek) this.jump();
      return;
    }
    const residual = this.rawAt(frame) - this.origin - before;
    if (p.seek || Math.abs(residual) >= SLEW_BEATS) {
      this.jump();
      this.seeked = p.seek;
    } else {
      this.offset = -residual;
      this.offsetStep = residual / (SLEW_SECONDS * this.fs);
    }
  }

  private jump(): void {
    this.offset = 0;
    this.offsetStep = 0;
    this.q.jumped = true;
    this.seeked = true;
  }

  private bpmSlope(m: FxClockMsg | null): number {
    return m && m.bpm !== null && m.bpm > 0 ? (m.bpm * m.rate) / (60 * this.fs) : 0;
  }

  /** Raw beat at frame f; sets `rawSlope`. */
  private rawAt(f: number): number {
    const m = this.msg;
    const k = m?.knots;
    if (!m || !m.playing || !k || k.length < 2) {
      this.rawSlope = this.linSlope;
      return this.linBeat + (f - this.linFrame) * this.linSlope;
    }
    const count = k.length >> 1;
    if (count === 1) {
      this.rawSlope = this.bpmSlope(m);
      return k[1] + (f - k[0]) * this.rawSlope;
    }
    let j = 0;
    while (j < count - 2 && k[2 * j + 2] <= f) j++;
    const df = k[2 * j + 2] - k[2 * j];
    this.rawSlope = df > 0 ? (k[2 * j + 3] - k[2 * j + 1]) / df : 0;
    return k[2 * j + 1] + (f - k[2 * j]) * this.rawSlope;
  }
}
