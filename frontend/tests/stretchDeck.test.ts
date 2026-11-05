import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  HttpError, MAX_DECODED_BYTES, StretchDeck, stretchDeckFor, chooseEngine, fitsBudget, isEngineUnavailable, positionAt,
  resetEngineUnavailable, stopEngines, stretchParams,
} from "../src/lib/audio/stretchDeck";
import { Ctx, Node, contexts, decks, decoded, flush, installLocation, settle, setup, teardown } from "./stretchDeckFakes";

beforeAll(installLocation);
afterEach(teardown);
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
  expect(node.last()).toEqual({ active: true, input: 0, outputTime: 10.16, rate: 1, semitones: 0, loopStart: 0, loopEnd: 0 });
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
  // The fade feeds the automation stage, which ends at the output (chain pinned in stretchDeckAutomation.test.ts).
  expect(fade.connected).toEqual([ctx.gains[2]]);
  expect(ctx.filters[ctx.filters.length - 1].connected).toEqual([output]);
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

// ---- loops ---------------------------------------------------------------

test("positionAt wraps inside a loop, never reaches the end of the track, and is unchanged without one", () => {
  const a = { input: 2, output: 10, rate: 1, active: true };
  const loop = { start: 1, end: 4 };
  expect(positionAt(a, 11, 100, loop)).toBe(3);
  expect(positionAt(a, 12, 100, loop)).toBe(1); // reaches the end exactly: back to the start
  expect(positionAt(a, 13, 100, loop)).toBe(2);
  expect(positionAt({ ...a, rate: 1.5 }, 14, 100, loop)).toBeCloseTo(2); // raw 2 + 4 * 1.5 = 8 -> 1 + 7 % 3
  expect(positionAt({ input: 95, output: 0, rate: 1, active: true }, 1e6, 100, { start: 90, end: 100 })).toBeLessThan(100);
  expect(positionAt({ input: 95, output: 0, rate: 1, active: true }, 1e6, 100)).toBe(100);
  expect(positionAt({ ...a, active: false }, 50, 100, loop)).toBe(2);
});

async function playing() {
  const s = setup();
  await s.load();
  await s.deck.play(); // anchor input 0 at ctx 10.16
  s.ctx.currentTime = 12.16; // 2 s in
  return s;
}

test("setLoop rebases the anchor, sends explicit loop fields and wraps the playhead", async () => {
  const { deck, node, ctx } = await playing();
  expect(deck.setLoop(1, 4)).toBe(true);
  expect(deck.loop).toEqual({ start: 1, end: 4 });
  expect(node.last()).toMatchObject({ active: true, outputTime: 12.16, loopStart: 1, loopEnd: 4 });
  expect(node.last().input).toBeCloseTo(2);
  ctx.currentTime = 13.16; expect(deck.currentTime).toBeCloseTo(3);
  ctx.currentTime = 14.16; expect(deck.currentTime).toBeCloseTo(1);
  ctx.currentTime = 15.16; expect(deck.currentTime).toBeCloseTo(2);
});

test("a rate change inside a loop rebases the anchor inside it", async () => {
  const { deck, node, ctx } = await playing();
  deck.setLoop(1, 4);
  ctx.currentTime = 15.16; // 5 s of audio past the anchor: wrapped to 2
  deck.playbackRate = 1.1;
  expect(node.last()).toMatchObject({ active: true, outputTime: 15.16, rate: 1.1, loopStart: 1, loopEnd: 4 });
  expect(node.last().input).toBeCloseTo(2);
  expect(deck.currentTime).toBeCloseTo(2);
});

test("a seek outside the loop clears it with an explicit disabled loop; a seek inside keeps it", async () => {
  const { deck, node } = await playing();
  deck.setLoop(1, 4);
  deck.currentTime = 3;
  expect(deck.loop).toEqual({ start: 1, end: 4 });
  expect(node.last()).toMatchObject({ input: 3, loopStart: 1, loopEnd: 4 });
  deck.currentTime = 50;
  expect(deck.loop).toBeNull();
  expect(node.last()).toMatchObject({ input: 50, loopStart: 0, loopEnd: 0 });
  expect(node.segment).toMatchObject({ loopStart: 0, loopEnd: 0 });
});

test("a seek outside a loop while paused still disables it on the node", async () => {
  const { deck, node, load } = setup();
  await load();
  deck.setLoop(1, 4);
  deck.currentTime = 50;
  expect(deck.loop).toBeNull();
  expect(node.segment).toMatchObject({ loopStart: 0, loopEnd: 0 });
});

test("clearLoop keeps the playhead, rebased inside the loop, and disables the loop on the node", async () => {
  const { deck, node, ctx } = await playing();
  deck.setLoop(1, 4);
  ctx.currentTime = 15.16; // wrapped to 2
  deck.clearLoop();
  expect(deck.loop).toBeNull();
  expect(node.last()).toMatchObject({ active: true, outputTime: 15.16, loopStart: 0, loopEnd: 0 });
  expect(node.last().input).toBeCloseTo(2);
  ctx.currentTime = 17.16; expect(deck.currentTime).toBeCloseTo(4); // now it runs on past the old end
  deck.clearLoop(); // idempotent
});

test("every start passes the loop fields explicitly, so a reused node never inherits a stale loop", async () => {
  const { deck, node, load, ctx } = setup();
  await load();
  deck.setLoop(1, 4); // set while paused: stays in the engine until the start
  await deck.play();
  expect(node.last()).toMatchObject({ active: true, loopStart: 1, loopEnd: 4 });
  ctx.currentTime = 12;
  deck.pause();
  expect(node.last()).toMatchObject({ active: false, loopStart: 1, loopEnd: 4 });
  // New track on the same node: the mock inherits omitted fields like the wrapper, so the teardown must be explicit.
  await load("/api/tracks/2/audio");
  expect(deck.loop).toBeNull();
  expect(node.segment).toMatchObject({ loopStart: 0, loopEnd: 0 });
  await deck.play();
  expect(node.last()).toMatchObject({ active: true, loopStart: 0, loopEnd: 0 });
  expect(node.scheduled.every((e: Record<string, unknown>) => !("active" in e && e.active === true) || ("loopStart" in e && "loopEnd" in e))).toBe(true);
});

test("unload tears a loop down on the node before the buffers drop", async () => {
  const { deck, node } = await playing();
  deck.setLoop(1, 4);
  deck.unload();
  expect(deck.loop).toBeNull();
  expect(node.segment).toMatchObject({ active: false, loopStart: 0, loopEnd: 0 });
  expect(node.drops).toBeGreaterThan(0);
});

test("setLoop refuses without a decoded track or for a loop that is too short", async () => {
  const { deck, load } = setup();
  expect(deck.setLoop(0, 4)).toBe(false);
  await load();
  expect(deck.setLoop(2, 2.001)).toBe(false);
  expect(deck.setLoop(NaN, 3)).toBe(false);
  expect(deck.setLoop(0, 500)).toBe(true); // clamped to the track
  expect(deck.loop).toEqual({ start: 0, end: 100 });
});
