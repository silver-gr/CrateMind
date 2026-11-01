import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  HttpError, MAX_DECODED_BYTES, StretchDeck, stretchDeckFor, chooseEngine, fitsBudget, isEngineUnavailable, positionAt,
  resetEngineUnavailable, stopEngines, stretchParams,
} from "../src/lib/audio/stretchDeck";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

class Param {
  value = 1;
  calls: unknown[][] = [];
  cancelScheduledValues(t: number) { this.calls.push(["cancel", t]); }
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["ramp", v, t]); }
}
class Gain {
  gain = new Param();
  connected: unknown[] = [];
  connect(node: unknown) { this.connected.push(node); return node; }
  disconnect() {}
}
const decoded = (duration = 100, sampleRate = 48000) => ({
  duration, sampleRate, numberOfChannels: 2, length: 4,
  getChannelData: () => new Float32Array(4), copyFromChannel: () => {},
});
class Ctx {
  state = "running";
  currentTime = 10;
  sampleRate = 48000;
  gains: Gain[] = [];
  listeners = new Set<() => void>();
  hold = false;
  resumable = true;
  held: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  buffer = () => decoded();
  createGain() { const g = new Gain(); this.gains.push(g); return g; }
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
class Node extends Gain {
  inputTime = 0;
  scheduled: any[] = [];
  adds: { channels: Float32Array[]; transfer?: unknown[] }[] = [];
  drops = 0;
  hold = false;
  held: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  failTransfer = 0;
  port = { closed: false, close() { this.closed = true; } };
  schedule(e: unknown) { this.scheduled.push(e); }
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

const originalFetch = globalThis.fetch;
const decks: StretchDeck[] = [];
const contexts: Ctx[] = [];
beforeAll(() => {
  Object.defineProperty(globalThis, "location", { value: { href: "http://app.test/play" }, configurable: true });
});
afterEach(async () => {
  decks.splice(0).forEach(d => d.dispose());
  // Hung decodes would hold the module-wide decode slots for later tests.
  for (const ctx of contexts.splice(0)) { ctx.hold = false; while (ctx.held.length) ctx.held.shift()!.resolve(); }
  await settle();
  globalThis.fetch = originalFetch;
  resetEngineUnavailable();
});
globalThis.fetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;

function setup(options: { node?: Node; makeNode?: () => Promise<any>; ctx?: Ctx } = {}) {
  globalThis.fetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
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

test("positionAt holds before the anchor output, advances at rate, holds when inactive and clamps", () => {
  const a = { input: 5, output: 10, rate: 1, active: true };
  expect(positionAt(a, 9.9, 100)).toBe(5);
  expect(positionAt(a, 12, 100)).toBe(7);
  // Rate re-anchor: a new anchor at the earlier position continues from there.
  expect(positionAt({ input: 7, output: 12, rate: 1.1, active: true }, 14, 100)).toBeCloseTo(9.2);
  expect(positionAt({ ...a, active: false }, 50, 100)).toBe(5);
  expect(positionAt(a, 500, 100)).toBe(100);
  expect(positionAt({ input: -3, output: 0, rate: 1, active: false }, 1, 100)).toBe(0);
});

test("stretchParams gives vinyl semitones without key lock and none with it", () => {
  expect(stretchParams(1.5, true)).toEqual({ rate: 1.5, semitones: 0 });
  expect(stretchParams(2, false).semitones).toBeCloseTo(12);
  expect(stretchParams(0.5, false).semitones).toBeCloseTo(-12);
  expect(stretchParams(1, false).semitones).toBe(0);
});

test("byte budget depends on the context sample rate and chooseEngine honours every gate", () => {
  expect(fitsBudget(900, 44100)).toBe(true);
  expect(fitsBudget(900, 96000)).toBe(false);
  expect(900 * 96000 * 2 * 4).toBeGreaterThan(MAX_DECODED_BYTES);
  expect(fitsBudget(null, 96000)).toBe(true);
  const base = { twoDeck: true, unavailable: false, duration: 300, sampleRate: 48000 };
  expect(chooseEngine(base)).toBe(true);
  expect(chooseEngine({ ...base, twoDeck: false })).toBe(false);
  expect(chooseEngine({ ...base, unavailable: true })).toBe(false);
  expect(chooseEngine({ ...base, duration: 1200 })).toBe(false);
  expect(chooseEngine({ ...base, duration: null })).toBe(true);
});

test("event order: load waits, then canplay; play, playing, pause; ended fires once after pause", async () => {
  const { deck, ctx, log, load } = setup();
  await load();
  expect(log).toEqual(["waiting", "loadedmetadata", "canplay"]);
  expect([deck.readyState, deck.duration, deck.paused]).toEqual([4, 100, true]);
  log.length = 0;
  await deck.play();
  expect(log).toEqual(["play", "playing"]);
  expect(deck.paused).toBe(false);
  log.length = 0;
  ctx.currentTime = 1000;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(log.filter(e => e === "ended")).toEqual(["ended"]);
  expect(log.indexOf("pause")).toBeLessThan(log.indexOf("ended"));
  expect(deck.ended).toBe(true);
  await settle();
  expect(log.filter(e => e === "ended").length).toBe(1);
  // play() after ended restarts at 0.
  ctx.currentTime = 2000;
  log.length = 0;
  await deck.play();
  expect(deck.ended).toBe(false);
  expect(deck.currentTime).toBe(0);
});

test("seeking and seeked are asynchronous and the seek re-anchors", async () => {
  const { deck, log, load } = setup();
  await load();
  log.length = 0;
  deck.currentTime = 42;
  expect(deck.seeking).toBe(true);
  expect(log).toEqual([]);
  expect(deck.currentTime).toBe(42);
  await settle();
  expect(log.slice(0, 3)).toEqual(["seeking", "seeked", "timeupdate"]);
  expect(deck.seeking).toBe(false);
});

test("play() before decode stays pending, shows waiting, and starts when the track is ready", async () => {
  const ctx = new Ctx();
  ctx.hold = true;
  const { deck, node, log, load } = setup({ ctx });
  await load();
  let resolved = false;
  const playing = deck.play().then(() => { resolved = true; });
  await settle();
  expect(resolved).toBe(false);
  expect(log).toEqual(["waiting", "play", "waiting"]);
  ctx.held.shift()!.resolve();
  await playing;
  expect(log.slice(-3)).toEqual(["loadedmetadata", "canplay", "playing"]);
  expect(node.last()).toMatchObject({ active: true, input: 0, outputTime: 10.16 });
});

test("a play() on a suspended context starts after the resume; pause() before that cancels it with AbortError", async () => {
  const ctx = new Ctx();
  ctx.state = "suspended";
  ctx.resumable = false;
  const first = setup({ ctx });
  await first.load();
  const started = first.deck.play();
  await settle();
  expect(first.node.scheduled).toEqual([]);
  ctx.run();
  await started;
  expect(first.node.last()).toMatchObject({ active: true });

  const ctx2 = new Ctx();
  ctx2.state = "suspended";
  ctx2.resumable = false;
  const second = setup({ ctx: ctx2 });
  await second.load();
  const cancelled = second.deck.play();
  second.deck.pause();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  ctx2.run();
  expect(second.node.scheduled).toEqual([]);
  expect(second.deck.paused).toBe(true);
});

test("a new load or unload cancels a pending play with AbortError", async () => {
  const ctx = new Ctx();
  ctx.hold = true;
  const { deck, load } = setup({ ctx });
  await load();
  const pending = deck.play();
  deck.src = "/api/tracks/2/audio";
  deck.load();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const second = deck.play();
  deck.unload();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
});

test("a pending start keeps its anchor when rate or key lock changes inside LEAD", async () => {
  const { deck, node, ctx, load } = setup();
  await load();
  await deck.play();
  expect(node.last()).toEqual({ active: true, input: 0, outputTime: 10.16, rate: 1, semitones: 0 });
  deck.playbackRate = 1.05;
  expect(node.last()).toMatchObject({ active: true, input: 0, outputTime: 10.16, rate: 1.05, semitones: 0 });
  deck.preservesPitch = false;
  expect(node.last()).toMatchObject({ input: 0, outputTime: 10.16, rate: 1.05 });
  expect(node.last().semitones).toBeCloseTo(12 * Math.log2(1.05));
  expect(deck.currentTime).toBe(0);
  // After the start has played for 2 s the change is scheduled at the live position, right now.
  ctx.currentTime = 12.16;
  deck.playbackRate = 1.2;
  expect(node.last().input).toBeCloseTo(2.1);
  expect(node.last().outputTime).toBe(12.16);
  expect(deck.currentTime).toBeCloseTo(2.1);
});

test("rate changes below 1e-6 are ignored and rate/key lock survive load()", async () => {
  const { deck, node, load } = setup();
  await load();
  await deck.play();
  const count = node.scheduled.length;
  deck.playbackRate = 1 + 1e-9;
  deck.preservesPitch = true;
  expect(node.scheduled.length).toBe(count);
  deck.playbackRate = 1.07;
  deck.preservesPitch = false;
  await load("/api/tracks/2/audio");
  expect([deck.playbackRate, deck.preservesPitch]).toEqual([1.07, false]);
  await deck.play();
  expect(node.last()).toMatchObject({ rate: 1.07 });
  expect(node.last().semitones).toBeCloseTo(12 * Math.log2(1.07));
});

test("src and currentSrc are absolute like the element's", async () => {
  const { deck, load } = setup();
  deck.src = "/api/tracks/7/audio";
  expect(deck.src).toBe("http://app.test/api/tracks/7/audio");
  expect(deck.currentSrc).toBe("");
  await load("/api/tracks/7/audio");
  expect(deck.currentSrc).toBe("http://app.test/api/tracks/7/audio");
  deck.src = "";
  deck.load();
  expect([deck.src, deck.currentSrc, deck.readyState]).toEqual(["", "", 0]);
});

test("one addBuffers per load with a transfer list; copies are used only when transfer throws", async () => {
  const { node, load } = setup();
  await load();
  expect(node.adds.length).toBe(1);
  expect(node.adds[0].transfer).toHaveLength(2);
  node.failTransfer = 1;
  await load("/api/tracks/2/audio");
  expect(node.adds.length).toBe(3);
});

test("unload and dispose drop buffers; drops run before a new decode starts", async () => {
  const { deck, node, load } = setup();
  await load();
  const drops = node.drops;
  await load("/api/tracks/2/audio");
  expect(node.drops).toBe(drops + 1);
  deck.unload();
  expect(node.drops).toBe(drops + 2);
  deck.dispose();
  expect(node.drops).toBe(drops + 3);
  expect(node.port.closed).toBe(true);
});

test("a stale load drops its buffer and publishes nothing; a late rejection is a cancellation", async () => {
  const node = new Node();
  node.hold = true;
  const { deck, log, load } = setup({ node });
  await load("/api/tracks/1/audio");
  expect(node.adds.length).toBe(1);
  // Replace during the deferred addBuffers: the newer request waits as the successor.
  deck.src = "/api/tracks/2/audio";
  deck.load();
  await settle();
  expect(node.adds.length).toBe(1);
  const drops = node.drops;
  node.held.shift()!.resolve();
  await settle();
  expect(node.drops).toBe(drops + 1);
  expect(log.filter(e => e === "loadedmetadata")).toEqual([]);
  expect(node.adds.length).toBe(2);
  // Eject during the second add, then reject it late: no error, no metadata.
  deck.unload();
  node.held.shift()!.reject(new Error("late failure"));
  await settle();
  expect(log.filter(e => e === "error" || e === "loadedmetadata")).toEqual([]);
  expect(deck.error).toBe(null);
});

test("a current load failure raises error; HTTP errors too", async () => {
  const { deck, log, load } = setup();
  globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  await load();
  expect(log).toContain("error");
  expect(deck.error).toBeInstanceOf(Error);
  expect(deck.readyState).toBe(0);
});

test("only a worklet failure marks the engine unavailable; waiting or a suspended context never does", async () => {
  const ctx = new Ctx();
  ctx.state = "suspended";
  ctx.resumable = false;
  const slow = setup({ ctx });
  await slow.load();
  void slow.deck.play().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(isEngineUnavailable()).toBe(false);

  const broken = setup({ makeNode: async () => { throw new Error("addModule rejected"); } });
  await broken.load();
  expect(isEngineUnavailable()).toBe(true);
  expect(broken.log).toContain("error");
  resetEngineUnavailable();

  const crashing = setup();
  await crashing.load();
  (crashing.node as any).onprocessorerror();
  expect(isEngineUnavailable()).toBe(true);
  expect(crashing.log).toContain("error");
});

test("the stable output exists at construction and the node feeds it, so a delayed node init still sounds", async () => {
  let release!: (node: Node) => void;
  const node = new Node();
  const { deck, ctx, load } = setup({ makeNode: () => new Promise(resolve => { release = resolve as (n: Node) => void; }) });
  const [output, fade] = ctx.gains;
  expect(deck.output).toBe(output as unknown as GainNode);
  expect(fade.connected).toEqual([output]);
  deck.src = "/api/tracks/1/audio";
  deck.load();
  const playing = deck.play();
  await settle();
  release(node);
  await playing;
  expect(node.connected).toEqual([fade]);
  expect(node.last()).toMatchObject({ active: true, outputTime: 10.16 });
});

test("decode budget: an oversized decode errors, and decodes are limited to one per deck and two overall", async () => {
  const big = new Ctx();
  big.buffer = () => decoded(900, 96000);
  const tooBig = setup({ ctx: big });
  await tooBig.load();
  expect(tooBig.log).toContain("error");
  expect(tooBig.node.adds.length).toBe(0);

  const ctx = new Ctx();
  ctx.hold = true;
  const [a, b, c] = [setup({ ctx }), setup({ ctx }), setup({ ctx })];
  for (const [i, s] of [a, b, c].entries()) { s.deck.src = `/api/tracks/${i}/audio`; s.deck.load(); }
  await settle();
  expect(ctx.inFlight).toBe(2);
  // Three rapid loads on deck A while its decode is in flight: only the latest is decoded afterwards.
  a.deck.src = "/api/tracks/10/audio"; a.deck.load();
  a.deck.src = "/api/tracks/11/audio"; a.deck.load();
  await settle();
  expect(ctx.inFlight).toBe(2);
  ctx.hold = false;
  while (ctx.held.length) { ctx.held.shift()!.resolve(); await settle(); }
  await settle();
  expect(ctx.maxInFlight).toBe(2);
  expect(a.node.adds.length).toBe(1);
  expect(a.deck.currentSrc).toBe("http://app.test/api/tracks/11/audio");
  expect(b.deck.readyState).toBe(4);
  expect(c.deck.readyState).toBe(4);
});

test("stopEngines unloads every engine deck", async () => {
  const { deck, load } = setup();
  await load();
  stopEngines();
  expect([deck.src, deck.readyState]).toEqual(["", 0]);
});

test("pause is idempotent and fades with a stop slightly ahead", async () => {
  const { deck, node, log, load } = setup();
  await load();
  await deck.play();
  log.length = 0;
  deck.pause();
  deck.pause();
  expect(log).toEqual(["pause"]);
  expect(node.last()).toMatchObject({ active: false, outputTime: 10.015 });
});

test("stretchDeckFor reuses one instance and node per deck across unload/remount", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
  let made = 0;
  const node = new Node();
  const ctx = new Ctx();
  contexts.push(ctx);
  const makeNode = (async () => { made++; return node; }) as any;
  const first = stretchDeckFor("T1", ctx as any, makeNode);
  decks.push(first);
  first.src = "/api/tracks/1/audio";
  first.load();
  await settle();
  first.unload();
  const second = stretchDeckFor("T1", ctx as any, makeNode);
  expect(second).toBe(first);
  expect(second.output).toBe(first.output);
  second.src = "/api/tracks/2/audio";
  second.load();
  await settle();
  expect(made).toBe(1);
  expect(second.readyState).toBe(4);
});

test("unload pauses first so the pause event fires and the playhead is released", async () => {
  const { deck, log, load } = setup();
  await load();
  await deck.play();
  log.length = 0;
  deck.unload();
  expect(log[0]).toBe("pause");
  expect(deck.paused).toBe(true);
});

test("HTTP errors are tagged so the UI can tell them from engine failures", async () => {
  const { deck, load } = setup();
  globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  await load();
  expect(deck.error).toBeInstanceOf(HttpError);
  expect(isEngineUnavailable()).toBe(false);
});

test("error listeners see the current play intent in paused", async () => {
  const seen: boolean[] = [];
  for (const press of [true, false]) {
    const { ctx, deck } = setup();
    ctx.hold = true;
    deck.addEventListener("error", () => seen.push(deck.paused));
    deck.src = "/api/tracks/1/audio";
    deck.load();
    if (press) void deck.play().catch(() => {});
    await settle();
    ctx.held.shift()!.reject(new Error("decode failed"));
    await settle();
    expect(deck.paused).toBe(true);
  }
  expect(seen).toEqual([false, true]);
});

test("a rejection after the node exists (latency) fails the load without marking the engine unavailable", async () => {
  const bad = new Node();
  bad.latency = () => Promise.reject(new Error("latency"));
  const good = new Node();
  let n = 0;
  const { deck, log, load } = setup({ makeNode: async () => (n++ === 0 ? bad : good) });
  await load();
  expect(log).toContain("error");
  expect(isEngineUnavailable()).toBe(false);
  await load();
  expect(deck.readyState).toBe(4);
});

test("a node created after dispose is disconnected and dropped", async () => {
  const node = new Node();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const { deck, load } = setup({ makeNode: async () => { await gate; return node; } });
  await load();
  deck.dispose();
  release();
  await settle();
  expect(node.port.closed).toBe(true);
});

test("play right after pause zeroes the fade gain at now before the delayed ramp", async () => {
  const { deck, ctx, load } = setup();
  await load();
  await deck.play();
  deck.pause();
  const fade = ctx.gains[1];
  fade.gain.calls.length = 0;
  void deck.play().catch(() => {});
  await settle();
  expect(fade.gain.calls.slice(0, 2)).toEqual([["cancel", 10], ["set", 0, 10]]);
});
