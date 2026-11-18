// Experimental VST3 plugin slots (desktop, macOS): Deck A, Deck B and Master. Each deck's input on the bus → the tap
// worklet's own input (A → 0, B → 1) → 4-channel headed frames through a shared ring (when the page is cross-origin
// isolated) or a MessagePort → worker → loopback WebSocket → the native host (deck slots, PDC, sum, master slot) →
// default output. Off at every launch, two-deck mode only. A set recording and the slots refuse each other.
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { nativeAction } from "./desktopRuntime";
import { fxRackReady } from "./fxRackHost";
import { playbackContext } from "./playbackAudio";
import { setDeckSink, withMasterDip } from "./audio/masterBus";
import { createRing, waitAsync } from "./audio/masterRing";
import { setHostDelayMs } from "./hostDelay";
import { setPref } from "./prefs";
import { recordingActive } from "./recorder";
import { suspendMaximizer, syncMaximizer } from "./useMaximizer";

export type HostSlot = "deck_a" | "deck_b" | "master";
export const HOST_SLOTS: readonly HostSlot[] = ["deck_a", "deck_b", "master"];
export const HOST_SLOT_LABEL: Record<HostSlot, string> = { deck_a: "Deck A", deck_b: "Deck B", master: "Master" };
/** A path per slot; null = «Κανένα». */
export type HostSlotPaths = Record<HostSlot, string | null>;
export type HostFault = "error" | "slow" | "reload";
/** One slot's live stats from the native host; null in `slots` when that slot is empty. */
export interface HostSlotStats {
  name: string;
  /** The plugin's own latency, frames. */
  latency: number;
  /** The compensation delay its deck gets, frames. */
  comp: number;
  bypassed: boolean;
  fault: HostFault | null;
  load_pct: number;
}
/** A slot that loaded at start. */
export interface HostSlotInfo { name: string; restored: boolean }

export interface MasterHostPlugin { name: string; path: string }
export interface MasterHostStats {
  ring_fill: number; underruns: number; frames_out: number; sample_rate: number; device_buffer: number; plugin_latency: number; latency_ms: number;
  /** Longest wait between two audio frames in the last half second: arriving at the worker, and arriving at the host. */
  tap_gap_ms: number; max_gap_ms: number; dropped: number; trims: number;
  /** The same gaps as session maxima, and how many waits exceeded 20 ms at each end. */
  tap_gap_session_ms: number; gap_session_ms: number; tap_late: number; late: number;
  /** Audio the host keeps queued against those gaps, and the longest freeze of the page's own thread (last half second, session). */
  cushion_ms: number; ui_stall_ms: number; ui_stall_session_ms: number;
  /** The reserve's ceiling. The reserve itself (cushion_ms) only grows during a session. */
  cushion_max_ms: number;
  /** How the audio reaches the worker; on the shared path, blocks the full ring dropped and its deepest wait (session). */
  path: "shared" | "port"; ring_overruns: number; ring_peak_ms: number;
  /** The decks' alignment delay (frames; it only grows during a session) and the audio callback's load (%). */
  pdc: number; callback_load_pct: number;
  slots: Record<HostSlot, HostSlotStats | null>;
}
export type MasterHostState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "on"; slots: Record<HostSlot, HostSlotInfo | null>; stats: MasterHostStats | null };

type StartedSlot = { name: string; latency_samples: number; restored: boolean } | { error: string } | null;
interface Started { token: string; port: number; slots: Record<HostSlot, StartedSlot> }

const START_TIMEOUT_MS = 65_000; // the native start has one 60 s budget for every load
const ACTION_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 4_000; // the host stops itself when no client connects within 5 s
const STALL_MS = 1_200; // frames_out not advancing this long: back to the WebView output
const WATCH_EVERY_MS = 250;
const FAILED = "Η έξοδος μέσω plugins δεν ξεκίνησε.";
const LOST = "Η έξοδος μέσω plugins σταμάτησε· ο ήχος επέστρεψε στην κανονική έξοδο.";
const RECORDING = "Τα plugins VST3 δεν ξεκινούν όσο γράφεται set· σταμάτησε πρώτα την εγγραφή.";
const NO_FX = "Τα plugins VST3 χρειάζονται τα εφέ των decks, που δεν είναι έτοιμα.";
const PREF_OF: Record<HostSlot, "hostPluginDeckA" | "hostPluginDeckB" | "masterHostPlugin"> = {
  deck_a: "hostPluginDeckA", deck_b: "hostPluginDeckB", master: "masterHostPlugin",
};

/** The toast for a slot whose fault just appeared or changed. */
export function faultMessage(slot: HostSlot, fault: HostFault): string {
  const label = HOST_SLOT_LABEL[slot];
  if (fault === "error") return `Το plugin του ${label} παρουσίασε σφάλμα και μπήκε σε bypass· τα υπόλοιπα συνεχίζουν.`;
  if (fault === "slow") return `Το plugin του ${label} είναι πολύ αργό για πραγματικό χρόνο και μπήκε σε bypass.`;
  return `Το plugin του ${label} ζήτησε επαναφόρτωση και μπήκε σε bypass· σταμάτησε και ξεκίνησε ξανά τα plugins.`;
}

/** Tracks the host's frames_out; stalled once it has not advanced for `limitMs`. */
export function stallWatch(limitMs: number, now: number) {
  let last = -1, since = now;
  return {
    update(framesOut: number, at: number) { if (framesOut > last) { last = framesOut; since = at; } },
    stalled: (at: number) => at - since > limitMs,
  };
}

interface Session {
  ctx: AudioContext; tap?: AudioWorkletNode; worker?: Worker; timer?: ReturnType<typeof setInterval>; uiTimer?: ReturnType<typeof setInterval>;
  sunk: boolean;
  stats: MasterHostStats | null;
  /** The last fault seen per slot: a toast fires only when it changes to a value. */
  faults: Record<HostSlot, HostFault | null>;
}
let session: Session | null = null;
/** The decks feed the host: set inside the switch dip, cleared in release() (after the stop drain). */
let active = false;
// A start waits for the previous stop's answer, so the native side never sees them out of order.
let stopping: Promise<unknown> = Promise.resolve();

let state: MasterHostState = { status: "off" };
const listeners = new Set<() => void>();
function publish(next: MasterHostState) {
  state = next;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getState = () => state;
export const useMasterHostState = () => useSyncExternalStore(subscribe, getState, getState);

/** True while the decks' audio goes through the host (never the published status: it reads "off" during the stop drain). */
export const masterHostActive = () => active;
/** True from a start click until the host has fully let go of the decks: starting, on, and the stop drain. */
export const masterHostInUse = () => session !== null || active;

// Speakers back at once, then the tap, the worker (it closes the socket) and the native host.
function release(s: Session) {
  clearInterval(s.timer);
  clearInterval(s.uiTimer);
  if (s.sunk) {
    setDeckSink(s.ctx, null);
    active = false;
    syncMaximizer(); // back on the bus behind its own dip, with its DSP cleared
  }
  setHostDelayMs(0);
  s.sunk = false;
  s.tap?.port.postMessage({ stop: true });
  s.tap?.disconnect();
  s.worker?.postMessage({ stop: true });
}

function fail(s: Session, message: string) {
  if (session !== s) return;
  session = null;
  release(s);
  publish({ status: "off" });
  stopping = nativeAction("master_host_stop", {}, ACTION_TIMEOUT_MS).catch(() => {});
  toast.error(message);
}

function noteFaults(s: Session, stats: MasterHostStats) {
  for (const slot of HOST_SLOTS) {
    const fault = stats.slots?.[slot]?.fault ?? null;
    if (fault && fault !== s.faults[slot]) toast.error(faultMessage(slot, fault));
    s.faults[slot] = fault;
  }
}

/** Offers the tap a shared ring. Null (the MessagePort path) unless the page can share memory and the tap accepts within `timeoutMs`. */
export function offerRing(tapPort: MessagePort, timeoutMs = 1000): Promise<SharedArrayBuffer | null> {
  if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== "function" || typeof waitAsync() !== "function") {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const ring = createRing();
    const done = (result: SharedArrayBuffer | null) => {
      clearTimeout(timeout);
      tapPort.onmessage = null; // a late reply is ignored
      resolve(result);
    };
    const timeout = setTimeout(() => done(null), timeoutMs);
    tapPort.onmessage = ({ data }) => { if (typeof data?.ring === "boolean") done(data.ring ? ring : null); };
    try { tapPort.postMessage({ ring }); } catch { done(null); }
  });
}

export function scanMasterHostPlugins(): Promise<MasterHostPlugin[]> {
  return nativeAction<MasterHostPlugin[]>("master_host_scan", {}, ACTION_TIMEOUT_MS).then(result => result.value ?? []);
}

/**
 * Call `unlockPlaybackAudio()` in the click first. Needs at least one path. Errors end up in a toast; the sound never
 * stays muted. Refused (with a toast) while a set recording runs or before the deck effects are loaded.
 */
export async function startMasterHost(paths: HostSlotPaths): Promise<void> {
  const ctx = playbackContext();
  if (!ctx || session || !HOST_SLOTS.some(slot => paths[slot])) return;
  // Both refusals before `session` is set, so a REC click can never slip in between (it checks masterHostInUse()).
  if (recordingActive()) { toast.error(RECORDING); return; }
  if (!fxRackReady()) { toast.error(NO_FX); return; }
  const s: Session = { ctx, sunk: false, stats: null, faults: { deck_a: null, deck_b: null, master: null } };
  session = s;
  publish({ status: "starting" });
  let reason = FAILED;
  try {
    await stopping;
    const [{ default: tapUrl }, { default: workerUrl }] = await Promise.all([
      import("./audio/master-tap.worklet.js?worker&url"), import("./audio/masterTap.worker.ts?worker&url"),
    ]);
    if (session !== s) return; // a stop in between: never load the plugins (nothing awaits before the action)
    const { value } = await nativeAction<Started>("master_host_start", {
      sample_rate: ctx.sampleRate, slots: { deck_a: paths.deck_a, deck_b: paths.deck_b, master: paths.master },
    }, START_TIMEOUT_MS).catch((error: Error) => { reason = error instanceof TypeError ? FAILED : error.message; throw error; });
    if (session !== s) return;
    if (!value) throw new Error("no host");
    const slots = { deck_a: null, deck_b: null, master: null } as Record<HostSlot, HostSlotInfo | null>;
    const failedSlots: [HostSlot, string][] = [];
    for (const slot of HOST_SLOTS) {
      const reply = value.slots?.[slot];
      if (reply && "name" in reply) slots[slot] = { name: reply.name, restored: reply.restored === true };
      else if (reply && "error" in reply) failedSlots.push([slot, reply.error]);
    }
    await ctx.audioWorklet.addModule(tapUrl);
    if (session !== s) return;
    // Two stereo inputs (a mono deck feeds both sides; a missing one is silence) and headed 4-channel frames.
    const tap = s.tap = new AudioWorkletNode(ctx, "cratemind-master-tap", {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
      channelInterpretation: "speakers", processorOptions: { decks: true },
    });
    tap.connect(ctx.destination); // silent output: keeps the tap pulled
    const ring = await offerRing(tap.port);
    if (session !== s) return;
    const url = `ws://127.0.0.1:${value.port}/${value.token}`;
    const worker = s.worker = new Worker(workerUrl, { type: "module" });
    const channel = ring ? null : new MessageChannel();
    if (channel) tap.port.postMessage({ port: channel.port1 }, [channel.port1]);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(reject, OPEN_TIMEOUT_MS);
      worker.onmessage = ({ data }) => {
        if (!data.open && !data.closed) return;
        clearTimeout(timeout);
        if (data.open) resolve(); else reject();
      };
      worker.onerror = () => { clearTimeout(timeout); reject(); };
      if (channel) worker.postMessage({ port: channel.port2, url }, [channel.port2]);
      else worker.postMessage({ ring, url });
    });
    if (session !== s) return;
    let watch: ReturnType<typeof stallWatch> | null = null;
    // How long the page's own thread freezes: a 50 ms tick that arrives late by this much.
    let tick = performance.now(), uiStall = 0, uiStallSession = 0;
    s.uiTimer = setInterval(() => {
      const now = performance.now(), late = Math.max(0, now - tick - 50);
      tick = now;
      uiStall = Math.max(uiStall, late);
      uiStallSession = Math.max(uiStallSession, late);
    }, 50);
    worker.onmessage = ({ data }) => {
      if (data.closed) fail(s, LOST);
      else if (data.stats && session === s) {
        watch?.update(data.stats.frames_out, performance.now());
        if (s.sunk) setHostDelayMs(data.stats.latency_ms);
        const stats: MasterHostStats = { ...data.stats, ui_stall_ms: Math.round(uiStall), ui_stall_session_ms: Math.round(uiStallSession) };
        s.stats = stats;
        noteFaults(s, stats);
        publish({ status: "on", slots, stats });
        uiStall = 0;
      }
    };
    worker.onerror = () => fail(s, LOST);
    await withMasterDip(ctx, () => {
      if (session !== s) return;
      setDeckSink(ctx, tap);
      suspendMaximizer(ctx); // the Master slot takes its place; it never adapts to the silent bus
      s.sunk = true;
      active = true;
    }, { decks: true });
    if (session !== s) return;
    const started = watch = stallWatch(STALL_MS, performance.now()); // the stall clock starts with the switch
    let strikes = 0; // one late check after a busy page is not a stall: its stats are still queued
    s.timer = setInterval(() => {
      strikes = started.stalled(performance.now()) ? strikes + 1 : 0;
      if (strikes > 1) fail(s, LOST);
    }, WATCH_EVERY_MS);
    publish({ status: "on", slots, stats: s.stats }); // the latest stats, so a stop right away drains for the real latency
    for (const slot of HOST_SLOTS) setPref(PREF_OF[slot], paths[slot]);
    for (const [slot, error] of failedSlots) toast.error(`${HOST_SLOT_LABEL[slot]}: ${error} Το slot έμεινε άδειο.`);
  } catch {
    fail(s, reason);
  }
}

export async function stopMasterHost(): Promise<void> {
  const s = session;
  if (!s) return;
  // The host still plays ~latency_ms of audio from before the dip: let it drain (fed silence) before teardown cuts it.
  const drainMs = Math.min(1500, (state.status === "on" && state.stats ? state.stats.latency_ms : 100) + 25);
  session = null;
  publish({ status: "off" });
  // Chained: an earlier stop's native stop still draining must never go out after a newer start.
  const prior = stopping;
  stopping = (async () => {
    await prior;
    if (s.sunk) {
      await withMasterDip(s.ctx, async () => {
        await new Promise(resolve => setTimeout(resolve, drainMs));
        release(s);
      }, { decks: true }).catch(() => release(s));
    } else release(s);
    await nativeAction("master_host_stop", {}, ACTION_TIMEOUT_MS).catch(() => {});
  })();
  await stopping;
}

/** Errors reject with the native side's Greek message (an empty slot, a reload, a latency over the budget). */
export function bypassHostSlot(slot: HostSlot, bypassed: boolean): Promise<unknown> {
  return nativeAction("master_host_bypass", { slot, bypassed }, ACTION_TIMEOUT_MS);
}

export function openMasterHostEditor(slot: HostSlot): Promise<unknown> {
  return nativeAction("master_host_editor", { slot }, ACTION_TIMEOUT_MS);
}

/** Mounted once, in AppShell: leaving two-deck mode stops the host (single-deck playback bypasses the bus). */
export function useMasterHostWatcher(twoDeck: boolean): void {
  useEffect(() => {
    if (twoDeck || !session) return;
    void stopMasterHost();
    toast("Τα plugins VST3 σταμάτησαν: λειτουργούν μόνο με δύο decks.");
  }, [twoDeck]);
}
