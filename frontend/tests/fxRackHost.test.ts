import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
// Vite supplies these emitted module URLs in-app (the host imports playbackAudio; its loader imports the rack worklet).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
mock.module("../src/lib/fxRack/fx-rack.worklet.js?worker&url", () => ({ default: "/test/fx-rack.worklet.js" }));
const playback = await import("../src/lib/playbackAudio");
const transportModule = await import("../src/lib/mix/deckTransport");
const { toast } = await import("sonner");
const { deckInput } = await import("../src/lib/audio/masterBus");
const { engage, getFxRack, paddle, release, resetFxRack, selectPreset, setAmount, setBeats, setPhraseRelease } = await import("../src/lib/fxRack");
const { resetPrefs } = await import("../src/lib/prefs");
const { setDeckKeylock } = await import("../src/lib/mixer");
const { FX_RACK_NODE_OPTIONS, FX_RACK_PROCESSOR } = await import("../src/lib/fxRack/types");
import type { Anchor, EngineLoop } from "../src/lib/audio/stretchDeck";
import type { BeatGrid } from "../src/lib/beatGrid";
import type { DeckTransport } from "../src/lib/mix/deckTransport";
import type { MediaLike } from "../src/lib/media";

const FS = 48000;
const P = 60 / 145;
const straight: BeatGrid = { kind: "straight", anchor: 0, period: P, estimated: false, overridden: false };

class Param { constructor(public value = 0) {} }
class FakeNode {
  connections: unknown[] = [];
  connect(node: unknown) { this.connections.push(node); return node; }
  disconnect(node?: unknown) { this.connections = node === undefined ? [] : this.connections.filter(other => other !== node); }
}
class FakeGain extends FakeNode { gain = new Param(1); }
let racks: FakeRack[] = [];
class FakeRack extends FakeNode {
  sent: any[] = [];
  parameters = new Map([["amount", new Param(0)], ["fader", new Param(1)]]);
  port = { postMessage: (message: unknown) => { this.sent.push(message); }, onmessage: null as null | ((event: { data: unknown }) => void) };
  onprocessorerror: (() => void) | null = null;
  constructor(public ctx: unknown, public name: string, public options: unknown) { super(); racks.push(this); }
  of(t: string) { return this.sent.filter(message => message.t === t); }
  last(t: string) { return this.of(t).at(-1); }
  emit(data: unknown) { this.port.onmessage?.({ data }); }
}
class FakeContext {
  currentTime = 1;
  sampleRate = FS;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = new FakeNode();
  modules: string[] = [];
  module: Promise<void> = Promise.resolve();
  audioWorklet = { addModule: (url: string) => { this.modules.push(url); return this.module; } };
  createGain() { return new FakeGain(); }
}
class FakeEngine extends EventTarget {
  anchor: Anchor = { input: 10, output: 0.5, rate: 1, active: true };
  loop: EngineLoop | null = null;
  get clock() { return { anchor: this.anchor, loop: this.loop }; }
}

const transports: Partial<Record<"A" | "B", DeckTransport>> = {};
function transport(media: EventTarget | null, o: Partial<DeckTransport> = {}): DeckTransport {
  const onEngine = media instanceof FakeEngine;
  return {
    trackId: 1, engine: onEngine ? media as never : null, media: media as MediaLike | null, onEngine, ready: true, playing: true,
    rate: 1, position: () => 0, duration: 300, grid: straight, cues: [], bpm: 145,
    play: () => {}, pause: () => {}, seekTo: () => {}, ...o,
  };
}

let binds: [unknown, unknown][] = [];
/** setPlaybackBus and setPlaybackInsert calls, in order. */
let wiring: [string, unknown, unknown][] = [];
let latency = 0;
let errors: unknown[] = [];
const spies: { mockRestore(): void }[] = [];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function setup(name: string) {
  const ctx = new FakeContext();
  spies.push(
    spyOn(playback, "playbackContext").mockImplementation(() => ctx as unknown as AudioContext),
    spyOn(playback, "setPlaybackInsert").mockImplementation((media, insert) => { binds.push([media, insert]); wiring.push(["insert", media, insert]); }),
    spyOn(playback, "setPlaybackBus").mockImplementation((media, node) => { wiring.push(["bus", media, node]); }),
    spyOn(playback, "playbackLatency").mockImplementation(() => latency),
    spyOn(transportModule, "deckTransportOf").mockImplementation(deck => transports[deck] ?? null),
    spyOn(toast, "error").mockImplementation(message => { errors.push(message); return 0; }),
  );
  const host = await import(`../src/lib/fxRackHost.ts?${name}`);
  return { ctx, host, rack: () => racks };
}

const originalWorkletNode = globalThis.AudioWorkletNode;
let stop: (() => void) | null = null;
beforeEach(() => {
  resetPrefs();
  resetFxRack();
  racks = [];
  binds = [];
  wiring = [];
  errors = [];
  latency = 0;
  delete transports.A;
  delete transports.B;
  globalThis.AudioWorkletNode = FakeRack as unknown as typeof AudioWorkletNode;
  jest.useFakeTimers();
});
afterEach(() => {
  stop?.();
  stop = null;
  spies.splice(0).forEach(spy => spy.mockRestore());
  jest.useRealTimers();
  setDeckKeylock("A", false);
  resetFxRack();
  globalThis.AudioWorkletNode = originalWorkletNode;
});

async function started(name: string) {
  const s = await setup(name);
  await s.host.startFxRack();
  stop = s.host.stopFxRack;
  return s;
}

describe("loading and binding", () => {
  test("loads the module once, puts one node per deck before the bus, binds once per media and unbinds first on a swap", async () => {
    const element = new EventTarget();
    transports.A = transport(element, { rate: 1 });
    const { ctx, host } = await started("bind");
    expect(ctx.modules).toEqual(["/test/fx-rack.worklet.js"]);
    expect(racks.map(node => [node.name, node.options])).toEqual([[FX_RACK_PROCESSOR, FX_RACK_NODE_OPTIONS], [FX_RACK_PROCESSOR, FX_RACK_NODE_OPTIONS]]);
    const [a] = racks;
    const insert = binds[0][1] as { input: FakeNode; output: FakeNode; fader: Param };
    expect(binds).toEqual([[element, insert]]);
    expect(insert.input.connections).toEqual([a]);
    expect(a.connections).toEqual([insert.output]);
    expect(insert.output.connections).toEqual([deckInput(ctx as unknown as BaseAudioContext, "A")]);
    expect(insert.fader).toBe(a.parameters.get("fader")!);
    expect(a.parameters.get("amount")!.value).toBe(0.7);
    expect(a.sent.map(message => message.t)).toEqual(["preset", "clock", "track"]);
    expect(a.of("preset")).toEqual([{ t: "preset", id: "polyrhythmic-delay", beats: 0 }]);
    host.pollFxRack();
    host.pollFxRack();
    expect(binds).toHaveLength(1);
    // Element → engine: the element is unbound before the engine is bound.
    const engine = new FakeEngine();
    transports.A = transport(engine);
    host.pollFxRack();
    expect(binds).toEqual([[element, insert], [element, null], [engine, insert]]);
    host.pollFxRack();
    expect(binds).toHaveLength(3);
    setAmount("A", 0.25);
    expect(a.parameters.get("amount")!.value).toBe(0.25);
  });

  test("a slow load retries when it ends; a failed one makes the rack unavailable", async () => {
    let finish!: () => void;
    const slow = await setup("slow");
    slow.ctx.module = new Promise<void>(resolve => { finish = resolve; });
    const pending = slow.host.startFxRack();
    stop = slow.host.stopFxRack;
    await flush();
    jest.advanceTimersByTime(1500);
    await pending;
    expect(racks).toHaveLength(0);
    expect(getFxRack().available).toBe(true);
    finish();
    await flush();
    await flush();
    expect(racks).toHaveLength(2);

    spies.splice(0).forEach(spy => spy.mockRestore());
    racks = [];
    const broken = await setup("broken");
    broken.ctx.module = Promise.reject(new Error("404"));
    await broken.host.startFxRack();
    expect(racks).toHaveLength(0);
    expect(getFxRack().available).toBe(false);
    expect(errors).toEqual(["Τα εφέ δεν είναι διαθέσιμα."]);
  });
});

describe("clock", () => {
  test("is posted only when an input changes: nudge (no seek), seek, latency, grid, BPM", async () => {
    const engine = new FakeEngine();
    transports.A = transport(engine);
    const { ctx, host } = await started("clock");
    const [a] = racks;
    expect(a.of("clock")).toHaveLength(1);
    expect(a.last("clock")).toMatchObject({ validFrom: Math.round(0.5 * FS), playing: true, bpm: 145, rate: 1, trusted: true, seek: false });
    ctx.currentTime = 2;
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(1);
    // A Sync nudge re-anchors without a seeking event.
    engine.anchor = { input: 11.52, output: 2.2, rate: 1, active: true };
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(2);
    expect(a.last("clock")).toMatchObject({ validFrom: Math.round(2.2 * FS), seek: false });
    // A seek: the media fires `seeking`.
    engine.anchor = { input: 60, output: 2.4, rate: 1, active: true };
    engine.dispatchEvent(new Event("seeking"));
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(3);
    expect(a.last("clock").seek).toBe(true);
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(3);
    latency = 0.005;
    host.pollFxRack();
    expect(a.last("clock").validFrom).toBe(Math.round(2.405 * FS));
    transports.A = { ...transports.A!, grid: { ...straight, anchor: P / 2 } }; // a downbeat edit
    host.pollFxRack();
    transports.A = { ...transports.A!, bpm: 146 };
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(6);
    expect(a.last("clock").bpm).toBe(146);
    transports.A = { ...transports.A!, playing: false };
    host.pollFxRack(); // the engine's own anchor says whether it plays
    expect(a.of("clock")).toHaveLength(6);
  });

  test("a list grid gets more knots during steady playback once 4 or fewer beats are left", async () => {
    const times = Array.from({ length: 200 }, (_, i) => i * 0.4);
    const engine = new FakeEngine();
    engine.anchor = { input: 4, output: 1, rate: 1, active: true };
    transports.A = transport(engine, { grid: { kind: "list", times, downIndex: 0, estimated: false, overridden: false } });
    const { ctx, host } = await started("list");
    const [a] = racks;
    expect(a.last("clock").knots).toHaveLength(18);
    const at = (beats: number) => { ctx.currentTime = 1 + beats * 0.4; host.pollFxRack(); return a.of("clock").length; };
    expect(at(1)).toBe(1);
    expect(at(3.9)).toBe(1);
    expect(at(4.05)).toBe(2);
    expect(a.last("clock").knots[1]).toBeCloseTo(10 + 4.05, 4);
    expect(at(5)).toBe(2);
  });

  test("a loop wrap posts W; the element deck gets knots null with its BPM", async () => {
    const engine = new FakeEngine();
    engine.anchor = { input: 16 * P, output: 1, rate: 1, active: true };
    engine.loop = { start: 16 * P, end: 20 * P };
    transports.A = transport(engine);
    const element = new EventTarget();
    transports.B = transport(element, { bpm: 128 });
    const { ctx, host } = await started("wrap");
    const [a, b] = racks;
    expect(a.of("clock")).toHaveLength(1);
    ctx.currentTime = 1 + 4 * P + 0.05; // just past the first wrap
    host.pollFxRack();
    expect(a.of("clock")).toHaveLength(2);
    expect(a.last("clock").knots[1]).toBeCloseTo(16 + 4 + 0.05 / P, 4); // B at the rounded frame
    expect(b.of("clock")).toEqual([{ t: "clock", validFrom: FS, playing: true, knots: null, bpm: 128, rate: 1, trusted: false, seek: false }]);
    transports.B = { ...transports.B!, playing: false };
    host.pollFxRack();
    expect(b.of("clock")).toHaveLength(2);
    expect(b.last("clock").playing).toBe(false);
  });

  test("leaving a ½ b or 1 b loop puts B back on the track's bars, and re-sends a pending Φ target", async () => {
    for (const [name, beats] of [["half", 0.5], ["one", 1]] as const) {
      const engine = new FakeEngine();
      // A loop started at the playhead, off the bar: beat 17.25.
      const start = 17.25 * P, end = start + beats * P;
      engine.anchor = { input: start, output: 1, rate: 1, active: true };
      engine.loop = { start, end };
      transports.A = transport(engine);
      const { ctx, host } = await started(`snap-${name}`);
      const [a] = racks;
      selectPreset("A", "lift");
      setBeats("A", 3); // Φ: its ramp end is posted at engage, looping too
      engage("A", "latch");
      const before = a.of("release").length;
      // Three wraps and a bit, then the loop ends (not slip): the track resumes from inside the loop window.
      const t = 1 + 3.3 * beats * P;
      ctx.currentTime = t;
      host.pollFxRack();
      const input = start + 0.3 * beats * P;
      engine.loop = null;
      engine.anchor = { input, output: t, rate: 1, active: true };
      ctx.currentTime = t + 0.01;
      host.pollFxRack();
      const [f, b] = a.last("clock").knots;
      const off = (b - (input + (f / FS - t)) / P) % 4;
      expect({ name, off: Math.min(Math.abs(off), 4 - Math.abs(off)) < 1e-3 }).toEqual({ name, off: true });
      // B moved with the snap, so the Φ target goes again, on the next phrase line in the new B.
      expect(a.of("release")).toHaveLength(before + 1);
      const sent = a.last("release").atBeat;
      expect({ name, sent: Number.isInteger(sent) && sent % 4 === 0 && sent > b }).toEqual({ name, sent: true });
      stop?.();
      stop = null;
      spies.splice(0).forEach(spy => spy.mockRestore());
      racks = [];
    }
  });
});

test("track follows the key, getMixer()'s keylock and the engine", async () => {
  const engine = new FakeEngine();
  transports.A = transport(engine);
  const { host } = await started("keylock");
  const [a] = racks;
  expect(a.last("track")).toEqual({ t: "track", rootPc: null, minor: false, keylock: false });
  host.setFxRackKey("A", { pc: 9, minor: true });
  setDeckKeylock("A", true);
  host.pollFxRack();
  // Same track: the key arriving and a key-lock toggle must not reset the capture ring.
  expect(a.last("track")).toEqual({ t: "track", rootPc: 9, minor: true, keylock: true, keep: true });
  host.pollFxRack();
  expect(a.of("track")).toHaveLength(2);
  transports.A = transport(new EventTarget()); // the element cannot key lock
  host.pollFxRack();
  expect(a.last("track").keylock).toBe(false);
});

describe("engage and release", () => {
  test("engage sends the output latency as lag; a phrase release waits for the next phrase beat and a seek re-sends it", async () => {
    const engine = new FakeEngine();
    engine.anchor = { input: 0, output: 1, rate: 1, active: true };
    transports.A = transport(engine);
    const { ctx, host } = await started("phrase");
    const [a] = racks;
    selectPreset("A", "gate");
    engage("A", "latch");
    expect(a.last("engage")).toEqual({ t: "engage", lag: 0.03 });
    ctx.currentTime = 1 + 18 * P; // beat 18
    release("A");
    expect(getFxRack().decks.A.releasing).toBe(true);
    expect(a.last("release")).toEqual({ t: "release", atBeat: 32 }); // every 4 bars without measured lines
    engine.anchor = { input: 70 * P, output: ctx.currentTime + 0.1, rate: 1, active: true };
    engine.dispatchEvent(new Event("seeking"));
    host.pollFxRack();
    expect(a.last("release")).toEqual({ t: "release", atBeat: 80 });
    // The node reaching the line completes the release.
    a.emit({ t: "state", engaged: false, tail: true });
    expect(getFxRack().decks.A).toMatchObject({ on: false, releasing: false, tail: true });
  });

  test("a preset switch during a pending phrase release re-sends the release after the preset", async () => {
    transports.A = transport(new FakeEngine());
    await started("switch-releasing");
    const [a] = racks;
    selectPreset("A", "gate");
    engage("A", "latch");
    release("A");
    expect(getFxRack().decks.A.releasing).toBe(true);
    expect(a.last("release")).toEqual({ t: "release", atBeat: 32 });
    selectPreset("A", "echo");
    expect(a.sent.slice(-2)).toEqual([{ t: "preset", id: "echo", beats: 3 }, { t: "release", atBeat: 32 }]);
  });

  test("a latch the node ends by itself (a Φ line, Reverse's cap) turns the deck off; the next press engages again", async () => {
    transports.A = transport(new FakeEngine());
    await started("node-ended");
    const [a] = racks;
    for (const id of ["lift", "reverse"]) {
      selectPreset("A", id);
      if (id === "lift") setBeats("A", 3);
      engage("A", "latch");
      a.emit({ t: "state", engaged: true, tail: false });
      a.emit({ t: "state", engaged: false, tail: true });
      expect({ id, deck: getFxRack().decks.A }).toMatchObject({ id, deck: { on: false, releasing: false } });
      const engages = a.of("engage").length;
      engage("A", "latch");
      expect(a.of("engage")).toHaveLength(engages + 1);
      expect(getFxRack().decks.A).toMatchObject({ on: true, releasing: false });
      release("A", true);
    }
  });

  test("a paddle on a BPM-less deck never engages a tempo preset", async () => {
    transports.A = transport(new FakeEngine(), { bpm: null, grid: null });
    await started("paddle-bpm");
    const [a] = racks;
    selectPreset("A", "echo");
    paddle("A", 1);
    expect(a.of("engage")).toHaveLength(0);
    expect(getFxRack().decks.A.on).toBe(false);
    // A preset that works without BPM still engages.
    selectPreset("A", "lowpass");
    paddle("A", 2);
    expect(a.of("engage")).toHaveLength(1);
    expect(getFxRack().decks.A).toMatchObject({ on: true, held: true });
  });

  test("Φ posts its ramp end at engage", async () => {
    transports.A = transport(new FakeEngine());
    await started("phi");
    const [a] = racks;
    selectPreset("A", "lift");
    setBeats("A", 3);
    expect(a.last("preset")).toEqual({ t: "preset", id: "lift", beats: 3 });
    engage("A", "latch");
    expect(a.sent.slice(-2)).toEqual([{ t: "engage", lag: 0.03 }, { t: "release", atBeat: 32 }]);
  });

  test("a latched exit returns the dry on the next downbeat; a held one and a track change at once", async () => {
    transports.A = transport(new FakeEngine());
    const { host } = await started("exit");
    const [a] = racks;
    selectPreset("A", "echo-out");
    setPhraseRelease("A", false);
    engage("A", "latch");
    release("A");
    expect(a.last("release")).toEqual({ t: "release", atBeat: "bar" });
    engage("A", "hold");
    release("A");
    expect(a.last("release")).toEqual({ t: "release", atBeat: null });
    engage("A", "latch");
    transports.A = { ...transports.A!, trackId: 2 };
    host.pollFxRack();
    expect(getFxRack().decks.A.on).toBe(false);
    expect(a.last("release")).toEqual({ t: "release", atBeat: null });
    // Not an exit: a latched Echo releases now.
    selectPreset("A", "echo");
    engage("A", "latch");
    release("A");
    expect(a.last("release")).toEqual({ t: "release", atBeat: null });
  });

  test("a track change or an eject cancels a pending phrase release and releases a latched effect; so does a lost BPM", async () => {
    transports.A = transport(new FakeEngine());
    const { host } = await started("track");
    const [a] = racks;
    selectPreset("A", "gate");
    engage("A", "latch");
    release("A");
    expect(getFxRack().decks.A.releasing).toBe(true);
    transports.A = { ...transports.A!, trackId: 2 };
    host.pollFxRack();
    expect(getFxRack().decks.A).toMatchObject({ on: false, releasing: false });
    const tail = a.sent.slice(-3).map(message => message.t);
    expect(tail).toEqual(["release", "clock", "track"]);
    expect(a.of("release").at(-1)).toEqual({ t: "release", atBeat: null });
    selectPreset("A", "echo");
    engage("A", "latch");
    transports.A = { ...transports.A!, trackId: null };
    host.pollFxRack();
    expect(getFxRack().decks.A.on).toBe(false);
    expect(a.last("release")).toEqual({ t: "release", atBeat: null });
    transports.A = { ...transports.A!, trackId: 3 };
    host.pollFxRack();
    engage("A", "latch");
    transports.A = { ...transports.A!, bpm: null, grid: null };
    host.pollFxRack();
    expect(getFxRack().decks.A.on).toBe(false);
  });
});

describe("leaving and failing", () => {
  test("leaving two-deck mode releases both decks and unbinds every insert", async () => {
    const element = new EventTarget();
    const engine = new FakeEngine();
    transports.A = transport(element);
    transports.B = transport(engine);
    const { host } = await started("leave");
    engage("B", "latch");
    host.stopFxRack();
    stop = null;
    expect(binds.slice(-2)).toEqual([[element, null], [engine, null]]);
    expect(racks[1].last("release")).toEqual({ t: "release", atBeat: null });
    expect(getFxRack().decks.B.on).toBe(false);
    host.pollFxRack();
    expect(binds).toHaveLength(4);
    // Back in two-deck mode the same nodes are bound again.
    await host.startFxRack();
    stop = host.stopFxRack;
    expect(racks).toHaveLength(2);
    expect(binds.slice(-2).map(([media]) => media)).toEqual([element, engine]);
  });

  test("a processor error unbinds that unit's media and makes the rack unavailable", async () => {
    const element = new EventTarget();
    transports.A = transport(element);
    transports.B = transport(new EventTarget());
    const { host } = await started("processorerror");
    engage("A", "latch");
    racks[0].onprocessorerror?.();
    expect(binds.at(-1)).toEqual([element, null]);
    expect(getFxRack().available).toBe(false);
    expect(getFxRack().decks.A.on).toBe(false);
    expect(errors).toEqual(["Τα εφέ δεν είναι διαθέσιμα."]);
    const count = binds.length;
    host.pollFxRack();
    expect(binds).toHaveLength(count);
  });

  test("each deck's media gets its own bus input before its insert, on every poll, also after its unit failed", async () => {
    const element = new EventTarget();
    transports.A = transport(element);
    const { ctx, host } = await setup("bus");
    expect(host.fxRackReady()).toBe(false);
    await host.startFxRack();
    stop = host.stopFxRack;
    expect(host.fxRackReady()).toBe(true);
    const busA = deckInput(ctx as unknown as BaseAudioContext, "A");
    const busB = deckInput(ctx as unknown as BaseAudioContext, "B");
    expect(busA).not.toBe(busB);
    expect(wiring[0]).toEqual(["bus", element, busA]);
    expect(wiring[1][0]).toBe("insert");
    expect((racks[1].connections[0] as FakeNode).connections).toEqual([busB]); // B's FX output goes to B's input
    racks[0].onprocessorerror?.();
    // A media that comes after the fault (element → engine) still gets A's input, without any insert.
    const engine = new FakeEngine();
    transports.A = transport(engine);
    transports.B = transport(new EventTarget());
    wiring = [];
    host.pollFxRack();
    expect(wiring.filter(([kind]) => kind === "bus")).toEqual([["bus", engine, busA], ["bus", transports.B.media, busB]]);
    expect(wiring.some(([kind, media]) => kind === "insert" && media === engine)).toBe(false);
    expect(host.fxRackReady()).toBe(true); // a faulted unit does not matter: the bus binding is in the poll
    host.stopFxRack();
    stop = null;
    expect(host.fxRackReady()).toBe(false);
  });

  test("node state and faults reach the store", async () => {
    transports.A = transport(new FakeEngine());
    await started("fault");
    const [a] = racks;
    engage("A", "latch");
    a.emit({ t: "state", engaged: true, tail: true });
    expect(getFxRack().decks.A).toMatchObject({ on: true, tail: true });
    a.emit({ t: "fault" });
    expect(getFxRack().decks.A.on).toBe(false);
    expect(errors).toEqual(["Ένα εφέ σταμάτησε από σφάλμα ήχου."]);
  });
});
