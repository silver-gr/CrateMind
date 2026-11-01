import { afterAll, describe, expect, jest, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
// Bun tests the DSP/graph directly; Vite supplies this emitted module URL in-app.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const {
  configurePlayback, disposePlayback, hasPlaybackGraph, preparePlayback,
  resetLimiter, setPlaybackVolume, setPlaybackTone, unlockPlaybackAudio, playbackProcessingStatus,
} = await import("../src/lib/playbackAudio");

import { PeakLimiterDSP } from "../src/lib/audio/peak-limiter-core.js";

const worklet = readFileSync(new URL("../src/lib/audio/peak-limiter.worklet.js", import.meta.url), "utf8");
const ceiling = 10 ** (-1 / 20);

function processor(rate: number): any {
  let Constructor: any;
  class Base { port = { onmessage: (_: unknown) => {}, postMessage: (_: unknown) => {} }; }
  new Function("PeakLimiterDSP", "AudioWorkletProcessor", "sampleRate", "registerProcessor", worklet.replace(/^import[^\n]*\n/, ""))(
    PeakLimiterDSP, Base, rate, (_name: string, implementation: any) => { Constructor = implementation; },
  );
  return new Constructor();
}

function render(processor: any, left: Float32Array, right: Float32Array, block = 128) {
  const outputL = new Float32Array(left.length);
  const outputR = new Float32Array(left.length);
  for (let start = 0; start < left.length; start += block) {
    const end = Math.min(left.length, start + block);
    processor.process([[left.subarray(start, end), right.subarray(start, end)]],
      [[outputL.subarray(start, end), outputR.subarray(start, end)]]);
  }
  return [outputL, outputR];
}

describe("sample peak limiter", () => {
  test.each([44100, 48000, 96000])("preserves quiet stereo after exactly 5ms lookahead at %i Hz", rate => {
    const limiter = processor(rate);
    const left = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i * 0.12) * 0.2);
    const right = Float32Array.from(left, x => -x * 0.5);
    const [outL, outR] = render(limiter, left, right, 73);
    for (let i = 0; i < left.length; i++) {
      expect(outL[i]).toBe(i < limiter.dsp.delay ? 0 : left[i - limiter.dsp.delay]);
      expect(outR[i]).toBe(i < limiter.dsp.delay ? 0 : right[i - limiter.dsp.delay]);
    }
  });

  test.each([44100, 48000, 96000])("bounds impulses and asymmetric stereo without changing stereo ratios at %i Hz", rate => {
    const limiter = processor(rate);
    const left = Float32Array.from({ length: 10000 }, (_, i) => i % 503 === 0 ? 8 : 1.7 * Math.sin(i * 0.23));
    const right = Float32Array.from(left, x => x * -0.25);
    const [outL, outR] = render(limiter, left, right);
    let peak = 0;
    for (let i = 0; i < outL.length; i++) {
      peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
      expect(Math.abs(outR[i] + outL[i] * 0.25)).toBeLessThan(1e-7);
    }
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-7);
    expect(limiter.dsp.count).toBeLessThanOrEqual(limiter.dsp.delay + 1);
  });

  test("resets stale buffered audio, tolerates disconnected input and nonfinite samples", () => {
    const limiter = processor(48000);
    render(limiter, new Float32Array(128).fill(4), new Float32Array(128).fill(2));
    limiter.port.onmessage({ data: { type: "reset" } });
    const empty = [new Float32Array(513), new Float32Array(513)];
    limiter.process([[]], [empty]);
    expect(empty.every(channel => channel.every(x => x === 0))).toBe(true);
    const [outL, outR] = render(limiter,
      new Float32Array([NaN, Infinity, -Infinity, ...new Array(1000).fill(0)]),
      new Float32Array(1003));
    expect(outL.every(Number.isFinite)).toBe(true);
    expect(outR.every(Number.isFinite)).toBe(true);
  });

  test("recovers toward unity smoothly after a peak", () => {
    const limiter = processor(48000);
    const input = new Float32Array(48000).fill(0.1);
    input[1000] = 8;
    const [out] = render(limiter, input, input);
    expect(out[2000]).toBeLessThan(0.08);
    expect(out[47999]).toBeCloseTo(0.1, 5);
  });

  test("handles mono and a full monotonic peak queue with bounded storage", () => {
    const limiter = processor(48000);
    const mono = Float32Array.from({ length: 3000 }, (_, i) => 0.5 - i / 10000);
    const output = [new Float32Array(3000), new Float32Array(3000)];
    limiter.process([[mono]], [output]);
    expect(limiter.dsp.count).toBe(limiter.dsp.delay + 1);
    expect(output[0]).toEqual(output[1]);
    for (let i = limiter.dsp.delay; i < mono.length; i++) expect(output[0][i]).toBe(mono[i - limiter.dsp.delay]);
  });
});

class Parameter {
  value = 1;
  mode = "initial";
  cancelAndHoldAtTime() {}
  setValueAtTime(value: number, time = 0) { if (time > 0) this.events.push(["snap", value, time]); else { this.value = value; this.mode = "immediate"; } }
  linearRampToValueAtTime(value: number) { this.value = value; this.mode = "ramp"; }
  cancelScheduledValues() { this.events = []; }
  setTargetAtTime(value: number, _time: number, constant: number) { this.events.push(["target", value, constant]); }
  events: unknown[][] = [];
}
class Biquad extends Node {
  type = "";
  frequency = new Parameter();
  Q = new Parameter();
}
class Node {
  connections: unknown[] = [];
  disconnects = 0;
  gain = new Parameter();
  connect(node: unknown) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; this.disconnects++; }
}
class Context {
  state = "suspended";
  resumeAllowed = true;
  currentTime = 0;
  sampleRate = 48000;
  scripts: ScriptProcessor[] = [];
  scriptUnsupported = false;
  destination = {};
  sources = 0;
  gains: Node[] = [];
  filters: Biquad[] = [];
  listeners = new Map<string, () => void>();
  pendingModule: (() => void) | null = null;
  rejectModule: ((error: Error) => void) | null = null;
  audioWorklet = { addModule: (_url: string) => new Promise<void>((resolve, reject) => {
    this.pendingModule = resolve; this.rejectModule = reject;
  }) };
  constructor() { contexts.push(this); }
  async resume() { if (this.resumeAllowed) this.setState("running"); }
  setState(state: string) { this.state = state; this.listeners.get("statechange")?.(); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  createBiquadFilter() { const node = new Biquad(); this.filters.push(node); return node; }
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number) {
    if (this.scriptUnsupported) throw new Error("No compatible processor");
    expect([bufferSize, inputChannels, outputChannels]).toEqual([1024, 2, 2]);
    const node = new ScriptProcessor(); this.scripts.push(node); return node;
  }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createMediaElementSource() { this.sources++; return new Node(); }
}
class ScriptProcessor extends Node {
  onaudioprocess: ((event: any) => void) | null = null;
  render(left: Float32Array, right = left) {
    const output = [new Float32Array(left.length), new Float32Array(left.length)];
    this.onaudioprocess?.({
      inputBuffer: { numberOfChannels: 2, getChannelData: (channel: number) => [left, right][channel] },
      outputBuffer: { numberOfChannels: 2, getChannelData: (channel: number) => output[channel] },
    });
    return output;
  }
}
const contexts: Context[] = [];
const worklets: Worklet[] = [];
class Worklet extends Node {
  onprocessorerror?: () => void;
  resets = 0;
  port = { postMessage: () => { this.resets++; }, onmessage: null as null | ((event: any) => void) };
  constructor() { super(); worklets.push(this); }
}
const originalContext = globalThis.AudioContext;
const originalWorklet = globalThis.AudioWorkletNode;
afterAll(() => {
  globalThis.AudioContext = originalContext;
  globalThis.AudioWorkletNode = originalWorklet;
});

test("graph lifecycle keeps one source, ignores stale loads, replaces failed worklets and preserves master", async () => {
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = Worklet as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.4, muted: false }) as HTMLAudioElement;
  await configurePlayback(audio, { gainDb: -6, limiterEnabled: false });
  expect(hasPlaybackGraph(audio)).toBe(false);
  await unlockPlaybackAudio();
  await preparePlayback(audio);
  const context = contexts[0];
  const [gain, master] = context.gains;
  const [lo, , , , lp] = context.filters;
  expect(master.gain.value).toBe(0.4);
  expect(gain.gain.value).toBeCloseTo(10 ** (-6 / 20));
  expect(gain.gain.mode).toBe("ramp");
  expect(audio.volume).toBe(1);
  setPlaybackVolume(audio, 0);
  expect(master.gain.value).toBe(0);
  expect(audio.volume).toBe(1);

  const stale = configurePlayback(audio, { gainDb: 12, limiterEnabled: true });
  await configurePlayback(audio, { gainDb: 0, limiterEnabled: false, immediate: true });
  context.pendingModule?.();
  expect(await stale).toBe(false);
  expect(worklets.length).toBe(0);
  expect(gain.gain.value).toBe(1);
  expect(gain.gain.mode).toBe("immediate");
  expect(gain.connections).toEqual([lo]);
  expect(lp.connections).toEqual([master]);

  let processingUpdates = 0;
  audio.addEventListener("cratemind-processing-change", () => { processingUpdates++; });
  expect(await configurePlayback(audio, { gainDb: 3, limiterEnabled: true })).toBe(true);
  expect(processingUpdates).toBe(1);
  expect(lp.connections).toEqual([worklets[0]]);
  expect(worklets[0].connections).toEqual([master]);
  expect(playbackProcessingStatus(audio).limiterReady).toBe(false);
  worklets[0].port.onmessage?.({ data: { type: "ready" } });
  expect(playbackProcessingStatus(audio).limiterReady).toBe(true);
  resetLimiter(audio);
  expect(worklets[0].resets).toBe(1);
  worklets[0].onprocessorerror?.();
  expect(processingUpdates).toBe(3);
  expect(lp.connections).toEqual([context.scripts[0]]);
  expect(playbackProcessingStatus(audio).limiterReady).toBe(false);
  context.scripts[0].render(new Float32Array(1024));
  expect(playbackProcessingStatus(audio)).toEqual({ active: true, limiterReady: true,
    limiterUnavailable: false, limiterEngine: "compatibility" });
  expect(await configurePlayback(audio, { gainDb: 0, limiterEnabled: true })).toBe(true);

  disposePlayback(audio);
  await preparePlayback(audio);
  expect(context.sources).toBe(1);
  expect(lp.connections).toEqual([context.scripts[0]]);
  expect(master.gain.value).toBe(0);
  expect(hasPlaybackGraph(audio)).toBe(true);

  const detached = { volume: 0.2, muted: false } as HTMLAudioElement;
  const pendingPrepare = preparePlayback(detached);
  disposePlayback(detached);
  await pendingPrepare;
  expect(hasPlaybackGraph(detached)).toBe(false);
  expect(context.sources).toBe(1);

  const blocked = { volume: 0.7, muted: false } as HTMLAudioElement;
  context.state = "suspended";
  context.resumeAllowed = false;
  await preparePlayback(blocked);
  expect(hasPlaybackGraph(blocked)).toBe(false);
  expect(blocked.volume).toBe(0.7);
  context.resumeAllowed = true;
  await preparePlayback(blocked);
  expect(hasPlaybackGraph(blocked)).toBe(true);
  expect(context.sources).toBe(2);
});

test("a stalled worklet load starts compatible processing after 1.5 seconds and preserves gain/master", async () => {
  const playback = await import("../src/lib/playbackAudio.ts?loading-timeout");
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = Worklet as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.4, muted: false }) as HTMLAudioElement;
  await playback.configurePlayback(audio, { gainDb: -72, limiterEnabled: false });
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  const [gain, master] = context.gains;
  const workletCount = worklets.length;
  let updates = 0;
  audio.addEventListener("cratemind-processing-change", () => { updates++; });
  jest.useFakeTimers();
  try {
    const pending = playback.configurePlayback(audio, { gainDb: -6, limiterEnabled: true });
    let settled = false;
    void pending.then(() => { settled = true; });
    jest.advanceTimersByTime(1499);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await pending).toBe(true);
    expect(playback.playbackProcessingStatus(audio)).toEqual({ active: true, limiterReady: false,
      limiterUnavailable: false, limiterEngine: "compatibility" });
    expect(context.filters[4].connections).toEqual([context.scripts[0]]);
    expect(context.scripts[0].connections).toEqual([master]);
    expect(master.connections).toEqual([context.destination]);
    expect(gain.gain.value).toBeCloseTo(10 ** (-6 / 20));
    expect(master.gain.value).toBe(0.4);
    expect(updates).toBe(1);
    const input = new Float32Array(1024).fill(4);
    const [limited] = context.scripts[0].render(input);
    expect(Math.max(...limited.map(Math.abs))).toBeLessThanOrEqual(ceiling + 1e-7);
    expect(limited.some(x => x > 0.8)).toBe(true);
    expect(playback.playbackProcessingStatus(audio).limiterReady).toBe(true);
    // A later browser completion cannot attach processing after the bounded load failed.
    context.pendingModule?.();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
    expect(worklets.length).toBe(workletCount);
    await playback.preparePlayback(audio);
    expect(context.sources).toBe(1);
  } finally { jest.useRealTimers(); }
});

test("a stale rejected worklet load cannot reroute or notify a newer disabled configuration", async () => {
  const playback = await import("../src/lib/playbackAudio.ts?stale-loading-error");
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = Worklet as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.3, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  const [gain, master] = context.gains;
  let updates = 0;
  audio.addEventListener("cratemind-processing-change", () => { updates++; });
  const stale = playback.configurePlayback(audio, { gainDb: 12, limiterEnabled: true });
  await playback.configurePlayback(audio, { gainDb: -72, limiterEnabled: false, immediate: true });
  const disconnects = gain.disconnects;
  context.rejectModule?.(new Error("Late worklet fetch failure"));
  expect(await stale).toBe(false);
  expect(gain.disconnects).toBe(disconnects);
  expect(context.filters[4].connections).toEqual([master]);
  expect(gain.gain.value).toBe(10 ** (-72 / 20));
  expect(updates).toBe(0);
});

test.each([44100, 48000, 96000])("compatible callback processes quiet audio, limits stereo peaks, resets and bypasses at %i Hz", async rate => {
  const playback = await import(`../src/lib/playbackAudio.ts?compatible-${rate}`);
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = undefined as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.7, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  context.sampleRate = rate;
  expect(await playback.configurePlayback(audio, { gainDb: 12, limiterEnabled: true })).toBe(true);
  const compatible = context.scripts[0];
  const [gain, master] = context.gains;
  const delay = Math.round(rate * 0.005);
  expect(playback.playbackProcessingStatus(audio).limiterReady).toBe(false);
  expect(context.filters[4].connections).toEqual([compatible]);
  expect(compatible.connections).toEqual([master]);
  const quietL = Float32Array.from({ length: 1024 }, (_, i) => 0.2 * Math.sin(i * 0.1));
  const quietR = Float32Array.from(quietL, x => -0.5 * x);
  const quiet = compatible.render(quietL, quietR);
  for (let i = 0; i < quietL.length; i++) {
    expect(quiet[0][i]).toBe(i < delay ? 0 : quietL[i - delay]);
    expect(quiet[1][i]).toBe(i < delay ? 0 : quietR[i - delay]);
  }
  expect(playback.playbackProcessingStatus(audio).limiterReady).toBe(true);
  playback.resetLimiter(audio);
  // The exact same core output is used in the worklet and compatibility callbacks.
  const reference = processor(rate);
  let peak = 0;
  for (let block = 0; block < 8; block++) {
    const left = Float32Array.from({ length: 1024 }, (_, i) => i % 503 === 0 ? 8 : Math.sin(i * 0.37) * 2);
    const right = Float32Array.from(left, x => x * -0.25);
    const output = compatible.render(left, right);
    expect(output).toEqual(render(reference, left, right, 1024));
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(output[0][i]), Math.abs(output[1][i]));
      expect(Math.abs(output[1][i] + output[0][i] * 0.25)).toBeLessThan(1e-7);
    }
  }
  expect(peak).toBeGreaterThan(0.8);
  expect(peak).toBeLessThanOrEqual(ceiling + 1e-7);
  playback.resetLimiter(audio);
  expect(compatible.render(new Float32Array(1024)).every(channel => channel.every(x => x === 0))).toBe(true);
  await playback.configurePlayback(audio, { gainDb: 0, limiterEnabled: false, immediate: true });
  expect(context.filters[4].connections).toEqual([master]);
  expect(gain.gain.value).toBe(1);
  expect(compatible.connections).toEqual([]);
  expect(playback.playbackProcessingStatus(audio).limiterReady).toBe(false);
  // Even a previously queued main-thread callback cannot replay buffered audio after bypass.
  expect(compatible.render(new Float32Array(1024).fill(8)).every(channel => channel.every(x => x === 0))).toBe(true);
  await playback.configurePlayback(audio, { gainDb: 0, limiterEnabled: true });
  expect(compatible.render(new Float32Array(1024)).every(channel => channel.every(x => x === 0))).toBe(true);
  playback.disposePlayback(audio);
});

test.each(["disable", "dispose"])("a stalled worklet cannot install a compatible node after %s", async operation => {
  const playback = await import(`../src/lib/playbackAudio.ts?compatible-race-${operation}`);
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = Worklet as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.5, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  const [gain, master] = context.gains;
  let updates = 0;
  audio.addEventListener("cratemind-processing-change", () => { updates++; });
  jest.useFakeTimers();
  try {
    const pending = playback.configurePlayback(audio, { gainDb: 12, limiterEnabled: true });
    if (operation === "disable") await playback.configurePlayback(audio, { gainDb: 0, limiterEnabled: false });
    else playback.disposePlayback(audio);
    const disconnects = gain.disconnects;
    jest.advanceTimersByTime(1500);
    expect(await pending).toBe(false);
    expect(context.scripts).toHaveLength(0);
    expect(gain.disconnects).toBe(disconnects);
    expect(context.filters[4].connections).toEqual(operation === "disable" ? [master] : []);
    expect(updates).toBe(0);
    context.pendingModule?.();
    await Promise.resolve();
    expect(context.scripts).toHaveLength(0);
    // A deliberate new configuration is allowed to use the fallback after the stale request.
    if (operation === "dispose") await playback.preparePlayback(audio);
    else await playback.configurePlayback(audio, { gainDb: 0, limiterEnabled: true });
    expect(context.scripts).toHaveLength(1);
    expect(context.filters[4].connections).toEqual([context.scripts[0]]);
  } finally { jest.useRealTimers(); }
});

test("both unavailable engines retain an audible normalization bypass and report no limiter", async () => {
  const playback = await import("../src/lib/playbackAudio.ts?no-engines");
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = undefined as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.8, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  context.scriptUnsupported = true;
  expect(await playback.configurePlayback(audio, { gainDb: -6, limiterEnabled: true })).toBe(false);
  const [gain, master] = context.gains;
  expect(context.filters[4].connections).toEqual([master]);
  expect(master.connections).toEqual([context.destination]);
  expect(gain.gain.value).toBeCloseTo(10 ** (-6 / 20));
  expect(playback.playbackProcessingStatus(audio)).toEqual({ active: true, limiterReady: false,
    limiterUnavailable: true, limiterEngine: null });
});

// Filters are indexed from the context's list: [lo, mid, hi, hp, lp] per graph.
test.each([["worklet", Worklet], ["compatibility", undefined], ["bypass", null]])("route puts gain -> lo -> mid -> hi -> hp -> lp before the limiter (%s)", async (mode, engine) => {
  const playback = await import(`../src/lib/playbackAudio.ts?route-${mode}`);
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = (engine ?? undefined) as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.5, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  const [gain, master] = context.gains;
  const [lo, mid, hi, hp, lp] = context.filters;
  const limited = mode !== "bypass";
  if (limited) {
    const loading = playback.configurePlayback(audio, { gainDb: 0, limiterEnabled: true });
    context.pendingModule?.();
    await loading;
  }
  expect(gain.connections).toEqual([lo]);
  expect(lo.connections).toEqual([mid]);
  expect(mid.connections).toEqual([hi]);
  expect(hi.connections).toEqual([hp]);
  expect(hp.connections).toEqual([lp]);
  const limiter = mode === "worklet" ? worklets.at(-1)! : context.scripts.at(-1)!;
  expect(lp.connections).toEqual(limited ? [limiter] : [master]);
  if (limited) expect(limiter.connections).toEqual([master]);
  expect([lo.type, mid.type, hi.type, hp.type, lp.type]).toEqual(["lowshelf", "peaking", "highshelf", "highpass", "lowpass"]);
  expect([mid.Q.value, hp.Q.value, lp.Q.value]).toEqual([0.7, -3.0103, -3.0103]);
  playback.disposePlayback(audio);
  for (const node of [gain, lo, mid, hi, hp, lp]) expect(node.connections).toEqual([]);
});

test("a tone set before the graph exists is applied when it is created; later changes ramp, neutral filter snaps", async () => {
  const playback = await import("../src/lib/playbackAudio.ts?tone");
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = undefined as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.5, muted: false }) as HTMLAudioElement;
  expect(playback.setPlaybackTone(audio, { eq: { hi: 1, mid: -1, lo: 0 }, filter: -1 })).toBe(false);
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  const [lo, mid, hi, hp, lp] = context.filters;
  expect([hi.gain.value, mid.gain.value, lo.gain.value]).toEqual([6, -26, 0]);
  expect(lp.frequency.value).toBeCloseTo(60);
  expect(hp.frequency.value).toBe(0);
  expect(playback.setPlaybackTone(audio, { eq: { hi: 0, mid: 0, lo: -0.5 }, filter: 0 })).toBe(true);
  expect(lo.gain.events).toEqual([["target", -13, 0.015]]);
  expect(lp.frequency.events).toEqual([["target", 24000, 0.015], ["snap", 24000, 0.1]]);
  expect(hp.frequency.events).toEqual([["target", 0, 0.015], ["snap", 0, 0.1]]);
  expect(hi.gain.events).toEqual([["target", 0, 0.015]]);
});

test("a context that suspends is resumed on statechange", async () => {
  const playback = await import("../src/lib/playbackAudio.ts?statechange");
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = undefined as unknown as typeof AudioWorkletNode;
  const audio = Object.assign(new EventTarget(), { volume: 0.5, muted: false }) as HTMLAudioElement;
  await playback.preparePlayback(audio);
  const context = contexts.at(-1)!;
  expect(context.state).toBe("running");
  context.setState("suspended");
  await Promise.resolve();
  expect(context.state).toBe("running");
  // A pending (never-settling) resume must not throw or loop.
  context.resume = () => new Promise<void>(() => {});
  context.setState("suspended");
  expect(context.state).toBe("suspended");
  expect(playback.hasPlaybackGraph(audio)).toBe(true);
});
