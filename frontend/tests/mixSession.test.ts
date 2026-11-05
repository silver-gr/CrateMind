import { beforeEach, describe, expect, test } from "bun:test";
import type { StretchDeck } from "../src/lib/audio/stretchDeck";
import type { BeatGrid } from "../src/lib/beatGrid";
import type { MediaLike } from "../src/lib/media";
import { setTransportOwner, type DeckTransport } from "../src/lib/mix/deckTransport";
import {
  ADOPT, MIX_MESSAGES, TO_LOAD, dispatchMix, getMixSession, nextStep, runConductor, skipToTransition, startMixSession, stopMixSession,
  type ConductorDeps, type MixSession,
} from "../src/lib/mix/mixSession";
import { activeRunner } from "../src/lib/mix/transitionRunner";
import { NEUTRAL_FX, type MixerState } from "../src/lib/mixer";
import type { DeckId, DeckSlots } from "../src/lib/player";
import type { SetTransition } from "../src/lib/transitions/types";
import type { Track } from "../src/lib/types";

const track = (id: number): Track => ({ id, title: `T${id}`, file_name: `t${id}.mp3` }) as Track;
const T = [track(1), track(2), track(3)];
const blend = (from: number, to: number, o: Partial<SetTransition> = {}): SetTransition => ({
  id: null, set_id: 7, from_track_id: from, to_track_id: to, persisted: false, resolved_preset: "blend", reasons: [], updated_at: null,
  preset: "auto", bars: 8, volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none", loop_beats: null,
  out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o,
});
const TR = [blend(1, 2), blend(2, 3)];
const restore = { keylock: { A: false, B: false }, range: { A: 0.08, B: 0.16 } };

function started(o: Partial<{ mode: "set" | "preview"; tracks: Track[] }> = {}): MixSession {
  const idle = getMixSession();
  return nextStep({ ...idle, status: "idle" }, {
    type: "start", id: 1, mode: o.mode ?? "set", setId: 7, setTitle: "Βράδυ", tracks: o.tracks ?? T, transitions: TR, startIndex: 0, restore,
  });
}
const adopt = (s: MixSession) => nextStep(nextStep(s, { type: "slotChanged", deck: "A", token: 5, trackId: 1 }), { type: "slotChanged", deck: "B", token: 3, trackId: 2 });
const playing = () => nextStep(nextStep(adopt(started()), { type: "ready", deck: "A" }), { type: "ready", deck: "B" });

describe("reducer", () => {
  test("start → loading with both decks expected (adopted on the first slot seen) and the restore captured", () => {
    const s = started();
    expect(s.status).toBe("loading");
    expect(s.expected).toEqual({ A: { trackId: 1, token: ADOPT }, B: { trackId: 2, token: ADOPT } });
    expect(s.restore).toEqual(restore);
    expect(s.currentDeck).toBe("A");
    expect(s.queue.map(q => q.trackId)).toEqual([1, 2, 3]);
    expect(s.queue[0].transition).toBe(TR[0]);
    expect(s.transitionPreset).toBe("auto");
    const a = adopt(s);
    expect(a.expected).toEqual({ A: { trackId: 1, token: 5 }, B: { trackId: 2, token: 3 } });
  });

  test("both ready → playing; one is not enough", () => {
    const s = adopt(started());
    expect(nextStep(s, { type: "ready", deck: "A" }).status).toBe("loading");
    expect(playing().status).toBe("playing");
  });

  test("tick: countdown before the deadline, armed at min(T0 − 4, outEnd − 8)", () => {
    const s = playing();
    const before = nextStep(s, { type: "tick", now: 17.9, t0: 22, outEnd: 38 });
    expect(before.status).toBe("playing");
    expect(before.transitionAt).toBe(22);
    const armed = nextStep(before, { type: "tick", now: 18, t0: 22, outEnd: 38 });
    expect(armed.status).toBe("armed");
    expect(armed.attempt).toBe(before.attempt + 1);
    // a short window: outEnd − 8 comes first
    expect(nextStep(s, { type: "tick", now: 20.5, t0: 25, outEnd: 28.5 }).status).toBe("armed");
    const withT0 = nextStep(armed, { type: "armed", t0: 22 });
    expect(nextStep(withT0, { type: "tick", now: 21.9, t0: 22, outEnd: 38 }).status).toBe("armed");
    expect(nextStep(withT0, { type: "tick", now: 22, t0: 22, outEnd: 38 }).status).toBe("transitioning");
  });

  test("transitionDone(completed) swaps roles, advances and expects the next track on the free deck", () => {
    let s = nextStep(nextStep(playing(), { type: "tick", now: 18, t0: 22, outEnd: 38 }), { type: "armed", t0: 22 });
    s = nextStep(nextStep(s, { type: "tick", now: 22, t0: 22, outEnd: 38 }), { type: "transitionDone", result: "completed", reason: null });
    expect(s.status).toBe("playing");
    expect(s.currentDeck).toBe("B");
    expect(s.index).toBe(1);
    expect(s.expected.A).toEqual({ trackId: 3, token: TO_LOAD });
    expect(s.expected.B).toEqual({ trackId: 2, token: 3 });
    expect(s.ready.A).toBe(false);
    expect(s.transitionAt).toBeNull();
    // the last pair: nothing left to pre-load
    s = nextStep(nextStep(nextStep(s, { type: "slotChanged", deck: "A", token: 6, trackId: 3 }), { type: "ready", deck: "A" }), { type: "tick", now: 56, t0: 60, outEnd: 70 });
    s = nextStep(nextStep(s, { type: "armed", t0: 60 }), { type: "transitionDone", result: "cut", reason: null });
    expect(s.currentDeck).toBe("A");
    expect(s.index).toBe(2);
    expect(s.expected.B).toBeNull();
  });

  test("slotChanged: the expected load is adopted, anything else stops; an eject stops", () => {
    const s = playing();
    expect(nextStep(s, { type: "slotChanged", deck: "B", token: 3, trackId: 2 })).toBe(s);
    const changed = nextStep(s, { type: "slotChanged", deck: "B", token: 4, trackId: 2 });
    expect(changed.status).toBe("stopping");
    expect(changed.error).toBe("Η μίξη σταμάτησε: άλλαξε το deck");
    expect(nextStep(s, { type: "slotChanged", deck: "A", token: 5, trackId: 9 }).status).toBe("stopping");
    expect(nextStep(s, { type: "ejected", deck: "B" }).status).toBe("stopping");
  });

  test("readiness: late-ready before outEnd − 2 forces a cut; undecoded at outEnd − 2 stops and ignores ended", () => {
    const s = nextStep(adopt(started()), { type: "ready", deck: "A" });
    // B never got ready: force it through as playing (A plays, B is loading)
    const p = { ...s, status: "playing" as const };
    const late = nextStep(p, { type: "tick", now: 18, t0: 22, outEnd: 38 });
    expect(late.status).toBe("playing");
    expect(late.forceCut).toBe(true);
    const ready = nextStep(nextStep(late, { type: "ready", deck: "B" }), { type: "tick", now: 30, t0: 22, outEnd: 38 });
    expect(ready.status).toBe("armed");
    expect(ready.forceCut).toBe(true);

    const gave = nextStep(late, { type: "tick", now: 36, t0: 22, outEnd: 38 });
    expect(gave.status).toBe("stopping");
    expect(gave.error).toBe("Η μίξη σταμάτησε: το επόμενο track δεν φορτώθηκε");
    expect(nextStep(gave, { type: "ended" })).toBe(gave);
    const idle = nextStep(gave, { type: "stopped" });
    expect(idle.status).toBe("idle");
    expect(nextStep(idle, { type: "ended" })).toBe(idle);
    expect(nextStep(late, { type: "readyTimeout" }).error).toBe(MIX_MESSAGES.notLoaded);
  });

  test("setChanged rebuilds the queue from the new order from the playing track; a removed playing track stops", () => {
    const s = playing();
    const order = [T[0], T[2], T[1]];
    const t = [blend(1, 3), blend(3, 2)];
    const re = nextStep(s, { type: "setChanged", tracks: order, transitions: t });
    expect(re.status).toBe("playing");
    expect(re.queue.map(q => q.trackId)).toEqual([1, 3, 2]);
    expect(re.index).toBe(0);
    expect(re.queue[0].transition).toBe(t[0]);
    expect(re.expected.B).toEqual({ trackId: 3, token: TO_LOAD });
    expect(re.ready.B).toBe(false);
    // the playing track moved later: still found, queue from there
    const moved = nextStep(s, { type: "setChanged", tracks: [T[2], T[0], T[1]], transitions: [] });
    expect(moved.queue.map(q => q.trackId)).toEqual([1, 2]);
    expect(moved.expected.B).toEqual({ trackId: 2, token: 3 });
    const gone = nextStep(s, { type: "setChanged", tracks: [T[1], T[2]], transitions: [] });
    expect(gone.status).toBe("stopping");
    expect(gone.error).toBe(MIX_MESSAGES.trackRemoved);
    // an armed pair plays out even if the next track moved
    const armed = nextStep(s, { type: "tick", now: 18, t0: 22, outEnd: 38 });
    const keep = nextStep(armed, { type: "setChanged", tracks: order, transitions: t });
    expect(keep.queue.map(q => q.trackId)).toEqual([1, 2]);
    expect(keep.expected.B).toEqual({ trackId: 2, token: 3 });
  });

  test("skip re-arms at most once per transition", () => {
    const s = playing();
    const sk = nextStep(s, { type: "skip", now: 12 });
    expect(sk.status).toBe("armed");
    expect(sk.skipped).toBe(true);
    expect(sk.attempt).toBe(s.attempt + 1);
    expect(nextStep(sk, { type: "skip", now: 12.5 })).toBe(sk);
    const notReady = { ...s, ready: { ...s.ready, B: false } };
    expect(nextStep(notReady, { type: "skip", now: 12 })).toBe(notReady);
  });

  test("a missed arm deadline: one re-plan, then a cut, then a reported stop (bounded)", () => {
    const armed = nextStep(playing(), { type: "tick", now: 18, t0: 22, outEnd: 38 });
    const r1 = nextStep(armed, { type: "armFailed", error: "too-late" });
    expect(r1.status).toBe("armed");
    expect(r1.attempt).toBe(armed.attempt + 1);
    expect(r1.forceCut).toBe(false);
    const r2 = nextStep(r1, { type: "armFailed", error: "too-late" });
    expect(r2.status).toBe("armed");
    expect(r2.forceCut).toBe(true);
    expect(r2.attempt).toBe(r1.attempt + 1);
    const r3 = nextStep(r2, { type: "armFailed", error: "too-late" });
    expect(r3.status).toBe("stopping");
    expect(r3.error).toBe(MIX_MESSAGES.armFailed);
    // not-ready waits instead of counting
    expect(nextStep(armed, { type: "armFailed", error: "not-ready" }).status).toBe("playing");
  });

  test("an abort is the user taking over (stop); a rate change before T0 re-plans", () => {
    const armed = nextStep(playing(), { type: "tick", now: 18, t0: 22, outEnd: 38 });
    expect(nextStep(armed, { type: "transitionDone", result: "aborted", reason: "pause" }).status).toBe("stopping");
    expect(nextStep(armed, { type: "transitionDone", result: "aborted", reason: "rate-changed" }).status).toBe("playing");
  });

  test("the last track's end → idle; stop → stopping → stopped → idle", () => {
    const two = nextStep(nextStep(adopt(started({ tracks: [T[0], T[1]] })), { type: "ready", deck: "A" }), { type: "ready", deck: "B" });
    let s = nextStep(nextStep(two, { type: "tick", now: 18, t0: 22, outEnd: 38 }), { type: "armed", t0: 22 });
    s = nextStep(s, { type: "transitionDone", result: "completed", reason: null });
    expect(nextStep(s, { type: "ended" }).status).toBe("idle");
    // not the last track and no transition happened: a reported stop
    expect(nextStep(two, { type: "ended" }).status).toBe("stopping");
    const st = nextStep(two, { type: "stop", reason: "user" });
    expect(st.status).toBe("stopping");
    expect(st.error).toBeNull();
    expect(nextStep(st, { type: "stopped" }).status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Conductor: fake decks (engine-like media on one audio clock), fake slots/load, a manual timer queue.

let clock = 10;
let log: unknown[][] = [];
type Timer = { fn: () => void; live: boolean; owner: string };
let timers: Timer[] = [];
const timerFor = (owner: string) => (fn: () => void, _ms: number) => {
  const t = { fn, live: true, owner };
  timers.push(t);
  return () => { t.live = false; };
};
/** Sets the clock and fires the pending timers, round after round, until none is due (bounded). */
function at(t: number, rounds = 8) {
  clock = t;
  for (let i = 0; i < rounds; i++) {
    const due = timers.filter(x => x.live);
    timers = [];
    if (!due.length) return;
    for (const x of due) { x.live = false; x.fn(); }
  }
}
const flush = () => new Promise(r => setTimeout(r, 0));
const writes = (name: string, op?: string) => log.filter(e => e[0] === name && (op === undefined || e[1] === op));

class FakeMedia extends EventTarget {
  paused = true; ended = false; playbackRate = 1; duration = 200; readyState = 4; error = null; src = "x"; currentSrc = "x";
  anchor: { input: number; output: number; rate: number } | null = null;
  held = 0;
  loop: { start: number; end: number } | null = null;
  constructor(public name: string) { super(); }
  get currentTime() { return this.anchor && !this.paused ? this.anchor.input + Math.max(0, clock - this.anchor.output) * this.anchor.rate : this.held; }
  start(input: number) { this.paused = false; this.anchor = { input, output: clock, rate: this.playbackRate }; return this; }
  timeOf(p: number) { return this.paused || !this.anchor || p > this.duration ? null : this.anchor.output + (p - this.anchor.input) / this.anchor.rate; }
  playAt(t: number, input: number, rate: number) {
    log.push([this.name, "playAt", t, input, rate]);
    if (!this.paused || t < clock + 0.16) return null;
    this.playbackRate = rate; this.paused = false; this.anchor = { input, output: t, rate };
    this.dispatchEvent(new Event("play"));
    return t;
  }
  scheduleAutomation(p: unknown) { log.push([this.name, "auto", p]); return true; }
  cancelAutomation(mode: string) { log.push([this.name, "cancel", mode]); }
  setLoop(s: number, e: number) { this.loop = { start: s, end: e }; return true; }
  clearLoop() { this.loop = null; }
  play() { this.start(this.held); return Promise.resolve(); }
  pause() { if (this.paused) return; log.push([this.name, "pause"]); this.held = this.currentTime; this.paused = true; this.dispatchEvent(new Event("pause")); }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
}

type Deck = { media: FakeMedia; ready: boolean; trackId: number | null; grid: BeatGrid | null };
let decks: Record<DeckId, Deck>;
let slots: DeckSlots;
let mixer: MixerState;
let toasts: string[];
let announced: string[];
const grid120: BeatGrid = { kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false };

const transport = (d: DeckId): DeckTransport | null => {
  const x = decks[d];
  const m = x.media;
  return {
    trackId: x.trackId, engine: m as unknown as StretchDeck, media: m as unknown as MediaLike, onEngine: true, ready: x.ready,
    playing: !m.paused, rate: m.playbackRate, position: () => m.currentTime, duration: m.duration, grid: x.grid, cues: [], bpm: 120,
    play: () => { log.push([m.name, "transport-play"]); void m.play(); },
    pause: () => m.pause(),
    seekTo: s => { log.push([m.name, "seekTo", s]); m.held = s; },
  };
};

function makeDeps(owner = "c"): ConductorDeps {
  return {
    now: () => clock,
    transport,
    setTimer: timerFor(owner),
    setDeckRangePitch: (d, range, pitch) => { log.push(["mixer", "rangePitch", d, range, pitch]); mixer.fx[d] = { ...mixer.fx[d], range, pitch }; },
    setDeckPitch: (d, pitch) => { log.push(["mixer", "pitch", d, pitch]); mixer.fx[d] = { ...mixer.fx[d], pitch }; },
    getMixer: () => mixer,
    setDeckKeylock: (d, on) => { log.push(["mixer", "keylock", d, on]); mixer.fx[d] = { ...mixer.fx[d], keylock: on }; },
    setCrossfader: v => { log.push(["mixer", "crossfader", v]); mixer.crossfader = v; },
    slots: () => slots,
    load: (d, t, o) => {
      log.push(["load", d, t.id, o.play]);
      slots = { ...slots, [d]: { track: t, token: slots[d].token + 1, autoPlay: o.play ?? true } };
      decks[d] = { media: new FakeMedia(d), ready: false, trackId: t.id, grid: grid120 };
      return true;
    },
    toast: m => { toasts.push(m); },
    announce: m => { announced.push(m); },
  };
}

function startSet(mode: "set" | "preview" = "set", tracks = T) {
  // What the click handler does: B then A loaded, then the session starts.
  slots = { A: { track: tracks[0], token: 5, autoPlay: mode === "set" }, B: { track: tracks[1], token: 3, autoPlay: false } };
  startMixSession({ mode, setId: 7, setTitle: "Βράδυ", tracks, transitions: TR, startIndex: 0, restore });
}

beforeEach(() => {
  activeRunner.current?.dispose();
  if (getMixSession().status !== "idle") { dispatchMix({ type: "stop", reason: "test" }); dispatchMix({ type: "stopped" }); }
  clock = 10; log = []; timers = []; toasts = []; announced = [];
  decks = {
    A: { media: new FakeMedia("A").start(170), ready: true, trackId: 1, grid: grid120 },
    B: { media: new FakeMedia("B"), ready: true, trackId: 2, grid: grid120 },
  };
  mixer = { volume: { A: 1, B: 1 }, crossfader: 0.4, midiConnected: false, master: 1, fx: { A: { ...NEUTRAL_FX }, B: { ...NEUTRAL_FX, range: 0.16 } } };
  setTransportOwner("A", null); setTransportOwner("B", null);
});

describe("conductor", () => {
  test("set mode: adopts, waits for readiness, key lock on, crossfader centred, arms at the deadline and completes", async () => {
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    const s = getMixSession();
    expect(s.status).toBe("playing");
    expect(s.expected).toEqual({ A: { trackId: 1, token: 5 }, B: { trackId: 2, token: 3 } });
    expect(writes("mixer", "keylock")).toEqual([["mixer", "keylock", "A", true], ["mixer", "keylock", "B", true]]);
    expect(mixer.crossfader).toBe(0);
    expect(s.transitionAt).toBe(22); // outStartS 182 from 170 at ctx 10
    expect(announced).toContain("Η μίξη ξεκίνησε");
    expect(writes("B", "playAt")).toEqual([]);

    at(18);
    expect(getMixSession().status).toBe("armed");
    expect(writes("B", "playAt")).toEqual([["B", "playAt", 22, 0, 1]]);
    at(22);
    expect(getMixSession().status).toBe("transitioning");
    at(38.3);
    await flush();
    at(38.3);
    const done = getMixSession();
    expect(done.status).toBe("playing");
    expect(done.currentDeck).toBe("B");
    expect(done.index).toBe(1);
    // the third track is pre-loaded on the free deck, cued
    expect(log.filter(e => e[0] === "load")).toEqual([["load", "A", 3, false]]);
    c.dispose();
  });

  test("a hint when a fader is down; with a controller the crossfader is left alone", () => {
    mixer.volume.B = 0;
    mixer.midiConnected = true;
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    expect(mixer.crossfader).toBe(0.4);
    expect(toasts.length).toBe(1);
    c.dispose();
  });

  test("preview: ready → owned seek → seeked → play() once → playing → arm", () => {
    decks.A.media = new FakeMedia("A"); // paused at 0
    const c = runConductor(makeDeps());
    startSet("preview");
    at(10);
    expect(writes("A", "seekTo")).toEqual([["A", "seekTo", 174]]); // outStartS 182 − 4 bars
    expect(writes("A", "transport-play")).toEqual([]);
    decks.A.media.emit("seeked");
    expect(writes("A", "transport-play").length).toBe(1);
    at(10);
    expect(writes("B", "playAt")).toEqual([]); // not before playing
    decks.A.media.emit("playing");
    at(10);
    expect(getMixSession().status).toBe("armed");
    expect(writes("B", "playAt")).toEqual([["B", "playAt", 18, 0, 1]]);
    expect(writes("A", "transport-play").length).toBe(1);
    const order = log.findIndex(e => e[1] === "transport-play") < log.findIndex(e => e[1] === "playAt");
    expect(order).toBe(true);
    c.dispose();
  });

  test("preview: a start already at the target proceeds without waiting for seeked", () => {
    decks.A.media = new FakeMedia("A");
    decks.A.media.held = 174;
    const c = runConductor(makeDeps());
    startSet("preview");
    at(10);
    expect(writes("A", "seekTo")).toEqual([]);
    expect(writes("A", "transport-play").length).toBe(1);
    decks.A.media.emit("playing");
    at(10);
    expect(writes("B", "playAt").length).toBe(1);
    c.dispose();
  });

  test("StrictMode double mount: one runner, the first conductor's timers are dead and it never acts", () => {
    const c1 = runConductor(makeDeps("c1"));
    c1.dispose();
    const c2 = runConductor(makeDeps("c2"));
    startSet();
    at(10);
    at(18);
    expect(writes("B", "playAt").length).toBe(1);
    expect(timers.filter(t => t.owner === "c1").length).toBe(0);
    expect(activeRunner.current).not.toBeNull();
    c2.dispose();
  });

  test("cleanup aborts the active runner", () => {
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    at(18);
    expect(activeRunner.current?.state).toBe("armed");
    c.dispose();
    expect(activeRunner.current).toBeNull();
    expect(writes("B", "pause").length).toBe(1);
  });

  test("a suspended audio clock never completes early", async () => {
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    at(18);
    for (let i = 0; i < 20; i++) at(18);
    await flush();
    expect(getMixSession().status).toBe("armed");
    expect(activeRunner.current?.state).toBe("armed");
    c.dispose();
  });

  test("Διακοπή mid ramp-back: key lock and pitch range restored, B back at rate 1", async () => {
    decks.B.grid = { ...grid120, period: 0.525 }; // 114.3 BPM → rateIn 1.05
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    at(18);
    expect(writes("B", "playAt")[0][4] as number).toBeCloseTo(1.05, 6);
    expect(mixer.fx.B.pitch).not.toBe(0);
    at(38.3);
    await flush();
    at(39);
    expect(getMixSession().currentDeck).toBe("B");
    const midRamp = mixer.fx.B.pitch;
    expect(midRamp).not.toBe(0);
    stopMixSession("user");
    at(39);
    expect(getMixSession().status).toBe("idle");
    expect(mixer.fx.B).toMatchObject({ range: 0.16, pitch: 0, keylock: false });
    expect(mixer.fx.A).toMatchObject({ range: 0.08, keylock: false });
    expect(toasts).toEqual([]);
    expect(announced.at(-1)).toBe("Η μίξη σταμάτησε");
    c.dispose();
  });

  test("«Παράλειψη» arms on the next bar line at least 0.5 s ahead, once", () => {
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    skipToTransition();
    at(10);
    expect(getMixSession().status).toBe("armed");
    expect(writes("B", "playAt")).toEqual([["B", "playAt", 12, 0, 1]]); // 170 + 0.5 → bar 172, 2 s ahead
    skipToTransition();
    at(10);
    expect(writes("B", "playAt").length).toBe(1);
    c.dispose();
  });

  test("B undecoded at outEnd − 2: reported stop, A keeps playing", () => {
    decks.B.ready = false;
    const c = runConductor(makeDeps());
    startSet();
    at(10);
    const s = getMixSession();
    // A is ready and playing; B never is. The session waits in loading, then the policy runs from the ticks.
    expect(s.status).toBe("loading");
    at(36.1);
    expect(getMixSession().status).toBe("idle");
    expect(toasts).toEqual([MIX_MESSAGES.notLoaded]);
    expect(decks.A.media.paused).toBe(false);
    c.dispose();
  });
});
