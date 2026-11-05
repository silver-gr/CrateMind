// Executes one planned transition on the two decks, on the AudioContext timeline. Timers are wake-ups, never clocks:
// every callback re-reads `now()` (audio time) and acts on it. Only owned actions touch the decks; any other pause or
// seek on either deck, or an outgoing rate change, is the user taking over and aborts the transition.
import type { StretchDeck } from "../audio/stretchDeck";
import { barSeconds } from "../beatGrid";
import type { MediaLike } from "../media";
import { planRate, type MixerState } from "../mixer";
import type { DeckId } from "../player";
import type { Lane } from "../transitions/curves";
import type { TransitionPlan } from "../transitions/planner";
import { setTransportOwner, type DeckTransport } from "./deckTransport";

export interface RunnerDeps {
  /** AudioContext time. */
  now(): number;
  transport(d: DeckId): DeckTransport | null;
  /** One-shot timer; returns its cancel. */
  setTimer(fn: () => void, ms: number): () => void;
  setDeckRangePitch(deck: DeckId, range: number, pitch: number): void;
  setDeckPitch(deck: DeckId, value: number): void;
  getMixer(): MixerState;
}

export type RunnerResult = "completed" | "aborted" | "cut";
export type ArmError = "not-ready" | "too-late" | "no-engine" | "rate-changed";

export interface Armed {
  /** Audio time the window (or the cut) starts; an element-out cut updates its estimate when it fires. */
  readonly t0: number;
  readonly t1: number;
  readonly state: "armed" | "running" | "done" | "aborted";
  /** Why it was aborted ("pause", "seek", "rate-changed", the caller's reason), else null. */
  readonly reason: string | null;
  /** The hand-over began: it completed or cut, or an abort after T0 left the incoming deck playing. */
  readonly started: boolean;
  /** The incoming deck's tempo ramp-back (after a tempo-matched mix) is still running. */
  readonly ramping: boolean;
  /** Ends a running ramp-back now: the range from before at pitch 0. Needed before the next arm uses that deck's rate. */
  settleTempo(): void;
  abort(reason: string): void;
  dispose(): void;
  done: Promise<RunnerResult>;
}

/** The one live runner; the conductor aborts/disposes it on cleanup. Arming a new one disposes the previous one. */
export const activeRunner: { current: Armed | null } = { current: null };

/** The engine's usual scheduling lead (stretchDeck DEFAULT_LEAD); `playAt` refuses anything sooner and the runner then reports too-late. */
const LEAD = 0.16;
const ARM_MARGIN = 0.05;
/** The engine's lead adapts to the worklet latency; an element-out cut retries this far ahead before giving up. */
const RETRY_AHEAD = 0.5;
const COMPLETE_AFTER = 0.25;
/** The outgoing stage goes neutral after the engine's halt fade, so it never blips back up. */
const AFTER_HALT = 0.05;
const NATURAL_END = 0.05;
/** An element outgoing deck hands over this long before outEndS (engine incoming: plus the lead, so it is anchored in time). */
const ELEMENT_EARLY = 0.3;
const TICK_MS = 250;
const RAMP_TICK_MS = 50;
const MIN_TICK_MS = 5;
const RATE_EPS = 1e-6;
const SEEK_EPS = 0.001;

const OWNER = "mix";
const neutralEnd = (c: Float32Array, i: number, v: number) => Float32Array.of(c[i], v);
const automation = (at: number, duration: number, l: Lane) =>
  ({ at, duration, volume: l.volume, eq: { lo: l.eqLo, mid: l.eqMid, hi: l.eqHi }, filter: l.filter });

/**
 * Arms `plan` from `outDeck` into `inDeck`: a mix schedules the incoming start and both decks' automation at
 * T0 = timeOf(outStartS); a cut hands over at one cut time tCut, for each engine/element combination.
 */
export function armTransition(outDeck: DeckId, inDeck: DeckId, plan: TransitionPlan, deps: RunnerDeps): Armed | { error: ArmError } {
  activeRunner.current?.dispose();
  const out = deps.transport(outDeck);
  const inn = deps.transport(inDeck);
  if (!out?.media || !inn?.media) return { error: "not-ready" };
  const outMedia: MediaLike = out.media;
  const inMedia: MediaLike = inn.media;
  const outEngine: StretchDeck | null = out.onEngine ? out.engine : null;
  const inEngine: StretchDeck | null = inn.onEngine ? inn.engine : null;
  const mix = plan.kind === "mix";
  if (mix && (!outEngine || !inEngine || !plan.curves)) return { error: "no-engine" };
  if (!inn.ready || inn.playing) return { error: "not-ready" };

  const startNow = deps.now();
  const rateOutAtArm = outEngine?.playbackRate ?? 1;
  if (mix && plan.windowAudioS > 0 && Math.abs((plan.outEndS - plan.outStartS) / plan.windowAudioS - rateOutAtArm) > 1e-4) return { error: "rate-changed" };

  // When the hand-over happens. Engine out: on its anchor. Element out: estimated until the boundary is seen.
  let t0: number;
  if (outEngine) {
    const t = outEngine.timeOf(mix ? plan.outStartS : plan.outEndS);
    if (t == null || t < startNow + (inEngine ? LEAD + ARM_MARGIN : 0)) return { error: "too-late" };
    t0 = t;
  } else {
    if (!out.playing && !outMedia.ended) return { error: "too-late" };
    t0 = startNow + Math.max(0, plan.outEndS - out.position());
  }
  let t1 = mix ? t0 + plan.windowAudioS : t0;

  // The incoming engine plays at rateIn (mix) or 1; the mixer is moved to match so MiniPlayer keeps that rate.
  const fxIn = deps.getMixer().fx[inDeck];
  const before = { range: fxIn.range, pitch: fxIn.pitch };
  const rateIn = mix ? plan.rateIn : null;
  const target = rateIn == null ? { range: before.range, pitch: 0 } : planRate(fxIn, rateIn) ?? { range: 0.5, pitch: (rateIn - 1) / 0.5 };
  let pitchMoved = false;
  const moveInPitch = () => {
    if (!inEngine || (rateIn == null && before.pitch === 0)) return;
    deps.setDeckRangePitch(inDeck, target.range, target.pitch);
    pitchMoved = true;
  };
  const restoreInPitch = () => { if (pitchMoved) deps.setDeckRangePitch(inDeck, before.range, before.pitch); pitchMoved = false; };

  // Owned actions: our own pause/seek events are never read as the user's.
  let owning = 0;
  const owned = (fn: () => void) => { owning++; try { fn(); } finally { owning--; } };
  const seeks = { out: 0, in: 0 };
  const seekIn = (s: number) => {
    if (Math.abs(inn.position() - s) <= SEEK_EPS) return; // MiniPlayer skips a no-op seek: no seeked would come
    seeks.in++;
    owned(() => inn.seekTo(s));
  };

  let inStarted = false;
  if (mix) {
    moveInPitch();
    if (inEngine!.playAt(t0, plan.inStartS, rateIn ?? 1) == null) { restoreInPitch(); return { error: "too-late" }; }
    inStarted = true;
    outEngine!.scheduleAutomation(automation(t0, plan.windowAudioS, plan.curves!.out));
    inEngine!.scheduleAutomation(automation(t0, plan.windowAudioS, plan.curves!.in));
    if (plan.loop) outEngine!.setLoop(plan.loop.start, plan.loop.end);
  } else if (outEngine && inEngine) {
    moveInPitch();
    if (inEngine.playAt(t0, plan.inStartS, 1) == null) { restoreInPitch(); return { error: "too-late" }; }
    inStarted = true;
    outEngine.scheduleAutomation({ at: t0, duration: 0.01, volume: Float32Array.of(1, 0) }); // sample-accurate cut
  } else if (!inEngine) {
    seekIn(plan.inStartS);
  }
  setTransportOwner(outDeck, OWNER);
  setTransportOwner(inDeck, OWNER);

  let phase: "armed" | "done" | "aborted" = "armed";
  let closed = false;
  let reason: string | null = null;
  let started = false;
  let triggered = false; // element-out cut: the incoming deck has been started
  let outEnded = false;
  let settle!: (r: RunnerResult) => void;
  const done = new Promise<RunnerResult>(resolve => { settle = resolve; });

  let timer: (() => void) | null = null;
  const clearTimer = () => { timer?.(); timer = null; };
  const wake = (ms: number) => {
    clearTimer();
    const cancel: () => void = deps.setTimer(() => { if (timer !== cancel) return; timer = null; step(); }, ms);
    timer = cancel;
  };

  const listeners: [MediaLike, string, () => void][] = [];
  const listen = (m: MediaLike, type: string, fn: () => void) => { m.addEventListener(type, fn); listeners.push([m, type, fn]); };
  const detach = () => { for (const [m, type, fn] of listeners.splice(0)) m.removeEventListener(type, fn); };
  const live = () => !closed && phase === "armed";
  const releaseOwners = () => { setTransportOwner(outDeck, null); setTransportOwner(inDeck, null); };
  /** Terminal first (listeners off, timers off), then the owned actions. */
  const end = (p: "done" | "aborted") => { phase = p; detach(); clearTimer(); };

  // Ramp-back of the incoming deck's tempo after a tempo-matched mix: progress from elapsed audio time.
  let ramp: { start: number; seconds: number; pitch: number; cancel: (() => void) | null } | null = null;
  const finishRamp = () => {
    if (!ramp) return;
    ramp.cancel?.();
    ramp = null;
    deps.setDeckRangePitch(inDeck, before.range, 0);
  };
  const rampTick = () => {
    const r = ramp;
    if (closed || !r) return;
    const p = Math.min(1, Math.max(0, (deps.now() - r.start) / r.seconds));
    if (p >= 1) { finishRamp(); return; }
    deps.setDeckPitch(inDeck, r.pitch * (1 - p));
    const cancel: () => void = deps.setTimer(() => { if (ramp?.cancel === cancel) rampTick(); }, RAMP_TICK_MS);
    r.cancel = cancel;
  };

  const complete = (now: number) => {
    end("done");
    started = true;
    owned(() => out.pause());
    outEngine!.clearLoop();
    inEngine!.cancelAutomation("neutral");
    outEngine!.cancelAutomation("neutral", now + AFTER_HALT);
    releaseOwners();
    settle("completed");
    if (rateIn == null || !pitchMoved) return;
    const grid = deps.transport(inDeck)?.grid ?? inn.grid;
    const barS = grid ? barSeconds(grid, inEngine!.currentTime) : (plan.outEndS - plan.outStartS) / plan.bars;
    ramp = { start: now, seconds: (plan.rampBackBars * barS) / rateIn, pitch: target.pitch, cancel: null };
    pitchMoved = false; // the ramp owns the way back
    const cancel: () => void = deps.setTimer(() => { if (ramp?.cancel === cancel) rampTick(); }, RAMP_TICK_MS);
    ramp.cancel = cancel;
  };

  const finishCut = (now: number) => {
    end("done");
    started = true;
    if (!inEngine) owned(() => inn.play());
    owned(() => out.pause());
    if (outEngine) outEngine.cancelAutomation("neutral", now + AFTER_HALT);
    releaseOwners();
    settle("cut");
  };

  /** Element out → engine in: anchor the incoming start just ahead of now; the out deck stops at a wake-up ≥ tCut. */
  const triggerElementCut = (now: number) => {
    triggered = true;
    if (!inEngine) { finishCut(now); return; }
    moveInPitch();
    const tCut = inEngine.playAt(now + LEAD + ARM_MARGIN, plan.inStartS, 1) ?? inEngine.playAt(now + RETRY_AHEAD, plan.inStartS, 1);
    if (tCut == null) { abort("no-start"); return; }
    inStarted = true;
    t0 = t1 = tCut;
  };

  const abort = (why: string) => {
    if (!live()) return;
    reason = why;
    const now = deps.now();
    end("aborted");
    if (mix && now >= t0) {
      // Jump to the end state: the outgoing deck stops, the incoming glides to neutral over one bar at its current rate.
      owned(() => out.pause());
      outEngine!.clearLoop();
      outEngine!.cancelAutomation("neutral", now + AFTER_HALT);
      const c = plan.curves!.in;
      const i = Math.round(Math.min(1, Math.max(0, (now - t0) / plan.windowAudioS)) * (c.volume.length - 1));
      inEngine!.cancelAutomation("hold", now);
      inEngine!.scheduleAutomation({
        at: now + 0.01, duration: plan.windowAudioS / plan.bars, volume: neutralEnd(c.volume, i, 1),
        eq: { lo: neutralEnd(c.eqLo, i, 0), mid: neutralEnd(c.eqMid, i, 0), hi: neutralEnd(c.eqHi, i, 0) }, filter: neutralEnd(c.filter, i, 0),
      });
      started = true;
      // A user takeover keeps the incoming deck at its matched rate; a dispose («Διακοπή», cleanup) puts it back at
      // the range from before at pitch 0, the same end state as a finished ramp-back.
      if (why === "disposed" && pitchMoved) deps.setDeckRangePitch(inDeck, before.range, 0);
      pitchMoved = false;
    } else {
      if (inStarted) owned(() => inn.pause());
      if (mix && plan.loop) outEngine!.clearLoop();
      outEngine?.cancelAutomation("neutral");
      if (mix) inEngine?.cancelAutomation("neutral");
      restoreInPitch();
    }
    releaseOwners();
    settle("aborted");
  };

  /** True when an unowned pause on the outgoing deck is its own end (the engine's finish(), an element's end). */
  const naturalEnd = (now: number) => now >= t1 - NATURAL_END || outMedia.currentTime >= out.duration - NATURAL_END;

  function step() {
    if (!live()) return;
    const now = deps.now();
    if (outEngine && Math.abs(outEngine.playbackRate - rateOutAtArm) > RATE_EPS) { abort("rate-changed"); return; }
    let due: number | null;
    if (mix) {
      due = t1 + COMPLETE_AFTER;
      if (now >= due) { complete(now); return; }
    } else if (outEngine || triggered) {
      due = t0;
      if (now >= due || outEnded) { finishCut(now); return; }
    } else {
      const early = ELEMENT_EARLY + (inEngine ? LEAD : 0);
      if (outEnded || outMedia.ended || outMedia.currentTime >= plan.outEndS - early) { triggerElementCut(now); step(); return; }
      due = null;
    }
    wake(due == null ? TICK_MS : Math.min(TICK_MS, Math.max(MIN_TICK_MS, Math.ceil((due - now) * 1000))));
  }

  const onPause = (side: "out" | "in") => () => {
    if (!live() || owning > 0) return;
    if (side === "out" && naturalEnd(deps.now())) { outEnded = true; step(); return; }
    abort("pause");
  };
  const onSeeking = (side: "out" | "in") => () => { if (live() && seeks[side] === 0) abort("seek"); };
  const onSeeked = (side: "out" | "in") => () => { if (seeks[side] > 0) seeks[side]--; };

  // Listeners only now: arming's own play/playing events are not the user's.
  listen(outMedia, "pause", onPause("out"));
  listen(outMedia, "seeking", onSeeking("out"));
  listen(outMedia, "seeked", onSeeked("out"));
  listen(outMedia, "ended", () => { if (live()) { outEnded = true; step(); } });
  listen(outMedia, "timeupdate", () => step());
  listen(inMedia, "pause", onPause("in"));
  listen(inMedia, "seeking", onSeeking("in"));
  listen(inMedia, "seeked", onSeeked("in"));

  const armed: Armed = {
    get t0() { return t0; },
    get t1() { return t1; },
    get state() { return phase === "armed" ? (deps.now() >= t0 ? "running" : "armed") : phase; },
    get reason() { return reason; },
    get started() { return started; },
    get ramping() { return ramp !== null; },
    settleTempo: finishRamp,
    abort,
    dispose() {
      if (closed) return;
      abort("disposed");
      closed = true;
      clearTimer();
      detach();
      finishRamp();
      if (activeRunner.current === armed) activeRunner.current = null;
    },
    done,
  };
  activeRunner.current = armed;
  step();
  return armed;
}
