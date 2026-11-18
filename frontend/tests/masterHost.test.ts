import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
// Vite supplies this emitted module URL in-app (masterHost imports playbackAudio).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
mock.module("../src/lib/audio/master-tap.worklet.js?worker&url", () => ({ default: "/test/master-tap.worklet.js" }));
mock.module("../src/lib/audio/masterTap.worker.ts?worker&url", () => ({ default: "/test/masterTap.worker.js" }));
mock.module("../src/lib/audio/master-me.worklet.js?worker&url", () => ({ default: "/test/master-me.worklet.js" }));
mock.module("../src/lib/audio/master_me/master_me.wasm?url", () => ({ default: "/test/master_me.wasm" }));
const host = await import("../src/lib/masterHost");
const { offerRing, stallWatch } = host;
const playback = await import("../src/lib/playbackAudio");
const fxRackHost = await import("../src/lib/fxRackHost");
const recorder = await import("../src/lib/recorder");
const maximizer = await import("../src/lib/useMaximizer");
const maximizerEngine = await import("../src/lib/audio/maximizer");
const { deckInput, masterInput } = await import("../src/lib/audio/masterBus");
const { getPref, resetPrefs, setPref } = await import("../src/lib/prefs");
const { toast } = await import("sonner");
const { nativeAction } = await import("../src/lib/desktopRuntime");
const { CH, CHUNK_FRAMES, FRAME_HEADER_BYTES, RING_FRAMES, createRing, drainRing, ringViews } = await import("../src/lib/audio/masterRing");

const worklet = readFileSync(new URL("../src/lib/audio/master-tap.worklet.js", import.meta.url), "utf8");

function processor(options?: unknown) {
  let Constructor: any;
  const replies: unknown[] = [];
  class Base { port = { onmessage: (_: unknown) => {}, postMessage: (message: unknown) => replies.push(message) }; }
  new Function("AudioWorkletProcessor", "registerProcessor", worklet)(
    Base, (_name: string, implementation: any) => { Constructor = implementation; },
  );
  return { proc: new Constructor(options), replies };
}

function tap(options?: unknown) {
  const { proc, replies } = processor(options);
  const sent: { data: any; transfer: unknown[] }[] = [];
  let closed = false;
  proc.port.onmessage({ data: { port: { postMessage: (data: unknown, transfer: unknown[]) => sent.push({ data, transfer }), close: () => { closed = true; } } } });
  return { proc, sent, replies, closed: () => closed };
}

const DECKS = { processorOptions: { decks: true } };

/** A `decks: true` tap writing into a fresh shared ring whose write and read positions both start at `start`. */
function ringTap(start = 0) {
  const { proc, replies } = processor(DECKS);
  const sab = createRing();
  const views = ringViews(sab);
  views.h[0] = views.h[1] = start;
  proc.port.onmessage({ data: { ring: sab } });
  return { proc, replies, sab, views };
}

const ramp = (offset: number) => Float32Array.from({ length: 128 }, (_, i) => offset + i);
/** Deck A = ramp(offset), deck B = ramp(offset + 20 000), both stereo with R = L + 10 000. */
const deckBlock = (offset: number) => [[ramp(offset), ramp(offset + 10_000)], [ramp(offset + 20_000), ramp(offset + 30_000)]];
const samplesOf = (frame: ArrayBuffer) => new Float32Array(frame, FRAME_HEADER_BYTES);
const headerOf = (frame: ArrayBuffer) => Array.from(new Uint8Array(frame, 0, FRAME_HEADER_BYTES));

describe("master tap worklet, default (the set recorder's) mode", () => {
  test("interleaves two 128-frame blocks into one transferred 256-frame stereo Float32Array", () => {
    const { proc, sent } = tap();
    expect(proc.process([[ramp(0), ramp(1000)]])).toBe(true);
    expect(sent).toHaveLength(0);
    proc.process([[ramp(128), ramp(1128)]]);
    expect(sent).toHaveLength(1);
    const { data, transfer } = sent[0];
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(512);
    expect(transfer).toEqual([data.buffer]);
    expect(Array.from(data.slice(0, 4))).toEqual([0, 1000, 1, 1001]);
    expect(Array.from(data.slice(508))).toEqual([254, 1254, 255, 1255]);
  });

  test("the recorder's 4096-frame option still posts stereo Float32Array blocks of that size, and ignores a second input", () => {
    const { proc, sent } = tap({ processorOptions: { frames: 4096 } });
    for (let block = 0; block < 32; block++) proc.process([[ramp(block * 128), ramp(block * 128)], [ramp(-1), ramp(-1)]]);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toBeInstanceOf(Float32Array); // recorder.ts drops anything else
    expect(sent[0].data.length).toBe(8192);
    expect(Array.from(sent[0].data.slice(8188))).toEqual([4094, 4094, 4095, 4095]);
  });

  test("sends silence with no input, copies a mono input to both sides, and ends on stop", () => {
    const { proc, sent, closed } = tap();
    proc.process([[]]);
    proc.process([[ramp(5)]]);
    expect(Array.from(sent[0].data.slice(0, 256)).every(s => s === 0)).toBe(true);
    expect(Array.from(sent[0].data.slice(256, 260))).toEqual([5, 5, 6, 6]);
    proc.port.onmessage({ data: { stop: true } });
    expect(closed()).toBe(true);
    expect(proc.process([[ramp(0), ramp(0)]])).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("passes nothing on before the port arrives, and refuses a shared ring", () => {
    const { proc, replies } = processor();
    expect(proc.process([[ramp(0), ramp(0)]])).toBe(true);
    proc.port.onmessage({ data: { ring: createRing() } });
    expect(replies).toEqual([{ ring: false }]);
    expect(proc.process([[ramp(0), ramp(0)]])).toBe(true);
  });
});

describe("master tap worklet, decks mode (the VST3 host)", () => {
  test("posts one transferred headed frame per 256 frames: a zero 32-byte header, then AL, AR, BL, BR", () => {
    const { proc, sent } = tap(DECKS);
    proc.process(deckBlock(0));
    expect(sent).toHaveLength(0);
    proc.process(deckBlock(128));
    expect(sent).toHaveLength(1);
    const { data, transfer } = sent[0];
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(data.byteLength).toBe(32 + 4096);
    expect(transfer).toEqual([data]);
    expect(headerOf(data).every(byte => byte === 0)).toBe(true);
    const samples = samplesOf(data);
    expect(Array.from(samples.slice(0, 8))).toEqual([0, 10_000, 20_000, 30_000, 1, 10_001, 20_001, 30_001]);
    expect(Array.from(samples.slice(1020))).toEqual([255, 10_255, 20_255, 30_255]);
  });

  test("a mono deck feeds both sides and a missing deck is silence", () => {
    const { proc, sent } = tap(DECKS);
    proc.process([[ramp(0)]]); // deck B has no input at all
    proc.process([[], [ramp(7)]]); // deck A empty, deck B mono
    const samples = samplesOf(sent[0].data);
    expect(Array.from(samples.slice(0, 8))).toEqual([0, 0, 0, 0, 1, 1, 0, 0]);
    expect(Array.from(samples.slice(512, 520))).toEqual([0, 0, 7, 7, 0, 0, 8, 8]);
  });
});

describe("master tap shared ring (4 channels)", () => {
  test("is 4-channel: 65 536 frames, 1 MiB of samples", () => {
    expect(CH).toBe(4);
    expect(createRing().byteLength).toBe(16 + RING_FRAMES * 4 * 4);
    expect(RING_FRAMES * 4 * 4).toBe(1 << 20);
  });

  test("a write across the wrap and past int32 overflow drains back as headed AL, AR, BL, BR frames", () => {
    const { proc, replies, views } = ringTap(0x7FFFFF60); // 160 frames before the slot wrap
    expect(replies).toEqual([{ ring: true }]);
    for (let block = 0; block < 4; block++) proc.process(deckBlock(block * 128));
    expect(views.h[0]).toBe((0x7FFFFF60 + 512) | 0);
    expect(views.h[0]).toBeLessThan(0); // passed 0x80000000
    const frames: ArrayBuffer[] = [];
    expect(drainRing(views, views.h[0], frame => frames.push(frame))).toBe(512);
    expect(views.h[1]).toBe(views.h[0]);
    expect(frames).toHaveLength(2);
    expect(frames.every(frame => frame.byteLength === 32 + 4096 && headerOf(frame).every(byte => byte === 0))).toBe(true);
    const got = frames.flatMap(frame => {
      const samples = samplesOf(frame);
      return Array.from({ length: CHUNK_FRAMES }, (_, i) => Array.from(samples.slice(i * 4, i * 4 + 4)));
    });
    expect(got).toEqual(Array.from({ length: 512 }, (_, i) => [i, 10_000 + i, 20_000 + i, 30_000 + i]));
  });

  test("drains whole chunks only and leaves the rest for later", () => {
    const { proc, views } = ringTap();
    for (let block = 0; block < 3; block++) proc.process(deckBlock(0));
    const frames: ArrayBuffer[] = [];
    expect(drainRing(views, views.h[0], frame => frames.push(frame))).toBe(384);
    expect(frames).toHaveLength(1);
    expect(views.h[1]).toBe(256);
  });

  test("wakes a reader at a 128 phase as soon as a whole chunk waits", async () => {
    const { proc, views } = ringTap(128);
    const early = Atomics.waitAsync(views.h, 0, 128, 30);
    proc.process(deckBlock(0)); // 128 frames waiting: no wake
    expect(await early.value).toBe("timed-out");
    const wake = Atomics.waitAsync(views.h, 0, views.h[0], 1000);
    expect(wake.async).toBe(true);
    proc.process(deckBlock(0)); // write 384, read 128: a whole chunk, although 384 is no multiple of 256
    expect(await wake.value).toBe("ok");
  });

  test("a full ring drops the block and counts an overrun", () => {
    const { proc, views } = ringTap();
    views.h[0] = RING_FRAMES - 64;
    proc.process(deckBlock(0));
    expect(views.h[0]).toBe(RING_FRAMES - 64);
    expect(views.h[2]).toBe(1);
  });

  test("stop ends the writes, and a port after the ring leaves only the port", () => {
    const stopped = ringTap();
    stopped.proc.port.onmessage({ data: { stop: true } });
    expect(stopped.proc.process(deckBlock(0))).toBe(false);
    expect(stopped.views.h[0]).toBe(0);

    const { proc, views } = ringTap();
    const sent: ArrayBuffer[] = [];
    proc.port.onmessage({ data: { port: { postMessage: (data: ArrayBuffer) => sent.push(data), close() {} } } });
    proc.process(deckBlock(0));
    proc.process(deckBlock(0));
    expect(sent).toHaveLength(1);
    expect(views.h[0]).toBe(0);
  });

  test("refuses a ring that is no SharedArrayBuffer, or one offered after a port", () => {
    const { proc, replies } = processor(DECKS);
    proc.port.onmessage({ data: { ring: new ArrayBuffer(createRing().byteLength) } });
    const { replies: late, proc: withPort } = tap(DECKS);
    withPort.port.onmessage({ data: { ring: createRing() } });
    expect(replies).toEqual([{ ring: false }]);
    expect(late).toEqual([{ ring: false }]);
  });
});

describe("master tap worker on the shared ring", () => {
  test("discards the backlog until open, sends whole headed frames, sleeps on a partial one and ends on stop", async () => {
    class FakeSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      static last: FakeSocket;
      readyState = 0; bufferedAmount = 0; binaryType = "";
      sent: ArrayBuffer[] = [];
      onopen = () => {}; onmessage = (_: { data: unknown }) => {}; onclose = () => {};
      constructor(public url: string) { FakeSocket.last = this; }
      send(data: ArrayBuffer) { this.sent.push(data); }
      close() { this.readyState = 2; }
    }
    const g = globalThis as any;
    const saved = { WebSocket: g.WebSocket, postMessage: g.postMessage, close: g.close, onmessage: g.onmessage, waitAsync: Atomics.waitAsync };
    const posted: any[] = [];
    let waits = 0;
    g.WebSocket = FakeSocket;
    g.postMessage = (message: unknown) => posted.push(message);
    g.close = () => {};
    (Atomics as any).waitAsync = (...args: Parameters<typeof Atomics.waitAsync>) => { waits++; return saved.waitAsync(...args); };
    const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
    try {
      await import("../src/lib/audio/masterTap.worker.ts");
      const { proc, sab, views } = ringTap();
      for (let block = 0; block < 4; block++) proc.process(deckBlock(0));
      g.onmessage({ data: { ring: sab, url: "ws://127.0.0.1:1/token" } });
      const ws = FakeSocket.last;
      await settle();
      expect(views.h[1]).toBe(512); // backlog discarded while connecting
      expect(ws.sent).toHaveLength(0);

      Atomics.add(views.h, 2, 3); // overruns before the socket opened are not reported
      ws.readyState = 1;
      ws.onopen();
      proc.process(deckBlock(0));
      proc.process(deckBlock(128));
      await settle();
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0].byteLength).toBe(32 + 4096);
      expect(Array.from(samplesOf(ws.sent[0]).slice(0, 8))).toEqual([0, 10_000, 20_000, 30_000, 1, 10_001, 20_001, 30_001]);

      proc.process(deckBlock(0)); // 128 frames: the loop sleeps, and timers still run
      await settle();
      expect(ws.sent).toHaveLength(1);
      Atomics.add(views.h, 2, 1);
      ws.onmessage({ data: JSON.stringify({ sample_rate: 44_100, latency_ms: 50 }) });
      expect(posted.at(-1).stats).toMatchObject({ path: "shared", ring_overruns: 1, ring_peak_ms: 5.8, latency_ms: 50 });

      g.onmessage({ data: { stop: true } }); // closes the socket: CLOSING
      expect(ws.readyState).toBe(2);
      proc.process(deckBlock(0)); // a whole chunk wakes the loop, which ends
      await settle();
      const after = waits;
      expect(after).toBeGreaterThan(0);
      for (let block = 0; block < 4; block++) proc.process(deckBlock(0));
      await settle();
      expect(waits).toBe(after);
      expect(ws.sent).toHaveLength(1);
    } finally {
      Object.assign(g, { WebSocket: saved.WebSocket, postMessage: saved.postMessage, close: saved.close, onmessage: saved.onmessage });
      (Atomics as any).waitAsync = saved.waitAsync;
    }
  });
});

describe("offerRing", () => {
  const g = globalThis as any;
  afterEach(() => { delete g.crossOriginIsolated; });
  function port(reply?: (message: any, self: any) => void) {
    const self: any = { onmessage: null, posted: [] as unknown[] };
    self.postMessage = (message: unknown) => { self.posted.push(message); reply?.(message, self); };
    return self;
  }

  test("is null without posting when the page is not isolated", async () => {
    const tapPort = port();
    expect(await offerRing(tapPort)).toBeNull();
    expect(tapPort.posted).toHaveLength(0);
  });

  test("gives the ring on {ring:true}, and null on {ring:false}, a throw or the timeout", async () => {
    g.crossOriginIsolated = true;
    const yes = port((_, self) => queueMicrotask(() => self.onmessage({ data: { ring: true } })));
    const ring = await offerRing(yes);
    expect(ring).toBeInstanceOf(SharedArrayBuffer);
    expect(yes.posted).toEqual([{ ring }]);
    expect(await offerRing(port((_, self) => queueMicrotask(() => self.onmessage({ data: { ring: false } }))))).toBeNull();
    expect(await offerRing(port(() => { throw new Error("no clone"); }))).toBeNull();
    const silent = port();
    expect(await offerRing(silent, 10)).toBeNull();
    expect(silent.onmessage).toBeNull(); // a late reply is ignored
  });
});

test("the stall watch fires only after frames_out stops advancing for the limit", () => {
  const watch = stallWatch(1200, 0);
  expect(watch.stalled(1200)).toBe(false);
  expect(watch.stalled(1201)).toBe(true);
  watch.update(512, 1000);
  expect(watch.stalled(2100)).toBe(false);
  watch.update(512, 2000); // no progress: the clock keeps running from 1000
  expect(watch.stalled(2201)).toBe(true);
  watch.update(1024, 2300);
  expect(watch.stalled(3400)).toBe(false);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a native action with a timeout gives up with a Greek message", async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  await expect(nativeAction("master_host_start", { path: "/x.vst3", sample_rate: 48000 }, 20))
    .rejects.toThrow("Η ενέργεια δεν ολοκληρώθηκε εγκαίρως.");
  globalThis.fetch = (async () => Response.json({ detail: "Μη έγκυρη διαδρομή plugin VST3." }, { status: 503 })) as unknown as typeof fetch;
  await expect(nativeAction("master_host_start", {}, 1000)).rejects.toThrow("Μη έγκυρη διαδρομή plugin VST3.");
});

describe("VST3 slots host", () => {
  class Param {
    value = 1;
    cancelAndHoldAtTime() {}
    linearRampToValueAtTime(value: number) { this.value = value; }
  }
  class Node {
    connections: unknown[] = [];
    inputs: number[] = [];
    gain = new Param();
    connect(node: unknown, _output = 0, input = 0) { this.connections.push(node); this.inputs.push(input); return node; }
    disconnect(node?: unknown) {
      if (node === undefined) { this.connections = []; this.inputs = []; return; }
      if (!this.connections.includes(node)) throw new Error("InvalidAccessError");
      this.inputs = this.inputs.filter((_, i) => this.connections[i] !== node);
      this.connections = this.connections.filter(other => other !== node);
    }
  }
  class Ctx {
    state = "running";
    currentTime = 1;
    sampleRate = 48000;
    destination = new Node();
    audioWorklet = { addModule: async (_url: string) => {} };
    createGain() { return new Node(); }
    addEventListener() {}
  }
  let taps: FakeTap[] = [];
  class FakeTap extends Node {
    posted: unknown[] = [];
    port = { postMessage: (message: unknown) => { this.posted.push(message); }, onmessage: null };
    constructor(public ctx: unknown, public name: string, public options: any) { super(); taps.push(this); }
  }
  let workers: FakeWorker[] = [];
  /** Stats the worker hands the page right after the socket opens (before the switch). */
  let earlyStats: unknown = null;
  class FakeWorker {
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: (() => void) | null = null;
    posted: any[] = [];
    constructor(public url: string) { workers.push(this); }
    postMessage(message: any) {
      this.posted.push(message);
      if (!message.url) return;
      queueMicrotask(() => this.onmessage?.({ data: { open: true } }));
      if (earlyStats) setTimeout(() => this.onmessage?.({ data: { stats: earlyStats } }), 0);
    }
    stats(stats: unknown) { this.onmessage?.({ data: { stats } }); }
  }

  const stats = (o: Record<string, unknown> = {}) => ({
    frames_out: 1, latency_ms: 10, sample_rate: 48000, pdc: 0, callback_load_pct: 5,
    slots: { deck_a: null, deck_b: null, master: null }, ...o,
  });
  const slotStats = (fault: string | null) => ({ name: "A", latency: 0, comp: 0, bypassed: fault !== null, fault, load_pct: 1 });
  const paths = { deck_a: "/a.vst3", deck_b: null, master: "/m.vst3" };

  let ctx: Ctx;
  let actions: { action: string; arguments: any }[] = [];
  let startReply: unknown;
  let errors: unknown[] = [];
  let recording = false;
  let fxReady = true;
  const spies: { mockRestore(): void }[] = [];
  let recordingSpy: { mockRestore(): void };
  const g = globalThis as any;
  const saved = { fetch: globalThis.fetch, AudioWorkletNode: g.AudioWorkletNode, Worker: g.Worker };

  beforeEach(() => {
    resetPrefs();
    ctx = new Ctx();
    taps = [];
    workers = [];
    actions = [];
    errors = [];
    earlyStats = null;
    recording = false;
    fxReady = true;
    startReply = {
      token: "t", port: 9,
      slots: { deck_a: { name: "Comp A", latency_samples: 64, restored: true }, deck_b: null, master: { error: "Το plugin δεν φορτώθηκε." } },
    };
    g.AudioWorkletNode = FakeTap;
    g.Worker = FakeWorker;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      actions.push(body);
      return Response.json({ canceled: false, value: body.action === "master_host_start" ? startReply : null });
    }) as unknown as typeof fetch;
    spies.push(
      spyOn(playback, "playbackContext").mockImplementation(() => ctx as unknown as AudioContext),
      spyOn(fxRackHost, "fxRackReady").mockImplementation(() => fxReady),
      recordingSpy = spyOn(recorder, "recordingActive").mockImplementation(() => recording),
      spyOn(toast, "error").mockImplementation(message => { errors.push(message); return 0; }),
    );
  });
  afterEach(async () => {
    await host.stopMasterHost();
    spies.splice(0).forEach(spy => spy.mockRestore());
    globalThis.fetch = saved.fetch;
    g.AudioWorkletNode = saved.AudioWorkletNode;
    g.Worker = saved.Worker;
  });

  const bus = () => ({
    a: deckInput(ctx as unknown as BaseAudioContext, "A") as unknown as Node,
    b: deckInput(ctx as unknown as BaseAudioContext, "B") as unknown as Node,
    input: masterInput(ctx as unknown as BaseAudioContext) as unknown as Node,
  });
  const output = () => bus().input.connections[0] as Node;

  test("refuses to start while a set recording runs: a toast, no native action, nothing taken", async () => {
    recording = true;
    await host.startMasterHost(paths);
    expect(errors).toEqual(["Τα plugins VST3 δεν ξεκινούν όσο γράφεται set· σταμάτησε πρώτα την εγγραφή."]);
    expect(actions).toEqual([]);
    expect(host.masterHostInUse()).toBe(false);
  });

  test("refuses to start before the deck effects are ready, and does nothing without any slot", async () => {
    fxReady = false;
    await host.startMasterHost(paths);
    expect(errors).toEqual(["Τα plugins VST3 χρειάζονται τα εφέ των decks, που δεν είναι έτοιμα."]);
    fxReady = true;
    await host.startMasterHost({ deck_a: null, deck_b: null, master: null });
    expect(actions).toEqual([]);
    expect(host.masterHostInUse()).toBe(false);
  });

  test("a start sends the slots, sinks the decks into a 2-input tap, keeps the latest stats and toasts a failed slot once", async () => {
    const { a, b, input } = bus();
    const out = output();
    const recorderTap = new Node();
    out.connect(recorderTap); // as addMasterTap: an extra listener on out
    const starting = host.startMasterHost(paths);
    expect(host.masterHostInUse()).toBe(true); // synchronously, before the first await
    await starting;
    expect(actions[0]).toEqual({ action: "master_host_start", arguments: { sample_rate: 48000, slots: paths } });
    const [tap] = taps;
    expect(tap.name).toBe("cratemind-master-tap");
    expect(tap.options).toMatchObject({ numberOfInputs: 2, channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers", processorOptions: { decks: true } });
    expect(a.connections).toEqual([tap]);
    expect(a.inputs).toEqual([0]);
    expect(b.connections).toEqual([tap]);
    expect(b.inputs).toEqual([1]);
    expect(out.connections).toEqual([recorderTap]); // off the speakers; the other listener stays
    expect(input.connections).toEqual([out]);
    expect([a.gain.value, b.gain.value, out.gain.value]).toEqual([1, 1, 1]); // the switch dip is over
    expect(host.masterHostActive()).toBe(true);
    expect(getPref("hostPluginDeckA")).toBe("/a.vst3");
    expect(getPref("hostPluginDeckB")).toBeNull();
    expect(getPref("masterHostPlugin")).toBe("/m.vst3");
    expect(errors).toEqual(["Master: Το plugin δεν φορτώθηκε. Το slot έμεινε άδειο."]);
  });

  test("the post-switch publish keeps the stats that came before it", async () => {
    earlyStats = stats({ latency_ms: 12 }); // arrives during the switch dip
    await host.startMasterHost(paths);
    // The stop drain reads the published stats: 12 + 25 ms, not the 125 ms it uses when they are null.
    const begun = performance.now();
    await host.stopMasterHost();
    expect(performance.now() - begun).toBeLessThan(100);
  });

  test("fault toasts fire once per transition, with the slot's label", async () => {
    await host.startMasterHost(paths);
    const [worker] = workers;
    const withFault = (fault: string | null) => stats({ slots: { deck_a: slotStats(fault), deck_b: null, master: null } });
    errors = [];
    worker.stats(withFault("error"));
    worker.stats(withFault("error"));
    worker.stats(withFault(null));
    worker.stats(withFault("slow"));
    worker.stats(withFault("slow"));
    worker.stats(withFault("reload"));
    expect(errors).toEqual([
      host.faultMessage("deck_a", "error"), host.faultMessage("deck_a", "slow"), host.faultMessage("deck_a", "reload"),
    ]);
  });

  test("a recording cannot start from the start click through the stop drain; the drain dips the decks, then all comes back", async () => {
    const { a, b, input } = bus();
    const out = output();
    recordingSpy.mockRestore(); // the recorder's real state from here on
    const refused = "Η εγγραφή δεν ξεκινά όσο ο ήχος περνά από plugins VST3· σταμάτησέ τα πρώτα στις Ρυθμίσεις → Αναπαραγωγή.";
    const starting = host.startMasterHost(paths);
    await recorder.startRecording(); // "starting"
    expect(recorder.recordingActive()).toBe(false);
    await starting;
    errors = [];
    await recorder.startRecording(); // "on"
    expect(recorder.recordingActive()).toBe(false);
    const stopping = host.stopMasterHost();
    expect(host.masterHostActive()).toBe(true); // still draining, although the status already says off
    await recorder.startRecording(); // the stop drain
    expect(recorder.recordingActive()).toBe(false);
    expect(errors).toEqual([refused, refused]);
    await new Promise(resolve => setTimeout(resolve, 20)); // inside the drain: decks faded out, feeding silence
    expect([a.gain.value, b.gain.value]).toEqual([0, 0]);
    await stopping;
    expect(host.masterHostActive()).toBe(false);
    expect(host.masterHostInUse()).toBe(false);
    expect(a.connections).toEqual([input]);
    expect(b.connections).toEqual([input]);
    expect(out.connections).toEqual([ctx.destination]);
    expect([a.gain.value, b.gain.value, out.gain.value]).toEqual([1, 1, 1]);
    expect(actions.at(-1)!.action).toBe("master_host_stop");
    expect(taps[0].posted).toContainEqual({ stop: true });
    expect(workers[0].posted).toContainEqual({ stop: true });
  });

  test("a stop while the start loads its modules never sends the start", async () => {
    const starting = host.startMasterHost(paths);
    const stopped = host.stopMasterHost();
    await Promise.all([starting, stopped]);
    expect(actions.map(a => a.action)).toEqual(["master_host_stop"]);
    expect(host.masterHostInUse()).toBe(false);
    expect(taps).toEqual([]);
  });

  test("Stop, Start, Stop, Start within one drain: every native stop goes out before the newest start", async () => {
    await host.startMasterHost(paths);
    const stop1 = host.stopMasterHost(); // drains ~125 ms
    const start2 = host.startMasterHost(paths);
    const stop2 = host.stopMasterHost();
    const start3 = host.startMasterHost(paths);
    await Promise.all([stop1, start2, stop2, start3]);
    expect(actions.map(a => a.action)).toEqual(["master_host_start", "master_host_stop", "master_host_stop", "master_host_start"]);
    expect(host.masterHostActive()).toBe(true);
  });

  test("a lost link brings the speakers back at once", async () => {
    const { a, input } = bus();
    const out = output();
    await host.startMasterHost(paths);
    workers[0].onmessage?.({ data: { closed: true } });
    expect(host.masterHostInUse()).toBe(false);
    expect(a.connections).toEqual([input]);
    expect(out.connections).toEqual([ctx.destination]);
    expect(errors.at(-1)).toBe("Η έξοδος μέσω plugins σταμάτησε· ο ήχος επέστρεψε στην κανονική έξοδο.");
  });

  test("bypass and the window name their slot", async () => {
    await host.bypassHostSlot("deck_b", true);
    await host.openMasterHostEditor("master");
    expect(actions).toEqual([
      { action: "master_host_bypass", arguments: { slot: "deck_b", bypassed: true } },
      { action: "master_host_editor", arguments: { slot: "master" } },
    ]);
  });

  test("the Maximizer leaves the bus inside the switch and comes back only after release()", async () => {
    const node = new Node();
    const active: boolean[] = [];
    let ready!: () => void;
    const engine = {
      node, ready: new Promise<void>(resolve => { ready = resolve; }),
      set() {}, setActive: (on: boolean) => { active.push(on); }, onMeters() {}, onError() {},
    };
    spies.push(
      spyOn(maximizerEngine, "loadMaximizer").mockImplementation(async () => new ArrayBuffer(8)),
      spyOn(maximizerEngine, "createMaximizer").mockImplementation(() => { queueMicrotask(ready); return engine as never; }),
    );
    const { input } = bus();
    const out = output();
    const settle = () => new Promise(resolve => setTimeout(resolve, 40));
    setPref("maximizer", true);
    maximizer.syncMaximizer();
    await settle();
    expect(input.connections).toEqual([node]); // inserted
    await host.startMasterHost(paths);
    expect(input.connections).toEqual([out]);
    expect(active.at(-1)).toBe(false);
    maximizer.syncMaximizer(); // a statechange or a pref write while the slots run
    await settle();
    expect(input.connections).toEqual([out]);
    const stopping = host.stopMasterHost();
    await new Promise(resolve => setTimeout(resolve, 20)); // in the drain, before release()
    expect(input.connections).toEqual([out]);
    await stopping;
    await settle();
    expect(input.connections).toEqual([node]);
    expect(active.at(-1)).toBe(true); // re-activated: its DSP starts clean
    expect([out.gain.value]).toEqual([1]);
    setPref("maximizer", false);
    maximizer.syncMaximizer();
    await settle();
    expect(input.connections).toEqual([out]);
  });
});

test("faultMessage names the slot", () => {
  expect(host.faultMessage("deck_a", "error")).toBe("Το plugin του Deck A παρουσίασε σφάλμα και μπήκε σε bypass· τα υπόλοιπα συνεχίζουν.");
  expect(host.faultMessage("deck_b", "slow")).toBe("Το plugin του Deck B είναι πολύ αργό για πραγματικό χρόνο και μπήκε σε bypass.");
  expect(host.faultMessage("master", "reload")).toBe("Το plugin του Master ζήτησε επαναφόρτωση και μπήκε σε bypass· σταμάτησε και ξεκίνησε ξανά τα plugins.");
  expect(host.HOST_SLOTS.map(slot => host.HOST_SLOT_LABEL[slot])).toEqual(["Deck A", "Deck B", "Master"]);
});
