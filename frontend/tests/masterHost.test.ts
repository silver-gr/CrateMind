import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
// Vite supplies this emitted module URL in-app (masterHost imports playbackAudio).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const { stallWatch } = await import("../src/lib/masterHost");
const { nativeAction } = await import("../src/lib/desktopRuntime");

const worklet = readFileSync(new URL("../src/lib/audio/master-tap.worklet.js", import.meta.url), "utf8");

function tap() {
  let Constructor: any;
  class Base { port = { onmessage: (_: unknown) => {} }; }
  new Function("AudioWorkletProcessor", "registerProcessor", worklet)(
    Base, (_name: string, implementation: any) => { Constructor = implementation; },
  );
  const proc = new Constructor();
  const sent: { data: Float32Array; transfer: unknown[] }[] = [];
  let closed = false;
  proc.port.onmessage({ data: { port: { postMessage: (data: Float32Array, transfer: unknown[]) => sent.push({ data, transfer }), close: () => { closed = true; } } } });
  return { proc, sent, closed: () => closed };
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
