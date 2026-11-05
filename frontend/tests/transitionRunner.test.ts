import { beforeEach, describe, expect, test } from "bun:test";
import type { StretchDeck } from "../src/lib/audio/stretchDeck";
import type { BeatGrid } from "../src/lib/beatGrid";
import type { MediaLike } from "../src/lib/media";
import { setTransportOwner, transportOwnerOf, type DeckTransport } from "../src/lib/mix/deckTransport";
import { activeRunner, armTransition, type Armed, type RunnerDeps } from "../src/lib/mix/transitionRunner";
import { NEUTRAL_FX, type MixerState } from "../src/lib/mixer";
import type { DeckId } from "../src/lib/player";
import { sampleCurves } from "../src/lib/transitions/curves";
import type { TransitionPlan } from "../src/lib/transitions/planner";

// One fake audio clock, one ordered log of every deck/mixer write, and a manual timer queue (timers are wake-ups).
let clock = 10;
let log: unknown[][] = [];
type Timer = { fn: () => void; ms: number; live: boolean };
let timers: Timer[] = [];
let everyTimer: Timer[] = [];
const setTimer = (fn: () => void, ms: number) => {
  const t = { fn, ms, live: true };
  timers.push(t);
  everyTimer.push(t);
  return () => { t.live = false; };
};
/** Sets the clock and fires the timers that are pending now (one round). */
function at(t: number) {
  clock = t;
  const due = timers.filter(x => x.live);
  timers = [];
  for (const x of due) { x.live = false; x.fn(); }
}
const liveTimers = () => timers.filter(t => t.live).length;
const writes = (name: string, op?: string) => log.filter(e => e[0] === name && (op === undefined || e[1] === op));
const indexOf = (pred: (e: unknown[]) => boolean) => log.findIndex(pred);

/** A deck's media: an engine (StretchDeck-like) or, with onEngine false in its transport, an element. */
class FakeMedia extends EventTarget {
  paused = true; ended = false; playbackRate = 1; duration = 200; readyState = 4; error = null; src = "x"; currentSrc = "x";
  anchor: { input: number; output: number; rate: number } | null = null;
  held = 0;
  loop: { start: number; end: number } | null = null;
  handlers: [string, EventListenerOrEventListenerObject][] = [];
  constructor(public name: string) { super(); }
  get currentTime() {
    return this.anchor && !this.paused ? this.anchor.input + Math.max(0, clock - this.anchor.output) * this.anchor.rate : this.held;
  }
  /** Test setup: playing from `input` now. */
  start(input: number) { this.paused = false; this.anchor = { input, output: clock, rate: this.playbackRate }; return this; }
  timeOf(p: number) {
    if (this.paused || !this.anchor || p > this.duration) return null;
    if (this.loop && p >= this.loop.end) return null;
    return this.anchor.output + (p - this.anchor.input) / this.anchor.rate;
  }
  playAt(t: number, input: number, rate: number) {
    log.push([this.name, "playAt", t, input, rate]);
    if (!this.paused || t < clock + 0.16) return null;
    this.playbackRate = rate; this.paused = false; this.anchor = { input, output: t, rate };
    this.dispatchEvent(new Event("play"));
    return t;
  }
  scheduleAutomation(p: unknown) { log.push([this.name, "auto", p]); return true; }
  cancelAutomation(mode: string, at?: number) { log.push([this.name, "cancel", mode, at ?? clock]); }
  setLoop(s: number, e: number) { log.push([this.name, "setLoop", s, e]); this.loop = { start: s, end: e }; return true; }
  clearLoop() { log.push([this.name, "clearLoop"]); this.loop = null; }
  play() { log.push([this.name, "play"]); this.start(this.held); return Promise.resolve(); }
  pause() {
    if (this.paused) return;
    log.push([this.name, "pause"]);
    this.held = this.currentTime; this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  /** What the engine's finish() does at the track end. */
  finish() { this.held = this.duration; this.paused = true; this.ended = true; this.emit("pause"); this.emit("ended"); }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
  override addEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if (l) { log.push([this.name, "listen", type]); this.handlers.push([type, l]); }
    super.addEventListener(type, l, o);
  }
}

type Deck = { media: FakeMedia; onEngine: boolean; ready: boolean; grid: BeatGrid | null };
let decks: Record<DeckId, Deck>;
const grid2s: BeatGrid = { kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false };
const transport = (d: DeckId): DeckTransport | null => {
  const x = decks[d];
  const m = x.media;
  return {
    trackId: d === "A" ? 1 : 2, engine: x.onEngine ? (m as unknown as StretchDeck) : null, media: m as unknown as MediaLike, onEngine: x.onEngine,
    ready: x.ready, playing: !m.paused, rate: x.onEngine ? m.playbackRate : 1, position: () => m.currentTime, duration: m.duration,
    grid: x.grid, cues: [], bpm: 120,
    play: () => { log.push([m.name, "transport-play"]); void m.play(); },
    pause: () => m.pause(),
    seekTo: s => { log.push([m.name, "seekTo", s]); m.held = s; },
  };
};

let mixer: MixerState;
const deps: RunnerDeps = {
  now: () => clock,
  transport,
  setTimer,
  setDeckRangePitch: (d, range, pitch) => { log.push(["mixer", "rangePitch", d, range, pitch]); mixer.fx[d] = { ...mixer.fx[d], range, pitch }; },
  setDeckPitch: (d, pitch) => { log.push(["mixer", "pitch", d, pitch]); mixer.fx[d] = { ...mixer.fx[d], pitch }; },
  getMixer: () => mixer,
};

const curves = sampleCurves({ volume_curve: "smooth", eq_curve: "bass_swap_center", filter_curve: "lpf_out" }, 64, 1 / 32);
/** A at 2 s bars, playing from 80 s at ctx 10 → T0 = 20, T1 = 36. */
const mixPlan = (o: Partial<TransitionPlan> = {}): TransitionPlan => ({
  kind: "mix", outStartS: 90, outEndS: 106, inStartS: 8, inEndS: 8 + 16 * 1.12, windowAudioS: 16, bars: 8, rateIn: 1.12,
  rampBackBars: 8, loop: { start: 90, end: 92 }, curves, reasons: [], ...o,
});
const cutPlan = (o: Partial<TransitionPlan> = {}): TransitionPlan => ({
  kind: "cut", outStartS: 100, outEndS: 100, inStartS: 8, inEndS: 8, windowAudioS: 0, bars: 0, rateIn: null,
  rampBackBars: 8, loop: null, curves: null, reasons: [], ...o,
});
const A = () => decks.A.media;
const B = () => decks.B.media;
function arm(plan: TransitionPlan): Armed {
  const r = armTransition("A", "B", plan, deps);
  if ("error" in r) throw new Error(`arm failed: ${r.error}`);
  return r;
}
const settled = async (r: Armed) => Promise.race([r.done, new Promise(res => setTimeout(() => res("pending"), 5))]);

beforeEach(() => {
  activeRunner.current?.dispose();
  clock = 10; log = []; timers = []; everyTimer = [];
  decks = {
    A: { media: new FakeMedia("A").start(80), onEngine: true, ready: true, grid: grid2s },
    B: { media: new FakeMedia("B"), onEngine: true, ready: true, grid: grid2s },
  };
  mixer = { volume: { A: 1, B: 1 }, crossfader: 0, midiConnected: false, master: 1, fx: { A: { ...NEUTRAL_FX }, B: { ...NEUTRAL_FX } } };
  setTransportOwner("A", null); setTransportOwner("B", null);
  log = [];
});

describe("arming a mix", () => {
  test("pitch range first, playAt at T0 = timeOf(outStartS), both stages, loop, owners; listeners after arming", () => {
    const r = arm(mixPlan());
    expect(r.t0).toBe(20);
    expect(r.t1).toBe(36);
    expect(r.state).toBe("armed");
    expect(activeRunner.current).toBe(r);
    const range = indexOf(e => e[1] === "rangePitch");
    const playAt = indexOf(e => e[0] === "B" && e[1] === "playAt");
    expect(log[range].slice(0, 4)).toEqual(["mixer", "rangePitch", "B", 0.16]);
    expect(log[range][4] as number).toBeCloseTo(0.75, 9);
    expect(range).toBeLessThan(playAt);
    expect(log[playAt]).toEqual(["B", "playAt", 20, 8, 1.12]);
    const [outAuto] = writes("A", "auto");
    const [inAuto] = writes("B", "auto");
    expect(outAuto[2]).toEqual({ at: 20, duration: 16, volume: curves.out.volume, eq: { lo: curves.out.eqLo, mid: curves.out.eqMid, hi: curves.out.eqHi }, filter: curves.out.filter });
    expect(inAuto[2]).toEqual({ at: 20, duration: 16, volume: curves.in.volume, eq: { lo: curves.in.eqLo, mid: curves.in.eqMid, hi: curves.in.eqHi }, filter: curves.in.filter });
    expect(writes("A", "setLoop")).toEqual([["A", "setLoop", 90, 92]]);
    const lastArm = Math.max(...["auto", "setLoop", "playAt"].map(op => log.findLastIndex(e => e[1] === op)));
    expect(indexOf(e => e[1] === "listen")).toBeGreaterThan(lastArm);
    expect(transportOwnerOf("A")).toBe("mix");
    expect(transportOwnerOf("B")).toBe("mix");
  });

  test("errors: too-late, not-ready, no-engine, rate-changed; nothing is left changed", () => {
    A().pause(); log = [];
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "too-late" });
    A().start(89.9); // T0 = 10.1, inside the lead
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "too-late" });
    A().start(80);
    decks.B.ready = false;
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "not-ready" });
    decks.B.ready = true;
    B().start(0);
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "not-ready" });
    B().pause();
    decks.B.onEngine = false;
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "no-engine" });
    decks.B.onEngine = true;
    A().playbackRate = 1.05; A().start(80);
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "rate-changed" });
    expect(log.filter(e => e[1] !== "pause")).toEqual([]);
    expect(mixer.fx.B).toEqual(NEUTRAL_FX);
    expect(transportOwnerOf("B")).toBeNull();
  });

  test("playAt refusing (lead longer than expected) restores the pitch and reports too-late", () => {
    B().playAt = (t, input, rate) => { log.push(["B", "playAt", t, input, rate]); return null; };
    expect(armTransition("A", "B", mixPlan(), deps)).toEqual({ error: "too-late" });
    expect(mixer.fx.B).toEqual(NEUTRAL_FX);
    expect(writes("A", "auto")).toEqual([]);
  });
});

describe("completion and ramp-back", () => {
  test("first wake-up at T1 + 0.25: owned pause (no abort), loop cleared, stages neutral, owners cleared", async () => {
    const r = arm(mixPlan());
    at(20);
    expect(r.state).toBe("running");
    at(36.2);
    expect(writes("A", "pause")).toEqual([]);
    at(36.25);
    expect(writes("A", "pause")).toHaveLength(1);
    expect(writes("A", "clearLoop")).toHaveLength(1);
    expect(writes("B", "cancel")).toEqual([["B", "cancel", "neutral", 36.25]]);
    expect(writes("A", "cancel")[0][3]).toBeCloseTo(36.3, 9);
    expect(transportOwnerOf("A")).toBeNull();
    expect(transportOwnerOf("B")).toBeNull();
    expect(await r.done).toBe("completed");
    expect(r.state).toBe("done");
    expect(r.reason).toBeNull();
  });

  test("a late wake-up (T1 + 3) still completes", async () => {
    const r = arm(mixPlan());
    at(39);
    expect(await r.done).toBe("completed");
    expect(writes("A", "cancel")[0][3]).toBeCloseTo(39.05, 9);
  });

  test("ramp-back: progress from audio time (a late wake-up jumps), then the range comes back at pitch 0", () => {
    arm(mixPlan());
    at(36.25);
    const rampS = (8 * 2) / 1.12;
    at(36.3);
    expect(writes("mixer", "pitch").at(-1)![3]).toBeCloseTo(0.75 * (1 - 0.05 / rampS), 9);
    at(36.75); // 400 ms late
    expect(writes("mixer", "pitch").at(-1)![3]).toBeCloseTo(0.75 * (1 - 0.5 / rampS), 9);
    at(60);
    expect(log.at(-1)).toEqual(["mixer", "rangePitch", "B", 0.08, 0]);
    expect(liveTimers()).toBe(0);
  });

  test("no rateIn: no ramp", () => {
    arm(mixPlan({ rateIn: null }));
    at(36.25);
    expect(writes("mixer")).toEqual([]);
    expect(liveTimers()).toBe(0);
  });

  test("a suspended clock never completes early", () => {
    const r = arm(mixPlan());
    for (let i = 0; i < 20; i++) at(20);
    expect(r.state).toBe("running");
    expect(writes("A", "pause")).toEqual([]);
    expect(liveTimers()).toBe(1);
  });

  test("natural completion: the out track ends (pause then ended) at T1 → completed, not aborted", async () => {
    A().duration = 200; A().start(174); // outStartS 184 → T0 20, T1 36 at the track end
    const r = arm(mixPlan({ outStartS: 184, outEndS: 200, loop: null }));
    clock = 36;
    A().finish();
    expect(r.state).toBe("running");
    at(36.25);
    expect(await r.done).toBe("completed");
  });
});

describe("abort and cancellation", () => {
  test("abort before T0: in paused, both stages neutral, loop cleared, pitch restored", async () => {
    const r = arm(mixPlan());
    clock = 15;
    r.abort("stop");
    expect(writes("B", "pause")).toHaveLength(1);
    expect(writes("A", "cancel")).toEqual([["A", "cancel", "neutral", 15]]);
    expect(writes("B", "cancel")).toEqual([["B", "cancel", "neutral", 15]]);
    expect(writes("A", "clearLoop")).toHaveLength(1);
    expect(mixer.fx.B).toEqual(NEUTRAL_FX);
    expect(await r.done).toBe("aborted");
    expect(r.state).toBe("aborted");
    expect(r.reason).toBe("stop");
    expect(transportOwnerOf("B")).toBeNull();
    expect(liveTimers()).toBe(0);
  });

  test("abort after T0: out paused, in glides to neutral over 1 bar and keeps its rate", async () => {
    const r = arm(mixPlan());
    clock = 25;
    r.abort("stop");
    expect(writes("A", "pause")).toHaveLength(1);
    expect(writes("A", "cancel")[0][3]).toBeCloseTo(25.05, 9);
    expect(writes("B", "pause")).toEqual([]);
    expect(writes("B", "cancel")).toEqual([["B", "cancel", "hold", 25]]);
    const glide = writes("B", "auto").at(-1)![2] as { at: number; duration: number; volume: Float32Array; filter: Float32Array };
    expect(glide.at).toBeCloseTo(25.01, 9);
    expect(glide.duration).toBe(2);
    const i = Math.round((5 / 16) * 63);
    expect(Array.from(glide.volume)).toEqual([curves.in.volume[i], 1]);
    expect(Array.from(glide.filter)).toEqual([curves.in.filter[i], 0]);
    expect(mixer.fx.B.pitch).toBeCloseTo(0.75, 9);
    expect(await r.done).toBe("aborted");
    expect(r.started).toBe(true);
  });

  test("dispose after T0 («Διακοπή» mid-window): in keeps playing but goes back to its range at pitch 0", async () => {
    const r = arm(mixPlan());
    clock = 25;
    expect(mixer.fx.B.pitch).toBeCloseTo(0.75, 9);
    r.dispose();
    expect(writes("B", "pause")).toEqual([]);
    expect(mixer.fx.B).toMatchObject({ range: 0.08, pitch: 0 });
    expect(r.started).toBe(true);
    expect(await r.done).toBe("aborted");
  });

  test("abort before T0 has not started the hand-over", async () => {
    const r = arm(mixPlan());
    clock = 15;
    r.abort("stop");
    expect(r.started).toBe(false);
    expect(await r.done).toBe("aborted");
  });

  test("an unowned pause on the outgoing deck mid-window aborts", async () => {
    const r = arm(mixPlan());
    clock = 25;
    A().pause();
    expect(await r.done).toBe("aborted");
    expect(r.reason).toBe("pause");
  });

  test("an outgoing rate change seen on a wake-up aborts with rate-changed", async () => {
    const r = arm(mixPlan());
    A().playbackRate = 1.02;
    at(15);
    expect(await r.done).toBe("aborted");
    expect(r.reason).toBe("rate-changed");
  });

  test("dispose twice is safe and cancels timers, listeners, the pending start, automation and the loop", async () => {
    const r = arm(mixPlan());
    clock = 12;
    r.dispose();
    const after = log.length;
    r.dispose();
    expect(log.length).toBe(after);
    expect(writes("B", "pause")).toHaveLength(1);
    expect(writes("A", "clearLoop")).toHaveLength(1);
    expect(writes("A", "cancel")).toHaveLength(1);
    expect(writes("B", "cancel")).toHaveLength(1);
    expect(liveTimers()).toBe(0);
    expect(await r.done).toBe("aborted");
    expect(activeRunner.current).toBeNull();
  });

  test("dispose during the ramp-back ends it at pitch 0 with the range restored", () => {
    const r = arm(mixPlan());
    at(36.25);
    at(36.3);
    r.dispose();
    expect(log.at(-1)).toEqual(["mixer", "rangePitch", "B", 0.08, 0]);
    expect(liveTimers()).toBe(0);
  });

  test("stale timers and listeners after dispose make no deck writes", () => {
    const r = arm(mixPlan());
    at(15);
    r.dispose();
    const after = log.length;
    clock = 37;
    for (const t of everyTimer) t.fn();
    for (const m of [A(), B()]) for (const [type, l] of m.handlers) {
      if (typeof l === "function") l(new Event(type)); else l.handleEvent(new Event(type));
    }
    expect(log.length).toBe(after);
  });

  test("arming a new runner disposes the previous one (replacement)", () => {
    const first = arm(mixPlan());
    const firstTimers = [...everyTimer];
    decks.B.media = new FakeMedia("B2");
    const second = arm(mixPlan({ loop: null }));
    expect(first.state).toBe("aborted");
    expect(activeRunner.current).toBe(second);
    const after = log.length;
    for (const t of firstTimers) t.fn();
    expect(log.length).toBe(after);
  });
});

describe("cut paths (one cut time tCut)", () => {
  test("engine → engine: playAt(timeOf(outEndS), inStartS, 1); the out deck stops at the first wake-up ≥ tCut", async () => {
    const r = arm(cutPlan());
    expect(r.t0).toBe(30);
    expect(writes("B", "playAt")).toEqual([["B", "playAt", 30, 8, 1]]);
    const cut = writes("A", "auto")[0][2] as { at: number; volume: Float32Array };
    expect(cut.at).toBe(30);
    expect(Array.from(cut.volume)).toEqual([1, 0]);
    at(29.9);
    expect(writes("A", "pause")).toEqual([]);
    at(30);
    expect(writes("A", "pause")).toHaveLength(1);
    expect(writes("A", "cancel")[0][3]).toBeCloseTo(30.05, 9);
    expect(await r.done).toBe("cut");
    expect(transportOwnerOf("A")).toBeNull();
  });

  test("engine → element: owned seek at arm (its deferred seeking/seeked do not abort), play() then pause at tCut", async () => {
    decks.B.onEngine = false;
    const r = arm(cutPlan());
    expect(writes("B", "seekTo")).toEqual([["B", "seekTo", 8]]);
    B().emit("seeking");
    B().emit("seeked");
    expect(r.state).toBe("armed");
    at(29.9);
    expect(writes("B", "transport-play")).toEqual([]);
    at(30.02);
    const play = indexOf(e => e[0] === "B" && e[1] === "transport-play");
    const pause = indexOf(e => e[0] === "A" && e[1] === "pause");
    expect(play).toBeGreaterThan(-1);
    expect(play).toBeLessThan(pause);
    expect(await r.done).toBe("cut");
  });

  test("an unowned seek once the owned one settled aborts", async () => {
    decks.B.onEngine = false;
    const r = arm(cutPlan());
    B().emit("seeking");
    B().emit("seeked");
    B().emit("seeking");
    expect(await r.done).toBe("aborted");
    expect(r.reason).toBe("seek");
  });

  test("element → engine: triggers near outEndS, the out deck pauses only at/after tCut (no gap)", async () => {
    decks.A.onEngine = false;
    A().start(90); // reaches 100 at ctx 20
    const r = arm(cutPlan());
    expect(writes("B", "playAt")).toEqual([]);
    clock = 19.4; A().emit("timeupdate"); // 99.4 < 100 − 0.46
    expect(writes("B", "playAt")).toEqual([]);
    clock = 19.6; A().emit("timeupdate");
    expect(writes("B", "playAt")).toHaveLength(1);
    const [, , tCut, input, rate] = writes("B", "playAt")[0] as number[] & unknown[];
    expect(tCut).toBeCloseTo(19.81, 9);
    expect([input, rate]).toEqual([8, 1]);
    expect(writes("A", "pause")).toEqual([]);
    at(19.7);
    expect(writes("A", "pause")).toEqual([]);
    at(19.82);
    expect(writes("A", "pause")).toHaveLength(1);
    expect(await r.done).toBe("cut");
  });

  test("element → engine: a lead longer than the usual one retries once further ahead instead of aborting", async () => {
    decks.A.onEngine = false;
    A().start(90);
    const playAt = B().playAt.bind(B());
    B().playAt = (t, input, rate) => (t < clock + 0.3 ? (log.push(["B", "playAt", t, input, rate]), null) : playAt(t, input, rate));
    const r = arm(cutPlan());
    clock = 19.6; A().emit("timeupdate");
    const starts = writes("B", "playAt") as number[][];
    expect(starts).toHaveLength(2);
    expect(starts[1][2]).toBeCloseTo(20.1, 9);
    expect(r.state).not.toBe("aborted");
    at(20.11);
    expect(await r.done).toBe("cut");
  });

  test("element → engine with the out track already ended at arm triggers at once", () => {
    decks.A.onEngine = false;
    A().finish(); log = [];
    arm(cutPlan());
    expect(writes("B", "playAt")).toHaveLength(1);
  });

  test("element → element: seek at arm, then play() and pause at the outEndS − 0.3 boundary", async () => {
    decks.A.onEngine = false; decks.B.onEngine = false;
    A().start(90);
    const r = arm(cutPlan());
    expect(writes("B", "seekTo")).toEqual([["B", "seekTo", 8]]);
    clock = 19.6; A().emit("timeupdate"); // 99.6
    expect(writes("B", "transport-play")).toEqual([]);
    clock = 19.75; A().emit("timeupdate"); // 99.75
    const play = indexOf(e => e[0] === "B" && e[1] === "transport-play");
    expect(play).toBeGreaterThan(-1);
    expect(play).toBeLessThan(indexOf(e => e[0] === "A" && e[1] === "pause"));
    expect(await r.done).toBe("cut");
  });

  test("element → element: the out track's natural end (pause, ended) also triggers", async () => {
    decks.A.onEngine = false; decks.B.onEngine = false;
    A().start(190); A().duration = 200;
    const r = arm(cutPlan({ outStartS: 200, outEndS: 200 }));
    clock = 20; A().finish();
    expect(writes("B", "transport-play")).toHaveLength(1);
    expect(await r.done).toBe("cut");
  });

  test("abort of an engine cut before tCut pauses the armed incoming deck", async () => {
    const r = arm(cutPlan());
    clock = 20;
    r.abort("stop");
    expect(writes("B", "pause")).toHaveLength(1);
    expect(await settled(r)).toBe("aborted");
  });
});
