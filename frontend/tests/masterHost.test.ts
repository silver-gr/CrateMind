import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
// Vite supplies this emitted module URL in-app (masterHost imports playbackAudio).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const { offerRing, stallWatch } = await import("../src/lib/masterHost");
const { nativeAction } = await import("../src/lib/desktopRuntime");
const { CHUNK_FRAMES, RING_FRAMES, createRing, drainRing, ringViews } = await import("../src/lib/audio/masterRing");

const worklet = readFileSync(new URL("../src/lib/audio/master-tap.worklet.js", import.meta.url), "utf8");

function processor() {
  let Constructor: any;
  const replies: unknown[] = [];
  class Base { port = { onmessage: (_: unknown) => {}, postMessage: (message: unknown) => replies.push(message) }; }
  new Function("AudioWorkletProcessor", "registerProcessor", worklet)(
    Base, (_name: string, implementation: any) => { Constructor = implementation; },
  );
  return { proc: new Constructor(), replies };
}

function tap() {
  const { proc, replies } = processor();
  const sent: { data: Float32Array; transfer: unknown[] }[] = [];
  let closed = false;
  proc.port.onmessage({ data: { port: { postMessage: (data: Float32Array, transfer: unknown[]) => sent.push({ data, transfer }), close: () => { closed = true; } } } });
  return { proc, sent, replies, closed: () => closed };
}

/** A tap writing into a fresh shared ring whose write and read positions both start at `start`. */
function ringTap(start = 0) {
  const { proc, replies } = processor();
  const sab = createRing();
  const views = ringViews(sab);
  views.h[0] = views.h[1] = start;
  proc.port.onmessage({ data: { ring: sab } });
  return { proc, replies, sab, views };
}

const ramp = (offset: number) => Float32Array.from({ length: 128 }, (_, i) => offset + i);

describe("master tap worklet", () => {
  test("interleaves two 128-frame blocks into one transferred 256-frame stereo buffer", () => {
    const { proc, sent } = tap();
    expect(proc.process([[ramp(0), ramp(1000)]])).toBe(true);
    expect(sent).toHaveLength(0);
    proc.process([[ramp(128), ramp(1128)]]);
    expect(sent).toHaveLength(1);
    const { data, transfer } = sent[0];
    expect(data.length).toBe(512);
    expect(transfer).toEqual([data.buffer]);
    expect(Array.from(data.slice(0, 4))).toEqual([0, 1000, 1, 1001]);
    expect(Array.from(data.slice(508))).toEqual([254, 1254, 255, 1255]);
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

  test("passes nothing on before the port arrives", () => {
    let Constructor: any;
    class Base { port = { onmessage: (_: unknown) => {} }; }
    new Function("AudioWorkletProcessor", "registerProcessor", worklet)(Base, (_: string, impl: any) => { Constructor = impl; });
    expect(new Constructor().process([[ramp(0), ramp(0)]])).toBe(true);
  });
});

describe("master tap shared ring", () => {
  test("a write across the wrap and past int32 overflow drains back interleaved", () => {
    const { proc, replies, views } = ringTap(0x7FFFFF60); // 160 frames before the slot wrap
    expect(replies).toEqual([{ ring: true }]);
    for (let block = 0; block < 4; block++) proc.process([[ramp(block * 128), ramp(10_000 + block * 128)]]);
    expect(views.h[0]).toBe((0x7FFFFF60 + 512) | 0);
    expect(views.h[0]).toBeLessThan(0); // passed 0x80000000
    const chunks: Float32Array[] = [];
    expect(drainRing(views, views.h[0], chunk => chunks.push(chunk))).toBe(512);
    expect(views.h[1]).toBe(views.h[0]);
    expect(chunks).toHaveLength(2);
    const frames = chunks.flatMap(chunk => Array.from({ length: CHUNK_FRAMES }, (_, i) => [chunk[i * 2], chunk[i * 2 + 1]]));
    expect(frames).toEqual(Array.from({ length: 512 }, (_, i) => [i, 10_000 + i]));
  });

  test("drains whole chunks only and leaves the rest for later", () => {
    const { proc, views } = ringTap();
    for (let block = 0; block < 3; block++) proc.process([[ramp(0), ramp(0)]]);
    const chunks: Float32Array[] = [];
    expect(drainRing(views, views.h[0], chunk => chunks.push(chunk))).toBe(384);
    expect(chunks).toHaveLength(1);
    expect(views.h[1]).toBe(256);
  });

  test("wakes a reader at a 128 phase as soon as a whole chunk waits", async () => {
    const { proc, views } = ringTap(128);
    const early = Atomics.waitAsync(views.h, 0, 128, 30);
    proc.process([[ramp(0), ramp(0)]]); // 128 frames waiting: no wake
    expect(await early.value).toBe("timed-out");
    const wake = Atomics.waitAsync(views.h, 0, views.h[0], 1000);
    expect(wake.async).toBe(true);
    proc.process([[ramp(0), ramp(0)]]); // write 384, read 128: a whole chunk, although 384 is no multiple of 256
    expect(await wake.value).toBe("ok");
  });

  test("a full ring drops the block and counts an overrun", () => {
    const { proc, views } = ringTap();
    views.h[0] = RING_FRAMES - 64;
    proc.process([[ramp(0), ramp(0)]]);
    expect(views.h[0]).toBe(RING_FRAMES - 64);
    expect(views.h[2]).toBe(1);
  });

  test("stop ends the writes, and a port after the ring leaves only the port", () => {
    const stopped = ringTap();
    stopped.proc.port.onmessage({ data: { stop: true } });
    expect(stopped.proc.process([[ramp(0), ramp(0)]])).toBe(false);
    expect(stopped.views.h[0]).toBe(0);

    const { proc, views } = ringTap();
    const sent: Float32Array[] = [];
    proc.port.onmessage({ data: { port: { postMessage: (data: Float32Array) => sent.push(data), close() {} } } });
    proc.process([[ramp(0), ramp(0)]]);
    proc.process([[ramp(0), ramp(0)]]);
    expect(sent).toHaveLength(1);
    expect(views.h[0]).toBe(0);
  });

  test("refuses a ring that is no SharedArrayBuffer, or one offered after a port", () => {
    const { proc, replies } = processor();
    proc.port.onmessage({ data: { ring: new ArrayBuffer(createRing().byteLength) } });
    const { replies: late, proc: withPort } = tap();
    withPort.port.onmessage({ data: { ring: createRing() } });
    expect(replies).toEqual([{ ring: false }]);
    expect(late).toEqual([{ ring: false }]);
  });
});

describe("master tap worker on the shared ring", () => {
  test("discards the backlog until open, sends whole chunks, sleeps on a partial one and ends on stop", async () => {
    class FakeSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      static last: FakeSocket;
      readyState = 0; bufferedAmount = 0; binaryType = "";
      sent: Float32Array[] = [];
      onopen = () => {}; onmessage = (_: { data: unknown }) => {}; onclose = () => {};
      constructor(public url: string) { FakeSocket.last = this; }
      send(data: Float32Array) { this.sent.push(data); }
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
      for (let block = 0; block < 4; block++) proc.process([[ramp(0), ramp(0)]]);
      g.onmessage({ data: { ring: sab, url: "ws://127.0.0.1:1/token" } });
      const ws = FakeSocket.last;
      await settle();
      expect(views.h[1]).toBe(512); // backlog discarded while connecting
      expect(ws.sent).toHaveLength(0);

      Atomics.add(views.h, 2, 3); // overruns before the socket opened are not reported
      ws.readyState = 1;
      ws.onopen();
      proc.process([[ramp(0), ramp(1)]]);
      proc.process([[ramp(128), ramp(129)]]);
      await settle();
      expect(ws.sent).toHaveLength(1);
      expect(Array.from(ws.sent[0].slice(0, 4))).toEqual([0, 1, 1, 2]);

      proc.process([[ramp(0), ramp(0)]]); // 128 frames: the loop sleeps, and timers still run
      await settle();
      expect(ws.sent).toHaveLength(1);
      Atomics.add(views.h, 2, 1);
      ws.onmessage({ data: JSON.stringify({ sample_rate: 44_100, latency_ms: 50 }) });
      expect(posted.at(-1).stats).toMatchObject({ path: "shared", ring_overruns: 1, ring_peak_ms: 5.8, latency_ms: 50 });

      g.onmessage({ data: { stop: true } }); // closes the socket: CLOSING
      expect(ws.readyState).toBe(2);
      proc.process([[ramp(0), ramp(0)]]); // a whole chunk wakes the loop, which ends
      await settle();
      const after = waits;
      expect(after).toBeGreaterThan(0);
      for (let block = 0; block < 4; block++) proc.process([[ramp(0), ramp(0)]]);
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
