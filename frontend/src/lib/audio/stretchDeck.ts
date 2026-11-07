import type { StretchNode } from "./vendor/SignalsmithStretch.mjs";
import type { MediaLike } from "../media";
import { FILTER_Q_DB, eqDb, filterParams } from "../mixer";

/** Where the track's playhead was at ctx time `output`; `input` is the position then. Pending while output > now. */
export type Anchor = { input: number; output: number; rate: number; active: boolean };

export const MAX_DECODED_BYTES = 400 * 1024 * 1024;
const MAX_DECODES = 2;
const LEAD_MARGIN = 0.04;
const DEFAULT_LEAD = 0.16;
const FADE_S = 0.01;
const STOP_AFTER_S = 0.015;
/** Glide back to neutral (same time constant as the mixer's tone ramps); filters then snap exactly to bypass. */
const NEUTRAL_TC = 0.015;
const SNAP_S = 0.1;
/** Filter knob curves are resampled before the exponential Hz mapping, so linear interpolation between points stays close. */
const MIN_FILTER_POINTS = 64;

/** One transition's automation for a deck: value curves over [at, at + duration] in ctx time. eq/filter are knob curves (-1..1). */
export interface DeckAutomation {
  at: number;
  duration: number;
  volume?: Float32Array;
  eq?: Partial<Record<"lo" | "mid" | "hi", Float32Array>>;
  filter?: Float32Array;
}
type Stage = { gain: GainNode; lo: BiquadFilterNode; mid: BiquadFilterNode; hi: BiquadFilterNode; hp: BiquadFilterNode; lp: BiquadFilterNode };

/** Linear resample of a curve (length >= 2) to n points; the end points are kept exactly. */
const resample = (curve: Float32Array, n: number) => Float32Array.from({ length: n }, (_, i) => {
  const x = (i / (n - 1)) * (curve.length - 1);
  const j = Math.min(Math.floor(x), curve.length - 2);
  return curve[j] + (curve[j + 1] - curve[j]) * (x - j);
});

/** A loop in track seconds; the worklet wraps playback from `end` back to `start`. */
export type EngineLoop = { start: number; end: number };
/** Shortest loop the engine accepts (s). */
export const MIN_LOOP_S = 0.02;

/** Where the playhead is at ctx time `now`. Inside an active loop the position wraps from `end` back to `start`. */
export const positionAt = (a: Anchor, now: number, duration: number, loop?: EngineLoop | null): number => {
  let raw = a.input + Math.max(0, now - a.output) * a.rate * (a.active ? 1 : 0);
  if (loop && loop.end > loop.start && raw >= loop.end) raw = loop.start + ((raw - loop.start) % (loop.end - loop.start));
  return Math.min(Math.max(raw, 0), duration);
};
export const stretchParams = (rate: number, keylock: boolean) => ({ rate, semitones: keylock ? 0 : 12 * Math.log2(rate) });
export const fitsBudget = (duration: number | null | undefined, sampleRate: number, channels = 2) =>
  duration == null || duration * sampleRate * channels * 4 <= MAX_DECODED_BYTES;
/** Per-load choice; a null duration is checked again after decode. */
export const chooseEngine = (o: { twoDeck: boolean; unavailable: boolean; duration?: number | null; sampleRate: number }) =>
  o.twoDeck && !o.unavailable && fitsBudget(o.duration, o.sampleRate);

// Set only on a real worklet failure (addModule rejection or processorerror), never on a timeout or suspended context.
let engineUnavailable = false;
export const isEngineUnavailable = () => engineUnavailable;
export const resetEngineUnavailable = () => { engineUnavailable = false; };

const engines = new Set<StretchDeck>();
/** Unload every engine deck (library switch); the elements are stopped separately. */
export const stopEngines = () => engines.forEach(engine => engine.unload());

/** A non-2xx response: a missing/unavailable file, not an engine failure. */
export class HttpError extends Error {}

// One engine per deck for the app's lifetime: the vendored processor never goes idle, so a node that was
// created is never freed. Mounts reuse it and only unload().
const decks = new Map<string, StretchDeck>();
export function stretchDeckFor(deck: string, ctx: AudioContext, makeNode?: (ctx: BaseAudioContext) => Promise<StretchNode>): StretchDeck {
  let engine = decks.get(deck);
  if (!engine) decks.set(deck, engine = new StretchDeck(ctx, makeNode));
  return engine;
}

// At most two decodes in flight across all decks.
let decoding = 0;
const waiting: (() => void)[] = [];
const acquire = () => decoding < MAX_DECODES ? (decoding++, Promise.resolve()) : new Promise<void>(resolve => waiting.push(resolve));
const release = () => { const next = waiting.shift(); if (next) next(); else decoding--; };

async function createStretchNode(ctx: BaseAudioContext): Promise<StretchNode> {
  // Main-thread module (not bundled into the app chunk unless needed) plus the worklet module as a static same-origin URL.
  const [{ default: create }, { default: url }] = await Promise.all([
    import("./vendor/SignalsmithStretch.mjs"), import("./vendor/SignalsmithStretch.mjs?url"),
  ]);
  create.moduleUrl = new URL(url, location.href).href;
  return create(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const defer = (): Deferred => {
  const d = {} as Deferred;
  d.promise = new Promise<void>((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
};

/** Plays a decoded copy of a track through Signalsmith Stretch, behind the same facade as an <audio> element. */
export class StretchDeck extends EventTarget implements MediaLike {
  readonly output: GainNode;
  private fade: GainNode;
  /** Transition automation, after the fade and before the mixer graph; neutral unless a transition drives it. */
  private auto: Stage;
  private node?: StretchNode;
  private nodeP?: Promise<StretchNode>;
  private lead = DEFAULT_LEAD;
  private loadId = 0;
  private busy = false;
  private queued: number | null = null;
  private ctrl: AbortController | null = null;
  private pending: Deferred | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private anchor: Anchor = { input: 0, output: 0, rate: 1, active: false };
  private _src = "";
  private _currentSrc = "";
  private _duration = NaN;
  private _readyState = 0;
  private _paused = true;
  private _ended = false;
  private _seeking = false;
  private _error: unknown = null;
  private _rate = 1;
  private disposed = false;
  private _keylock = true;
  private loop_: EngineLoop | null = null;
  private _volume = 1;
  private _muted = false;
  defaultPlaybackRate = 1;
  private onState = () => { if (this.ctx.state === "running") this.tryStart(); };

  constructor(private ctx: AudioContext, private makeNode: (ctx: BaseAudioContext) => Promise<StretchNode> = createStretchNode) {
    super();
    // Stable from construction so the playback graph can attach before the worklet exists.
    this.output = ctx.createGain();
    this.fade = ctx.createGain();
    const filter = (type: BiquadFilterType, frequency: number, q?: number) => {
      const node = ctx.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      if (q !== undefined) node.Q.value = q;
      return node;
    };
    const a = this.auto = {
      gain: ctx.createGain(),
      lo: filter("lowshelf", 250), mid: filter("peaking", 1000, 0.7), hi: filter("highshelf", 4000),
      hp: filter("highpass", 0, FILTER_Q_DB), lp: filter("lowpass", ctx.sampleRate / 2, FILTER_Q_DB),
    };
    this.fade.connect(a.gain).connect(a.lo).connect(a.mid).connect(a.hi).connect(a.hp).connect(a.lp).connect(this.output);
    ctx.addEventListener("statechange", this.onState);
    engines.add(this);
  }

  private fire(type: string) { this.dispatchEvent(new Event(type)); }
  private get loaded() { return this._readyState >= 4; }
  private get duration_() { return Number.isFinite(this._duration) ? this._duration : 0; }

  get src() { return this._src ? new URL(this._src, globalThis.location?.href).href : ""; }
  set src(value: string) { this._src = value; }
  get currentSrc() { return this._currentSrc; }
  get duration() { return this._duration; }
  get readyState() { return this._readyState; }
  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get seeking() { return this._seeking; }
  get error() { return this._error; }
  get volume() { return this._volume; }
  set volume(value: number) { this._volume = value; this.applyVolume(); }
  get muted() { return this._muted; }
  set muted(value: boolean) { this._muted = value; this.applyVolume(); }
  private applyVolume() { this.output.gain.value = this._muted ? 0 : this._volume; }

  get playbackRate() { return this._rate; }
  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value - this._rate) < 1e-6) return;
    this._rate = value;
    this.reschedule();
  }
  get preservesPitch() { return this._keylock; }
  set preservesPitch(value: boolean) {
    if (value === this._keylock) return;
    this._keylock = value;
    this.reschedule();
  }

  /** The active loop, or null. */
  get loop(): EngineLoop | null { return this.loop_; }
  /** The wrapper inherits omitted schedule fields, so every schedule states the loop explicitly (0, 0 = no loop). */
  private loopFields() { return { loopStart: this.loop_?.start ?? 0, loopEnd: this.loop_?.end ?? 0 }; }

  get currentTime() { return this.loaded ? positionAt(this.anchor, this.ctx.currentTime, this.duration_, this.loop_) : 0; }
  set currentTime(seconds: number) {
    const node = this.node;
    if (!node || !this.loaded || !Number.isFinite(seconds)) return;
    const input = Math.min(Math.max(seconds, 0), this.duration_);
    const now = this.ctx.currentTime;
    const id = this.loadId;
    this._ended = false;
    this._seeking = true;
    // A seek outside the loop ends it; one inside keeps looping.
    const outside = this.loop_ !== null && (input < this.loop_.start || input >= this.loop_.end);
    if (outside) this.loop_ = null;
    if (this.anchor.active) {
      const output = now + this.lead;
      this.anchor = { input, output, rate: this._rate, active: true };
      node.schedule({ active: true, input, outputTime: output, ...stretchParams(this._rate, this._keylock), ...this.loopFields() });
    } else {
      this.anchor = { ...this.anchor, input, output: now };
      if (outside) node.schedule({ active: false, input, outputTime: now, loopStart: 0, loopEnd: 0 });
    }
    setTimeout(() => {
      if (id !== this.loadId) return;
      this.fire("seeking");
      setTimeout(() => {
        if (id !== this.loadId) return;
        this._seeking = false;
        this.fire("seeked");
        this.fire("timeupdate");
      }, 0);
    }, 0);
  }

  /** Re-issue the tempo/pitch for a running deck. Inside LEAD the pending event is replaced at its own times. */
  private reschedule() {
    const node = this.node;
    const a = this.anchor;
    if (!node || !this.loaded || !a.active) return;
    const now = this.ctx.currentTime;
    const params = { ...stretchParams(this._rate, this._keylock), ...this.loopFields() };
    if (a.output > now) {
      this.anchor = { ...a, rate: this._rate };
      node.schedule({ active: true, input: a.input, outputTime: a.output, ...params });
    } else {
      // The new anchor is rebased inside the loop, so a rate change never schedules a position past its end.
      const input = positionAt(a, now, this.duration_, this.loop_);
      this.anchor = { input, output: now, rate: this._rate, active: true };
      node.schedule({ active: true, input, outputTime: now, ...params });
    }
  }

  /** Moves a running anchor up to now (inside the current loop) so the loop can change without moving the playhead. */
  private rebase() {
    const a = this.anchor;
    const now = this.ctx.currentTime;
    if (!a.active || a.output > now) return;
    this.anchor = { input: positionAt(a, now, this.duration_, this.loop_), output: now, rate: a.rate, active: true };
  }

  /** Loops [start, end) in track seconds from the current playhead; false if the engine can't (no track, too short). */
  setLoop(start: number, end: number): boolean {
    if (!this.node || !this.loaded || !Number.isFinite(start) || !Number.isFinite(end)) return false;
    const from = Math.max(0, start);
    const to = Math.min(this.duration_, end);
    if (to - from < MIN_LOOP_S) return false;
    this.rebase();
    this.loop_ = { start: from, end: to };
    if (this.anchor.active) this.reschedule();
    return true;
  }

  /** Ends the loop without moving the playhead: rebase inside the loop first, then send an explicit disabled loop. */
  clearLoop() {
    if (!this.loop_) return;
    this.rebase();
    this.loop_ = null;
    const node = this.node;
    if (!node) return;
    if (this.anchor.active) this.reschedule();
    else node.schedule({ active: false, input: this.anchor.input, outputTime: this.ctx.currentTime, loopStart: 0, loopEnd: 0 });
  }

  load() {
    const id = ++this.loadId;
    this.ctrl?.abort();
    this.ctrl = null;
    this.queued = null;
    this.abortPending();
    this.halt();
    this.dropLoop();
    this._paused = true;
    this._ended = false;
    this._seeking = false;
    this._error = null;
    this._duration = NaN;
    this._readyState = 0;
    this.anchor = { input: 0, output: 0, rate: this._rate, active: false };
    this._currentSrc = this.src;
    void this.node?.dropBuffers();
    if (!this._src) return;
    this.fire("waiting");
    // Never two decodes on one deck: the newest request waits for the one in flight and supersedes older queued ones.
    if (this.busy) this.queued = id;
    else void this.run(id);
  }

  unload() {
    this.pause();
    this._src = "";
    this.load();
  }

  private async run(id: number) {
    this.busy = true;
    try {
      await acquire();
      try { if (id === this.loadId) await this.decode(id); } finally { release(); }
    } catch (error) {
      // A superseded load that fails is a cancellation, never a failure.
      if (id === this.loadId) this.fail(error);
    } finally {
      this.busy = false;
      const next = this.queued;
      this.queued = null;
      if (next !== null && next === this.loadId) void this.run(next);
    }
  }

  private async decode(id: number) {
    const ctrl = this.ctrl = new AbortController();
    const response = await fetch(this._currentSrc, { signal: ctrl.signal });
    if (id !== this.loadId) return;
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (id !== this.loadId) return;
    const decoded = await this.ctx.decodeAudioData(bytes);
    if (id !== this.loadId) return;
    if (!fitsBudget(decoded.duration, decoded.sampleRate, decoded.numberOfChannels)) throw new Error("Track too large for the deck engine");
    const node = await this.ensureNode();
    if (id !== this.loadId) return;
    // One call per load (multi-chunk adds are broken in 1.3.2). Transfer detaches the AudioBuffer's channels.
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    try {
      await node.addBuffers(channels, channels.map(channel => channel.buffer));
    } catch {
      if (id !== this.loadId) return;
      const copies = channels.map((_, c) => { const copy = new Float32Array(decoded.length); decoded.copyFromChannel(copy, c); return copy; });
      await node.addBuffers(copies, copies.map(copy => copy.buffer));
    }
    if (id !== this.loadId) { void node.dropBuffers(); return; }
    this._duration = decoded.duration;
    this._readyState = 4;
    this.fire("loadedmetadata");
    this.fire("canplay");
    this.tryStart();
  }

  private ensureNode(): Promise<StretchNode> {
    // Factory failure marks the engine unavailable; a failure afterwards (e.g. latency()) is just this load's error.
    return this.nodeP ??= this.makeNode(this.ctx).then(node => this.adopt(node).catch(error => {
      this.nodeP = undefined;
      throw error;
    }), error => { engineUnavailable = true; this.nodeP = undefined; throw error; });
  }

  private async adopt(node: StretchNode): Promise<StretchNode> {
    const drop = () => { node.disconnect(); node.port.close(); };
    if (this.disposed) { drop(); throw new DOMException("The deck was disposed.", "AbortError"); }
    node.connect(this.fade);
    node.onprocessorerror = () => { engineUnavailable = true; this.fail(new Error("Stretch processor error")); };
    let latency: number;
    try { latency = await node.latency(); } catch (error) { drop(); throw error; }
    if (this.disposed) { drop(); throw new DOMException("The deck was disposed.", "AbortError"); }
    this.lead = latency + LEAD_MARGIN;
    this.node = node;
    return node;
  }

  private fail(error: unknown) {
    this._error = error;
    this.abortPending();
    // Listeners see the user's current play intent in `paused`; only then does the deck stop.
    this.fire("error");
    this._paused = true;
    this.halt();
  }

  private abortPending() {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new DOMException("The play() request was interrupted.", "AbortError"));
  }

  play(): Promise<void> {
    if (!this._paused) return this.pending?.promise ?? Promise.resolve();
    this._paused = false;
    if (this._ended) { this._ended = false; this.anchor = { ...this.anchor, input: 0, active: false }; }
    const pending = this.pending = defer();
    this.fire("play");
    // A handler may have paused already (then the request is rejected).
    if (!this._paused && !this.tryStart()) this.fire("waiting");
    return pending.promise;
  }

  /** Starts once the track is decoded and the context runs; false means the intent stays pending. */
  private tryStart(): boolean {
    const node = this.node;
    if (this._paused || !this.pending || !node || !this.loaded) return false;
    if (this.ctx.state !== "running") { void this.ctx.resume()?.catch(() => {}); return false; }
    const now = this.ctx.currentTime;
    this.start(node, now, now + this.lead, this.anchor.input);
    return true;
  }

  /**
   * Starts a paused, decoded deck so that `input` sounds at ctx time `outputTime` (>= now + lead) at `rate`.
   * The worklet pre-rolls now; the fade holds silence until `outputTime`. Fires play/playing at once (armed = playing).
   * Null when not loaded, not paused, the context isn't running, the time is inside the lead, or an argument is bad.
   */
  playAt(outputTime: number, input: number, rate: number): number | null {
    const node = this.node;
    if (!node || !this.loaded || !this._paused || this.ctx.state !== "running") return null;
    if (!Number.isFinite(outputTime) || !Number.isFinite(input) || !Number.isFinite(rate) || rate <= 0) return null;
    const now = this.ctx.currentTime;
    if (outputTime < now + this.lead) return null;
    this._rate = rate;
    this._paused = false;
    this._ended = false;
    this.fire("play");
    // A handler may have paused already.
    if (this._paused) return null;
    this.start(node, now, outputTime, Math.min(Math.max(input, 0), this.duration_));
    return outputTime;
  }

  /** The ctx time a scheduled start begins sounding; null when stopped or already sounding. */
  get startsAt(): number | null {
    const a = this.anchor;
    return !this._paused && a.active && a.output > this.ctx.currentTime ? a.output : null;
  }

  /** The ctx time the playhead reaches `position` on the current anchor (past times included); null if stopped, past the end, or a loop wraps first. */
  timeOf(position: number): number | null {
    const a = this.anchor;
    if (this._paused || !a.active || !Number.isFinite(position) || position > this.duration_) return null;
    if (this.loop_ && position >= this.loop_.end) return null;
    return a.output + (position - a.input) / a.rate;
  }

  /** Anchors at `output`, mutes until then, resolves any pending play() and starts the ticker. */
  private start(node: StretchNode, now: number, output: number, input: number) {
    this.anchor = { input, output, rate: this._rate, active: true };
    node.schedule({ active: true, input, outputTime: output, ...stretchParams(this._rate, this._keylock), ...this.loopFields() });
    const gain = this.fade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setValueAtTime(0, output);
    gain.linearRampToValueAtTime(1, output + FADE_S);
    this.pending?.resolve();
    this.pending = null;
    this.ticker = setInterval(() => {
      this.fire("timeupdate");
      // A looping deck never reaches the end: positionAt wraps inside the loop.
      if (positionAt(this.anchor, this.ctx.currentTime, this.duration_, this.loop_) >= this.duration_) this.finish();
    }, 250);
    this.fire("playing");
  }

  /** Each stage param with its neutral value and whether it snaps there (the filters, so they end fully bypassed). */
  private autoParams(): [AudioParam, number, boolean][] {
    const a = this.auto;
    return [[a.gain.gain, 1, false], [a.lo.gain, 0, false], [a.mid.gain, 0, false], [a.hi.gain, 0, false],
      [a.hp.frequency, 0, true], [a.lp.frequency, this.ctx.sampleRate / 2, true]];
  }

  /**
   * Schedules a transition's curves on the stage (never the mixer's own EQ/filter/master). Eq knobs map through eqDb;
   * the filter knob is resampled and split into hp/lp frequency curves, a side that stays neutral is left alone.
   * False if there is no node, the window is bad, or a curve has fewer than two points.
   */
  scheduleAutomation(plan: DeckAutomation): boolean {
    const { at, duration, volume, eq, filter } = plan;
    const curves = [volume, eq?.lo, eq?.mid, eq?.hi, filter].filter(c => c !== undefined);
    if (!this.node || !Number.isFinite(at) || !Number.isFinite(duration) || duration <= 0 || curves.some(c => c.length < 2)) return false;
    const a = this.auto;
    const set = (param: AudioParam, values: Float32Array) => {
      param.cancelScheduledValues(at);
      param.setValueCurveAtTime(values, at, duration);
    };
    if (volume) set(a.gain.gain, volume);
    for (const band of ["lo", "mid", "hi"] as const) {
      const knob = eq?.[band];
      if (knob) set(a[band].gain, Float32Array.from(knob, v => eqDb(v)));
    }
    if (filter) {
      const sampleRate = this.ctx.sampleRate;
      const shape = Array.from(resample(filter, Math.max(MIN_FILTER_POINTS, filter.length)), v => filterParams(v, sampleRate));
      if (shape.some(f => f.hpHz !== 0)) set(a.hp.frequency, Float32Array.from(shape, f => f.hpHz));
      if (shape.some(f => f.lpHz !== sampleRate / 2)) set(a.lp.frequency, Float32Array.from(shape, f => f.lpHz));
    }
    return true;
  }

  /** neutral: hold at `at` (default now) and glide every stage param back to neutral; hold: freeze where they are. */
  cancelAutomation(mode: "neutral" | "hold", at?: number) {
    const t = at ?? this.ctx.currentTime;
    for (const [param, neutral, snap] of this.autoParams()) {
      param.cancelAndHoldAtTime(t);
      if (mode === "hold") continue;
      param.setTargetAtTime(neutral, t, NEUTRAL_TC);
      if (snap) param.setValueAtTime(neutral, t + SNAP_S);
    }
  }

  pause() {
    if (this._paused) return;
    this._paused = true;
    this.abortPending();
    this.halt();
    this.fire("pause");
  }

  private finish() {
    this._paused = true;
    this._ended = true;
    this.halt();
    this.fire("pause");
    this.fire("ended");
  }

  /** Hold the playhead and fade out; a no-op when nothing is playing. */
  private halt() {
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null; }
    const a = this.anchor;
    if (!a.active) return;
    const now = this.ctx.currentTime;
    const stopAt = now + STOP_AFTER_S;
    const input = positionAt(a, stopAt, this.duration_, this.loop_);
    this.anchor = { input, output: stopAt, rate: a.rate, active: false };
    const gain = this.fade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + FADE_S);
    this.node?.schedule({ active: false, input, outputTime: stopAt, ...this.loopFields() });
  }

  /** Teardown for load/unload: the anchor is already held (halt), so send an explicit disabled loop before the buffers go. */
  private dropLoop() {
    if (!this.loop_) return;
    this.loop_ = null;
    this.node?.schedule({ active: false, input: this.anchor.input, outputTime: Math.max(this.anchor.output, this.ctx.currentTime), loopStart: 0, loopEnd: 0 });
  }

  dispose() {
    this.disposed = true;
    this.unload();
    for (const [key, engine] of decks) if (engine === this) decks.delete(key);
    this.ctx.removeEventListener("statechange", this.onState);
    engines.delete(this);
    this.node?.disconnect();
    this.node?.port.close();
    this.fade.disconnect();
    const a = this.auto;
    for (const node of [a.gain, a.lo, a.mid, a.hi, a.hp, a.lp]) node.disconnect();
    this.output.disconnect();
  }
}
