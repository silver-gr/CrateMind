import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
// Vite supplies these emitted URLs in-app; the test hands the processor the vendored bytes itself.
mock.module("../src/lib/audio/master-me.worklet.js?worker&url", () => ({ default: "/test/master-me.worklet.js" }));
mock.module("../src/lib/audio/master_me/master_me.wasm?url", () => ({ default: "/test/master_me.wasm" }));
const { MUSIC_GENERAL } = await import("../src/lib/audio/maximizer");
const { DEFAULT_PREFS } = await import("../src/lib/prefs");
import params from "../src/lib/audio/master_me/params.json";

const worklet = readFileSync(new URL("../src/lib/audio/master-me.worklet.js", import.meta.url), "utf8");
const wasm = readFileSync(new URL("../src/lib/audio/master_me/master_me.wasm", import.meta.url));
const RATE = 48000;
const BLOCK = 128;

function processor(): { proc: any; messages: any[] } {
  let Constructor: any;
  const messages: any[] = [];
  class Base { port = { onmessage: (_: unknown) => {}, postMessage: (message: unknown) => { messages.push(structuredClone(message)); } }; }
  new Function("AudioWorkletProcessor", "sampleRate", "registerProcessor", worklet)(
    Base, RATE, (_name: string, implementation: any) => { Constructor = implementation; },
  );
  return { proc: new Constructor(), messages };
}

async function ready(messages: any[]) {
  for (let i = 0; i < 400 && !messages.some(m => m.ready || m.error); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(messages.find(m => m.error)).toBeUndefined();
  expect(messages.some(m => m.ready)).toBe(true);
}

/** Loud stereo: a full-scale kick twice a second over a pad, so the limiters have peaks to catch. */
function loud(block: number) {
  const left = new Float32Array(BLOCK), right = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const n = block * BLOCK + i, t = (n % (RATE / 2)) / RATE;
    const kick = Math.exp(-t * 18) * Math.sin(2 * Math.PI * 55 * t);
    left[i] = kick + 0.3 * Math.sin((2 * Math.PI * 220 * n) / RATE);
    right[i] = kick + 0.3 * Math.sin((2 * Math.PI * 330 * n) / RATE);
  }
  return [left, right];
}

function run(proc: any, seconds: number, input: (block: number) => Float32Array[] = loud) {
  const blocks = Math.round((seconds * RATE) / BLOCK);
  let peak = 0;
  const last: Float32Array[][] = [];
  for (let b = 0; b < blocks; b++) {
    const inp = input(b);
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out]);
    if (b > blocks / 2) for (const channel of out) for (const v of channel) peak = Math.max(peak, Math.abs(v));
    last.splice(0, last.length, inp, out);
  }
  return { peak, last };
}

describe("master_me worklet", () => {
  test("params.json names every symbol the engine sets", () => {
    const symbols = Object.keys(params.params);
    for (const key of [...Object.keys(MUSIC_GENERAL), "target", "brickwall_ceiling", "lufs_out", "limiter_gain_reduction", "brickwall_limit"]) {
      expect(symbols).toContain(key);
    }
    expect(params.size).toBeGreaterThan(0);
  });

  test("passes audio through before the wasm is ready, and copies a mono input to both sides", () => {
    const { proc } = processor();
    const mono = Float32Array.from({ length: BLOCK }, (_, i) => Math.sin(i / 7) * 0.5);
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([[mono]], [out]);
    expect(Array.from(out[0])).toEqual(Array.from(mono));
    expect(Array.from(out[1])).toEqual(Array.from(mono));
    const silent = [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)];
    proc.process([[]], [silent]);
    expect(silent.every(channel => channel.every(v => v === 0))).toBe(true);
  });

  test("a loud input stays under the ceiling, with finite meters and real gain reduction", async () => {
    const { proc, messages } = processor();
    proc.port.onmessage({ data: { wasm, params } });
    // Sent before init() finishes: queued, then applied after it (init resets every parameter).
    proc.port.onmessage({ data: { set: MUSIC_GENERAL } });
    proc.port.onmessage({ data: { set: { target: DEFAULT_PREFS.maximizerTargetDb, brickwall_ceiling: -2 } } });
    await ready(messages);
    const { peak } = run(proc, 6);
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-2 + 0.05);
    expect(peak).toBeGreaterThan(0.5);
    const meters = messages.filter(m => m.meters).map(m => m.meters);
    expect(meters.length).toBeGreaterThan(100);
    for (const m of meters) for (const value of Object.values(m)) expect(Number.isFinite(value)).toBe(true);
    expect(Math.min(...meters.map(m => m.limiterDb + m.brickwallDb))).toBeLessThan(-1);
    expect(meters.at(-1).lufsOut).toBeGreaterThan(-30);
  }, 30_000);

  test("inactive passes audio through untouched and sends no meters; non-finite input never reaches the DSP", async () => {
    const { proc, messages } = processor();
    proc.port.onmessage({ data: { wasm, params } });
    await ready(messages);
    const poisoned = run(proc, 0.5, b => {
      const [left, right] = loud(b);
      left[3] = NaN; right[5] = Infinity;
      return [left, right];
    });
    expect(Number.isFinite(poisoned.peak)).toBe(true);
    expect(poisoned.peak).toBeGreaterThan(0);
    expect(Number.isFinite(run(proc, 0.2).peak)).toBe(true);
    proc.port.onmessage({ data: { active: false } });
    const count = messages.length;
    const { last: [input, output] } = run(proc, 0.5);
    expect(Array.from(output[0])).toEqual(Array.from(input[0]));
    expect(Array.from(output[1])).toEqual(Array.from(input[1]));
    expect(messages.length).toBe(count);
    proc.port.onmessage({ data: { active: true } });
    const { peak } = run(proc, 1);
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0);
  }, 30_000);
});

describe("maximizer prefs", () => {
  test("off by default, −9 LUFS target and a −1 dB ceiling", () => {
    expect(DEFAULT_PREFS.maximizer).toBe(false);
    expect(DEFAULT_PREFS.maximizerTargetDb).toBe(-9);
    expect(DEFAULT_PREFS.maximizerCeilingDb).toBe(-1);
  });
});
