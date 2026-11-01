import type { StretchNode } from "./vendor/SignalsmithStretch.mjs";
import type { MediaLike } from "../media";

/** Where the track's playhead was at ctx time `output`; `input` is the position then. Pending while output > now. */
export type Anchor = { input: number; output: number; rate: number; active: boolean };

export const MAX_DECODED_BYTES = 400 * 1024 * 1024;
const MAX_DECODES = 2;
const LEAD_MARGIN = 0.04;
const DEFAULT_LEAD = 0.16;
const FADE_S = 0.01;
const STOP_AFTER_S = 0.015;

export const positionAt = (a: Anchor, now: number, duration: number): number =>
  Math.min(Math.max(a.input + Math.max(0, now - a.output) * a.rate * (a.active ? 1 : 0), 0), duration);
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
  private _volume = 1;
  private _muted = false;
  defaultPlaybackRate = 1;
  private onState = () => { if (this.ctx.state === "running") this.tryStart(); };

  constructor(private ctx: AudioContext, private makeNode: (ctx: BaseAudioContext) => Promise<StretchNode> = createStretchNode) {
    super();
    // Stable from construction so the playback graph can attach before the worklet exists.
    this.output = ctx.createGain();
    this.fade = ctx.createGain();
    this.fade.connect(this.output);
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

  get currentTime() { return this.loaded ? positionAt(this.anchor, this.ctx.currentTime, this.duration_) : 0; }
  set currentTime(seconds: number) {
    const node = this.node;
    if (!node || !this.loaded || !Number.isFinite(seconds)) return;
    const input = Math.min(Math.max(seconds, 0), this.duration_);
    const now = this.ctx.currentTime;
    const id = this.loadId;
    this._ended = false;
    this._seeking = true;
    if (this.anchor.active) {
      const output = now + this.lead;
      this.anchor = { input, output, rate: this._rate, active: true };
      node.schedule({ active: true, input, outputTime: output, ...stretchParams(this._rate, this._keylock) });
    } else {
      this.anchor = { ...this.anchor, input, output: now };
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
    const params = stretchParams(this._rate, this._keylock);
    if (a.output > now) {
      this.anchor = { ...a, rate: this._rate };
      node.schedule({ active: true, input: a.input, outputTime: a.output, ...params });
    } else {
      const input = positionAt(a, now, this.duration_);
      this.anchor = { input, output: now, rate: this._rate, active: true };
      node.schedule({ active: true, input, outputTime: now, ...params });
    }
  }

  load() {
    const id = ++this.loadId;
    this.ctrl?.abort();
    this.ctrl = null;
    this.queued = null;
    this.abortPending();
    this.halt();
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
    const output = now + this.lead;
    const input = this.anchor.input;
    this.anchor = { input, output, rate: this._rate, active: true };
    node.schedule({ active: true, input, outputTime: output, ...stretchParams(this._rate, this._keylock) });
    const gain = this.fade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setValueAtTime(0, output);
    gain.linearRampToValueAtTime(1, output + FADE_S);
    this.pending.resolve();
    this.pending = null;
    this.ticker = setInterval(() => {
      this.fire("timeupdate");
      if (positionAt(this.anchor, this.ctx.currentTime, this.duration_) >= this.duration_) this.finish();
    }, 250);
    this.fire("playing");
    return true;
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
    const input = positionAt(a, stopAt, this.duration_);
    this.anchor = { input, output: stopAt, rate: a.rate, active: false };
    const gain = this.fade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + FADE_S);
    this.node?.schedule({ active: false, input, outputTime: stopAt });
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
    this.output.disconnect();
  }
}
