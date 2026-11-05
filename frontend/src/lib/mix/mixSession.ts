// A set played as one continuous mix: a module store with a pure reducer (`nextStep`) and the conductor loop
// (`runConductor`) that the headless <MixConductor/> runs. Timers are wake-ups, never clocks: every step re-reads the
// audio clock. The runner (`transitionRunner.ts`) executes each transition; this file decides when and what.
import { useSyncExternalStore } from "react";
import { barSeconds, snapToBar } from "../beatGrid";
import type { DeckId, DeckSlots, LoadOptions } from "../player";
import { MIX_COPY } from "../transitions/copy";
import { planTransition, type LaneInput, type TransitionPlan } from "../transitions/planner";
import { PRESETS } from "../transitions/presets";
import type { Preset, SetTransition, TransitionParams } from "../transitions/types";
import type { Track } from "../types";
import type { DeckTransport } from "./deckTransport";
import { activeRunner, armTransition, type Armed, type ArmError, type RunnerDeps, type RunnerResult } from "./transitionRunner";

export type MixStatus = "idle" | "loading" | "playing" | "armed" | "transitioning" | "stopping";
export interface QueueEntry { trackId: number; track: Track; transition: SetTransition | null }

export interface MixSession {
  /** Bumped on every start; the conductor sets a session up once per id. */
  id: number;
  status: MixStatus;
  mode: "set" | "preview";
  setId: number | null;
  setTitle: string;
  /** From the playing track on; `transition` leads from this entry to the next one. */
  queue: QueueEntry[];
  index: number;
  currentDeck: DeckId;
  /** The track each deck must hold; `token` is the slot token once seen (ADOPT / TO_LOAD before that). */
  expected: Record<DeckId, { trackId: number; token: number } | null>;
  ready: Record<DeckId, boolean>;
  /** Audio time of the next hand-over (planned while playing, the runner's T0 once armed). */
  transitionAt: number | null;
  transitionPreset: Preset | null;
  restore: { keylock: Record<DeckId, boolean>; range: Record<DeckId, number> } | null;
  error: string | null;
  /** Bumped whenever the conductor must (re-)arm. */
  attempt: number;
  /** Missed arm deadlines for this transition (one re-plan, then a cut, then a stop). */
  replans: number;
  /** The next hand-over is a cut at outEnd (late readiness or a second missed deadline). */
  forceCut: boolean;
  /** «Παράλειψη» was used for this transition (at most once). */
  skipped: boolean;
}

/** Expected-slot tokens before a real one is seen: the caller loaded it (ADOPT; a loaded slot's token is ≥ 1) or the conductor must (TO_LOAD). */
export const ADOPT = 0;
export const TO_LOAD = -1;

export const MIX_MESSAGES = {
  notLoaded: MIX_COPY.notLoaded,
  deckChanged: "Η μίξη σταμάτησε: άλλαξε το deck",
  trackRemoved: "Η μίξη σταμάτησε: το track αφαιρέθηκε από το set",
  armFailed: "Η μίξη σταμάτησε: η μετάβαση δεν ξεκίνησε εγκαίρως",
  takeover: "Η μίξη σταμάτησε: χειροκίνητος έλεγχος",
} as const;

export interface StartInput {
  mode: "set" | "preview"; setId: number | null; setTitle: string; tracks: Track[]; transitions: SetTransition[]; startIndex: number;
  restore: MixSession["restore"];
}

export type MixEvent =
  | ({ type: "start"; id: number } & StartInput)
  | { type: "ready"; deck: DeckId }
  /** `t0` / `outEnd`: audio times the planned window starts / the outgoing deck reaches the plan's end (null: not playing). */
  | { type: "tick"; now: number; t0: number | null; outEnd: number | null }
  | { type: "armed"; t0: number }
  | { type: "armFailed"; error: ArmError }
  /** `started`: the window had begun when the runner aborted (it left the incoming deck playing). */
  | { type: "transitionDone"; result: RunnerResult; reason: string | null; started?: boolean }
  | { type: "slotChanged"; deck: DeckId; token: number; trackId: number }
  | { type: "ejected"; deck: DeckId }
  | { type: "readyTimeout" }
  | { type: "setChanged"; tracks: Track[]; transitions: SetTransition[] }
  | { type: "skip"; now: number }
  | { type: "stop"; reason: string }
  | { type: "stopped" }
  | { type: "ended" };

/** Arm no later than 4 s before the window, and at least 8 s before the plan's end; give up 2 s before that end. */
const ARM_LEAD_S = 4;
const ARM_BEFORE_END_S = 8;
const LAST_CHANCE_S = 2;

const IDLE: MixSession = {
  id: 0, status: "idle", mode: "set", setId: null, setTitle: "", queue: [], index: 0, currentDeck: "A", expected: { A: null, B: null },
  ready: { A: false, B: false }, transitionAt: null, transitionPreset: null, restore: null, error: null, attempt: 0, replans: 0,
  forceCut: false, skipped: false,
};

export const otherDeck = (d: DeckId): DeckId => (d === "A" ? "B" : "A");
const live = (s: MixSession) => s.status !== "idle" && s.status !== "stopping";
const stopWith = (s: MixSession, error: string | null): MixSession => ({ ...s, status: "stopping", error });

function toQueue(tracks: Track[], transitions: SetTransition[]): QueueEntry[] {
  return tracks.map((track, i) => {
    const to = tracks[i + 1];
    const transition = to ? transitions.find(t => t.from_track_id === track.id && t.to_track_id === to.id) ?? null : null;
    return { trackId: track.id, track, transition };
  });
}
const presetOf = (e: QueueEntry | undefined): Preset | null => (e ? e.transition?.preset ?? "fade" : null);
/** The armed window has begun by the audio clock, though the next tick has not turned the status yet. */
export const inTransitionWindow = (s: MixSession, now: number): boolean =>
  s.status === "transitioning" || (s.status === "armed" && s.transitionAt != null && now >= s.transitionAt);
/** «Παράλειψη» is possible: once per transition, the next deck ready, and never once the window has begun. */
export const canSkip = (s: MixSession, now: number): boolean =>
  (s.status === "playing" || s.status === "armed") && !s.skipped && !!s.queue[s.index + 1] && s.ready[otherDeck(s.currentDeck)]
  && !inTransitionWindow(s, now);
/** Fresh per-transition bookkeeping. */
const freshPair = { transitionAt: null, replans: 0, forceCut: false, skipped: false } as const;

/** Pure: the session after one event. Returns `s` itself when nothing changes. */
export function nextStep(s: MixSession, e: MixEvent): MixSession {
  switch (e.type) {
    case "start": {
      const queue = toQueue(e.tracks, e.transitions).slice(Math.max(0, e.startIndex));
      if (!queue.length) return s;
      return {
        ...IDLE, id: e.id, status: "loading", mode: e.mode, setId: e.setId, setTitle: e.setTitle, queue, index: 0, currentDeck: "A",
        expected: { A: { trackId: queue[0].trackId, token: ADOPT }, B: queue[1] ? { trackId: queue[1].trackId, token: ADOPT } : null },
        transitionPreset: presetOf(queue[0]),
        // Replacing a live session keeps the user's values from before the first one.
        restore: live(s) && s.restore ? s.restore : e.restore,
      };
    }
    case "ready": {
      if (!live(s) || !s.expected[e.deck] || s.ready[e.deck]) return s;
      const ready = { ...s.ready, [e.deck]: true };
      const next = s.queue[s.index + 1];
      const both = ready[s.currentDeck] && (!next || ready[otherDeck(s.currentDeck)]);
      return { ...s, ready, status: s.status === "loading" && both ? "playing" : s.status };
    }
    case "tick": {
      if (s.status === "armed") return s.transitionAt != null && e.now >= s.transitionAt ? { ...s, status: "transitioning" } : s;
      // Loading with the current deck playing: the readiness policy already runs (the next deck may be the slow one).
      if (s.status !== "playing" && !(s.status === "loading" && s.ready[s.currentDeck])) return s;
      const base = e.t0 === s.transitionAt ? s : { ...s, transitionAt: e.t0 };
      if (!s.queue[s.index + 1] || e.t0 == null || e.outEnd == null) return base;
      const deadline = s.mode === "preview" ? -Infinity : Math.min(e.t0 - ARM_LEAD_S, e.outEnd - ARM_BEFORE_END_S);
      if (e.now < deadline) return base;
      if (s.status === "playing" && s.ready[otherDeck(s.currentDeck)]) return { ...base, status: "armed", attempt: s.attempt + 1 };
      if (e.now >= e.outEnd - LAST_CHANCE_S) return stopWith(base, MIX_MESSAGES.notLoaded);
      return base.forceCut ? base : { ...base, forceCut: true };
    }
    case "armed":
      return s.status === "armed" ? { ...s, transitionAt: e.t0 } : s;
    case "armFailed": {
      if (s.status !== "armed") return s;
      if (e.error === "not-ready") return { ...s, status: "playing" };
      if (s.replans === 0) return { ...s, replans: 1, attempt: s.attempt + 1 };
      if (!s.forceCut) return { ...s, replans: 2, forceCut: true, attempt: s.attempt + 1 };
      return stopWith(s, MIX_MESSAGES.armFailed);
    }
    case "transitionDone": {
      if (s.status !== "armed" && s.status !== "transitioning") return s;
      if (e.result === "aborted") {
        // The outgoing tempo moved before T0: plan again. After T0 the runner left the incoming deck playing: hand over.
        // Decided by the runner's audio time, not the status, which turns "transitioning" only on the next tick.
        if (e.reason !== "rate-changed") return stopWith(s, MIX_MESSAGES.takeover);
        if (!e.started) return { ...s, status: "playing", ...freshPair };
      }
      const index = s.index + 1;
      const freed = s.currentDeck;
      const after = s.queue[index + 1];
      return {
        ...s, ...freshPair, status: "playing", index, currentDeck: otherDeck(freed),
        expected: { ...s.expected, [freed]: after ? { trackId: after.trackId, token: TO_LOAD } : null },
        ready: { ...s.ready, [freed]: false }, transitionPreset: presetOf(s.queue[index + 1] ? s.queue[index] : undefined),
      };
    }
    case "slotChanged": {
      const exp = s.expected[e.deck];
      if (!live(s) || !exp) return s;
      if (exp.token <= ADOPT) return e.trackId === exp.trackId ? { ...s, expected: { ...s.expected, [e.deck]: { trackId: exp.trackId, token: e.token } } } : s;
      return e.trackId === exp.trackId && e.token === exp.token ? s : stopWith(s, MIX_MESSAGES.deckChanged);
    }
    case "ejected":
      return live(s) && s.expected[e.deck] ? stopWith(s, MIX_MESSAGES.deckChanged) : s;
    case "readyTimeout":
      return live(s) ? stopWith(s, MIX_MESSAGES.notLoaded) : s;
    case "setChanged": {
      if (!live(s)) return s;
      const cur = s.queue[s.index];
      const entries = toQueue(e.tracks, e.transitions);
      const pos = entries.findIndex(q => q.trackId === cur.trackId);
      if (pos < 0) return stopWith(s, MIX_MESSAGES.trackRemoved);
      let queue = entries.slice(pos);
      const committed = s.status === "armed" || s.status === "transitioning";
      const oldNext = s.queue[s.index + 1];
      if (committed && oldNext && queue[1]?.trackId !== oldNext.trackId) {
        // The armed pair plays out; the new order resumes after the incoming track (if it is still in the set).
        const npos = entries.findIndex(q => q.trackId === oldNext.trackId);
        queue = [{ ...queue[0], transition: cur.transition }, ...(npos >= 0 ? entries.slice(npos) : [oldNext])];
      }
      const nextDeck = otherDeck(s.currentDeck);
      const next = queue[1];
      let { expected, ready } = s;
      if (!committed && (s.expected[nextDeck]?.trackId ?? null) !== (next?.trackId ?? null)) {
        expected = { ...expected, [nextDeck]: next ? { trackId: next.trackId, token: TO_LOAD } : null };
        ready = { ...ready, [nextDeck]: false };
      }
      return { ...s, queue, index: 0, expected, ready, transitionPreset: presetOf(next ? queue[0] : undefined) };
    }
    case "skip":
      return canSkip(s, e.now) ? { ...s, status: "armed", skipped: true, attempt: s.attempt + 1 } : s;
    case "stop":
      return live(s) ? stopWith(s, null) : s;
    case "stopped":
      return s.status === "stopping" ? { ...s, status: "idle", transitionAt: null } : s;
    case "ended": {
      if (!live(s)) return s;
      if (s.index >= s.queue.length - 1) return { ...s, status: "idle", transitionAt: null };
      return s.status === "playing" ? stopWith(s, MIX_MESSAGES.armFailed) : s;
    }
  }
}

// ---- store ---------------------------------------------------------------------------------------------------

let state: MixSession = IDLE;
let seq = 0;
const listeners = new Set<() => void>();
export function dispatchMix(e: MixEvent): void {
  const next = nextStep(state, e);
  if (next === state) return;
  state = next;
  listeners.forEach(l => l());
}
export const getMixSession = (): MixSession => state;
export function subscribeMix(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const useMixSession = (): MixSession => useSyncExternalStore(subscribeMix, getMixSession, getMixSession);
/** Status only, so the app shell re-renders on status changes, not on every countdown tick. */
export const useMixStatus = (): MixStatus => useSyncExternalStore(subscribeMix, () => state.status, () => state.status);

/** The conductor's audio clock, for the countdown; 0 without a conductor. */
let clock: () => number = () => 0;
export const mixClock = (): number => clock();

/** Called after the caller loaded the first pair inside the click gesture (B then A). */
export function startMixSession(input: StartInput): void { dispatchMix({ type: "start", id: ++seq, ...input }); }
export function stopMixSession(reason: string): void { dispatchMix({ type: "stop", reason }); }
export function skipToTransition(): void { dispatchMix({ type: "skip", now: mixClock() }); }
export function notifyMixSetChanged(setId: number, tracks: Track[], transitions: SetTransition[]): void {
  if (state.setId === setId) dispatchMix({ type: "setChanged", tracks, transitions });
}

// Polite screen-reader announcements of state changes, read by the region AppShell mounts permanently.
let announcement = "";
const announceListeners = new Set<() => void>();
export function announceMix(text: string): void { announcement = text; announceListeners.forEach(l => l()); }
const subscribeAnnouncement = (l: () => void) => { announceListeners.add(l); return () => { announceListeners.delete(l); }; };
export const useMixAnnouncement = (): string => useSyncExternalStore(subscribeAnnouncement, () => announcement, () => announcement);

// ---- conductor -----------------------------------------------------------------------------------------------

export interface ConductorDeps extends RunnerDeps {
  setDeckKeylock(deck: DeckId, on: boolean): void;
  setCrossfader(value: number): void;
  /** The player's slots as last rendered. */
  slots(): DeckSlots;
  load(deck: DeckId, track: Track, opts: LoadOptions): boolean;
  toast(message: string): void;
  announce(message: string): void;
}
export interface Conductor { step(): void; dispose(): void }

const TICK_MS = 250;
const MAX_ROUNDS = 8;
const ANNOUNCE_AHEAD_S = 30;
const PREVIEW_LEAD_BARS = 4;
const PREVIEW_TAIL_BARS = 2;
const SEEK_EPS = 0.001;
/** A row-less pair (e.g. right after a reorder) mixes as «Ξεθώριασμα». */
const DEFAULT_PARAMS: TransitionParams = { ...PRESETS.fade, preset: "fade", out_anchor_s: null, in_anchor_s: null, tempo_match: true };

const laneOf = (t: DeckTransport): LaneInput =>
  ({ trackId: t.trackId ?? 0, grid: t.grid, duration: t.duration, cues: t.cues, rate: t.rate, onEngine: t.onEngine });
/** A cut where the mix window would have ended. */
const asCut = (p: TransitionPlan): TransitionPlan => p.kind === "cut" ? p
  : { ...p, kind: "cut", outStartS: p.outEndS, inEndS: p.inStartS, windowAudioS: 0, bars: 0, rateIn: null, loop: null, curves: null };

/** One session set up per id, across conductor instances (StrictMode, remounts). */
let preparedSession = 0;

/**
 * The effect loop behind <MixConductor/>: reads the store, the slots and the deck transports on every wake-up and
 * acts (pre-loads, plans, arms, restores). Store changes and `step()` (slot changes) wake it; while a session is
 * live a 250 ms wake-up keeps it ticking. `dispose()` aborts the live runner.
 */
export function runConductor(deps: ConductorDeps): Conductor {
  let disposed = false;
  let stepping = false;
  let again = false;
  let timer: (() => void) | null = null;
  let session = 0; // the session this conductor is driving
  let runner: Armed | null = null;
  let runnerAttempt = -1;
  const requested: Record<DeckId, number | null> = { A: null, B: null };
  let preview: { stage: "idle" | "seeking" | "starting" | "running"; detach: () => void } = { stage: "idle", detach: () => {} };
  let previewStopAt: number | null = null;
  let announcedFor = "";
  clock = deps.now;

  const wake = (ms: number) => {
    timer?.();
    timer = disposed ? null : deps.setTimer(() => { timer = null; step(); }, ms);
  };
  // Store changes are handled on a 0 ms wake-up: a click handler's loads render before it, so the slots are current.
  const unsubscribe = subscribeMix(() => { if (stepping) again = true; else wake(0); });

  function step() {
    if (disposed) return;
    if (stepping) { again = true; return; }
    stepping = true;
    try {
      for (let i = 0; i < MAX_ROUNDS; i++) {
        again = false;
        once();
        if (!again || disposed) break;
      }
    } finally { stepping = false; }
    if (!disposed && state.status !== "idle") wake(TICK_MS);
  }

  function teardown(ended: MixSession | null) {
    preview.detach();
    preview = { stage: "idle", detach: () => {} };
    previewStopAt = null;
    activeRunner.current?.dispose();
    runner = null;
    runnerAttempt = -1;
    requested.A = requested.B = null;
    session = 0;
    if (!ended) return; // replaced by a new session: it keeps the restore and sets itself up
    if (ended.mode === "preview") for (const d of ["A", "B"] as const) deps.transport(d)?.pause();
    const r = ended.restore;
    if (r) {
      for (const d of ["A", "B"] as const) {
        deps.setDeckKeylock(d, r.keylock[d]);
        if (deps.getMixer().fx[d].range !== r.range[d]) deps.setDeckRangePitch(d, r.range[d], 0);
      }
    }
    if (ended.error) deps.toast(ended.error);
    const finished = ended.status === "idle"; // the last track ended; a stop goes through "stopping"
    deps.announce(ended.error ?? (ended.mode === "preview" ? "Η προεπισκόπηση σταμάτησε" : finished ? "Η μίξη τελείωσε" : "Η μίξη σταμάτησε"));
    preparedSession = 0;
  }

  function setUp(s: MixSession) {
    session = s.id;
    if (preparedSession === s.id) return;
    preparedSession = s.id;
    deps.setDeckKeylock("A", true);
    deps.setDeckKeylock("B", true);
    const m = deps.getMixer();
    if (!m.midiConnected) deps.setCrossfader(0);
    const xf = m.midiConnected ? m.crossfader : 0;
    if (m.volume.A === 0 || m.volume.B === 0 || Math.abs(xf) > 0.05) deps.toast("Για τη μίξη: ανέβασε τα faders και των δύο decks και κέντραρε το crossfader");
    deps.announce(s.mode === "preview" ? "Η προεπισκόπηση ξεκίνησε" : "Η μίξη ξεκίνησε");
  }

  /** Adopts the expected loads, pre-loads what the conductor owes, reports ejects and foreign loads. */
  function syncSlots(s: MixSession) {
    const slots = deps.slots();
    for (const d of ["A", "B"] as const) {
      const exp = s.expected[d];
      if (!exp) { requested[d] = null; continue; }
      const slot = slots[d];
      if (exp.token <= ADOPT) {
        if (slot.track?.id === exp.trackId) dispatchMix({ type: "slotChanged", deck: d, token: slot.token, trackId: exp.trackId });
        else if (exp.token === TO_LOAD && requested[d] !== exp.trackId) {
          const entry = s.queue.find(q => q.trackId === exp.trackId);
          requested[d] = exp.trackId;
          if (entry) deps.load(d, entry.track, { play: false });
        }
        continue;
      }
      if (!slot.track) dispatchMix({ type: "ejected", deck: d });
      else if (slot.track.id !== exp.trackId || slot.token !== exp.token) dispatchMix({ type: "slotChanged", deck: d, token: slot.token, trackId: slot.track.id });
    }
  }

  function syncReady(s: MixSession) {
    for (const d of ["A", "B"] as const) {
      const exp = s.expected[d];
      if (!exp || exp.token <= ADOPT || s.ready[d]) continue;
      const t = deps.transport(d);
      if (t?.ready && t.trackId === exp.trackId) dispatchMix({ type: "ready", deck: d });
    }
  }

  /** The plan for the current pair; the incoming lane is provisional (outgoing grid, unbounded) until that deck is ready. */
  function planFor(s: MixSession, outAnchor: number | null = null): { plan: TransitionPlan; out: DeckTransport } | null {
    const entry = s.queue[s.index];
    const out = deps.transport(s.currentDeck);
    const inn = deps.transport(otherDeck(s.currentDeck));
    if (!entry || !s.queue[s.index + 1] || !out?.media) return null;
    const inReady = s.ready[otherDeck(s.currentDeck)] && inn?.ready;
    const inLane: LaneInput = inReady && inn ? laneOf(inn)
      : { trackId: 0, grid: out.grid, duration: Number.MAX_VALUE, cues: [], rate: 1, onEngine: out.onEngine };
    let params = entry.transition ?? DEFAULT_PARAMS;
    if (outAnchor != null) params = { ...params, out_anchor_s: outAnchor };
    const plan = planTransition(laneOf(out), inLane, params);
    return { plan: s.forceCut ? asCut(plan) : plan, out };
  }

  /** Audio time the outgoing deck reaches source position `src` (estimated for an element deck). */
  function timeAt(out: DeckTransport, src: number, now: number): number | null {
    if (out.onEngine && out.engine) return out.engine.timeOf(src);
    return out.playing ? now + (src - out.position()) / (out.rate || 1) : null;
  }

  function tick(s: MixSession, now: number) {
    const p = planFor(s);
    const t0 = p ? timeAt(p.out, p.plan.kind === "mix" ? p.plan.outStartS : p.plan.outEndS, now) : null;
    const outEnd = p ? timeAt(p.out, p.plan.outEndS, now) : null;
    dispatchMix({ type: "tick", now, t0, outEnd });
    if (!s.forceCut && state.id === s.id && state.forceCut) { // late readiness turned the next hand-over into a cut
      deps.toast(MIX_COPY.lateCut);
      deps.announce(MIX_COPY.lateCut);
    }
    const key = `${s.id}:${s.index}`;
    if (s.status === "playing" && t0 != null && t0 - now <= ANNOUNCE_AHEAD_S && t0 > now && announcedFor !== key) {
      announcedFor = key;
      deps.announce(`μετάβαση σε ${Math.round(t0 - now)} δ.`);
    }
  }

  function arm(s: MixSession) {
    runnerAttempt = s.attempt;
    const out = deps.transport(s.currentDeck);
    // «Παράλειψη»: the window starts on the next bar line at least 0.5 s ahead.
    const skipAnchor = s.skipped && out?.grid ? snapToBar(out.grid, out.position() + 0.5, "up") : null;
    runner = null; // a stale runner's `done` must not count once this attempt replaces it
    const p = planFor(s, skipAnchor);
    if (!p) { dispatchMix({ type: "armFailed", error: "not-ready" }); return; }
    const r = armTransition(s.currentDeck, otherDeck(s.currentDeck), p.plan, deps);
    if ("error" in r) { dispatchMix({ type: "armFailed", error: r.error }); return; }
    runner = r;
    const grid = p.out.grid;
    const tail = PREVIEW_TAIL_BARS * (grid ? barSeconds(grid, p.plan.outEndS) : 2);
    dispatchMix({ type: "armed", t0: r.t0 });
    void r.done.then(result => {
      if (disposed || runner !== r || state.id !== s.id) return;
      if (s.mode === "preview" && result !== "aborted") previewStopAt = r.t1 + tail;
      dispatchMix({ type: "transitionDone", result, reason: r.reason, started: r.started });
    });
  }

  /** Preview: seek A 4 bars before the window (listeners first; a no-op seek counts as settled), play it, then arm. */
  function previewStart(s: MixSession) {
    if (preview.stage !== "idle") return;
    const p = planFor(s);
    const media = p?.out.media;
    if (!p || !media) return;
    const grid = p.out.grid;
    const startS = p.plan.kind === "mix" ? p.plan.outStartS : p.plan.outEndS;
    const target = Math.max(0, startS - PREVIEW_LEAD_BARS * (grid ? barSeconds(grid, startS) : 2));
    const play = () => { preview.stage = "starting"; deps.transport(s.currentDeck)?.play(); };
    const onSeeked = () => { if (preview.stage === "seeking") play(); };
    const onPlaying = () => {
      if (preview.stage !== "starting") return;
      preview.stage = "running";
      preview.detach();
      wake(0);
    };
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("playing", onPlaying);
    preview = { stage: "idle", detach: () => { media.removeEventListener("seeked", onSeeked); media.removeEventListener("playing", onPlaying); } };
    if (Math.abs(p.out.position() - target) <= SEEK_EPS) { play(); return; }
    preview.stage = "seeking";
    p.out.seekTo(target);
  }

  function once() {
    let s = state;
    if (session && (s.id !== session || !live(s))) teardown(s.id === session ? s : null);
    s = state;
    if (s.status === "stopping") { dispatchMix({ type: "stopped" }); return; }
    if (s.status === "idle") return;
    if (!session) setUp(s);
    syncSlots(s);
    if (state !== s) return; // re-run on the new state
    syncReady(s);
    if (state !== s) return;
    const now = deps.now();
    if (s.status === "loading") { if (s.mode === "set" && s.ready[s.currentDeck]) tick(s, now); return; }
    if (s.mode === "preview" && preview.stage !== "running") {
      if (s.status === "playing") previewStart(s);
      return;
    }
    if (previewStopAt != null && now >= previewStopAt) { stopMixSession("preview-end"); return; }
    const out = deps.transport(s.currentDeck);
    if (s.status === "playing" && out?.media?.ended) { dispatchMix({ type: "ended" }); return; }
    if (s.status === "armed" && runnerAttempt !== s.attempt) { arm(s); return; }
    if (s.status === "transitioning" && !runner) { dispatchMix({ type: "transitionDone", result: "aborted", reason: "lost" }); return; }
    tick(s, now);
  }

  wake(0); // pick up a session that is already live (a remount)
  return {
    step,
    dispose() {
      if (disposed) return;
      disposed = true;
      timer?.();
      timer = null;
      unsubscribe();
      preview.detach();
      activeRunner.current?.dispose();
      if (clock === deps.now) clock = () => 0;
    },
  };
}
