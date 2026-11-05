// Shared Web Audio / worklet fakes for the StretchDeck tests (not a test file itself).
import { StretchDeck, resetEngineUnavailable } from "../src/lib/audio/stretchDeck";

export const flush = () => new Promise(resolve => setTimeout(resolve, 0));
export const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

export class Param {
  value = 1;
  calls: unknown[][] = [];
  constructor(value = 1) { this.value = value; }
  cancelScheduledValues(t: number) { this.calls.push(["cancel", t]); }
  cancelAndHoldAtTime(t: number) { this.calls.push(["hold", t]); }
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["ramp", v, t]); }
  setTargetAtTime(v: number, t: number, c: number) { this.calls.push(["target", v, t, c]); }
  setValueCurveAtTime(curve: Float32Array, t: number, d: number) { this.calls.push(["curve", curve, t, d]); }
}
export class Gain {
  gain = new Param();
  connected: unknown[] = [];
  connect(node: unknown) { this.connected.push(node); return node; }
  disconnects = 0;
  disconnect() { this.disconnects++; }
}
export class Biquad extends Gain {
  type = "";
  frequency = new Param(350);
  Q = new Param(1);
  override gain = new Param(0);
}
export const decoded = (duration = 100, sampleRate = 48000) => ({
  duration, sampleRate, numberOfChannels: 2, length: 4,
  getChannelData: () => new Float32Array(4), copyFromChannel: () => {},
});
export class Ctx {
  state = "running";
  currentTime = 10;
  sampleRate = 48000;
  gains: Gain[] = [];
  filters: Biquad[] = [];
  listeners = new Set<() => void>();
  hold = false;
  resumable = true;
  held: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  buffer = () => decoded();
  createGain() { const g = new Gain(); this.gains.push(g); return g; }
  createBiquadFilter() { const f = new Biquad(); this.filters.push(f); return f; }
  addEventListener(_: string, l: () => void) { this.listeners.add(l); }
  removeEventListener(_: string, l: () => void) { this.listeners.delete(l); }
  async resume() { if (this.resumable) this.run(); }
  run() { this.state = "running"; this.listeners.forEach(l => l()); }
  decodeAudioData() {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    return new Promise<any>((resolve, reject) => {
      const done = () => { this.inFlight--; resolve(this.buffer()); };
      if (this.hold) this.held.push({ resolve: done, reject: e => { this.inFlight--; reject(e); } });
      else done();
    });
  }
}
export class Node extends Gain {
  inputTime = 0;
  scheduled: any[] = [];
  adds: { channels: Float32Array[]; transfer?: unknown[] }[] = [];
  drops = 0;
  hold = false;
  held: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  failTransfer = 0;
  port = { closed: false, close() { this.closed = true; } };
  // The wrapper merges every event into the previous segment, so omitted fields (loopStart/loopEnd) are inherited.
  segment: Record<string, unknown> = { active: false, input: 0, loopStart: 0, loopEnd: 0 };
  schedule(e: unknown) { this.scheduled.push(e); this.segment = { ...this.segment, ...(e as object) }; }
  latency() { return Promise.resolve(0.12); }
  dropBuffers() { this.drops++; return Promise.resolve(); }
  addBuffers(channels: Float32Array[], transfer?: unknown[]) {
    this.adds.push({ channels, transfer });
    if (this.failTransfer > 0) { this.failTransfer--; return Promise.reject(new Error("DataCloneError")); }
    if (this.hold) return new Promise<number>((resolve, reject) => this.held.push({ resolve: () => resolve(1), reject }));
    return Promise.resolve(1);
  }
  last() { return this.scheduled[this.scheduled.length - 1]; }
}

const okFetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
const originalFetch = globalThis.fetch;
export const decks: StretchDeck[] = [];
export const contexts: Ctx[] = [];

// Writable: bun shares globalThis across test files in one run, and later files assign or delete `location`.
export const installLocation = () =>
  Object.defineProperty(globalThis, "location", { value: { href: "http://app.test/play" }, configurable: true, writable: true });

/** afterEach: dispose the decks, release hung decodes (they would hold the module-wide decode slots), restore fetch. */
export async function teardown() {
  decks.splice(0).forEach(d => d.dispose());
  for (const ctx of contexts.splice(0)) { ctx.hold = false; while (ctx.held.length) ctx.held.shift()!.resolve(); }
  await settle();
  globalThis.fetch = originalFetch;
  resetEngineUnavailable();
}

export function setup(options: { node?: Node; makeNode?: () => Promise<any>; ctx?: Ctx } = {}) {
  globalThis.fetch = okFetch;
  const ctx = options.ctx ?? new Ctx();
  if (!contexts.includes(ctx)) contexts.push(ctx);
  const node = options.node ?? new Node();
  const deck = new StretchDeck(ctx as any, (options.makeNode ?? (async () => node)) as any);
  decks.push(deck);
  const log: string[] = [];
  for (const type of ["play", "waiting", "playing", "pause", "ended", "seeking", "seeked", "loadedmetadata", "canplay", "error", "timeupdate"])
    deck.addEventListener(type, () => log.push(type));
  const load = async (src = "/api/tracks/1/audio") => { deck.src = src; deck.load(); await settle(); };
  return { ctx, node, deck, log, load };
}
