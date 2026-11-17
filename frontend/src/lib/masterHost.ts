// Experimental VST3 master host (desktop, macOS): bus out → tap worklet → shared ring (when the page is
// cross-origin isolated) or MessagePort → worker → loopback WebSocket → the native host's ring → VST3 plugin →
// default output. Off at every launch, two-deck mode only.
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { nativeAction } from "./desktopRuntime";
import { playbackContext } from "./playbackAudio";
import { setMasterSink, withMasterDip } from "./audio/masterBus";
import { createRing, waitAsync } from "./audio/masterRing";
import { setHostDelayMs } from "./hostDelay";
import { setPref } from "./prefs";

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
}
export type MasterHostState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "on"; name: string; restored: boolean; stats: MasterHostStats | null };
interface Started { token: string; port: number; latency_samples: number; name: string; restored: boolean }

const START_TIMEOUT_MS = 25_000; // the native side gives a plugin load 20 s
const ACTION_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 4_000; // the host stops itself when no client connects within 5 s
const STALL_MS = 1_200; // frames_out not advancing this long: back to the WebView output
const WATCH_EVERY_MS = 250;
const FAILED = "Η έξοδος μέσω plugin δεν ξεκίνησε.";
const LOST = "Η έξοδος μέσω plugin σταμάτησε· ο ήχος επέστρεψε στην κανονική έξοδο.";

/** Tracks the host's frames_out; stalled once it has not advanced for `limitMs`. */
export function stallWatch(limitMs: number, now: number) {
  let last = -1, since = now;
  return {
    update(framesOut: number, at: number) { if (framesOut > last) { last = framesOut; since = at; } },
    stalled: (at: number) => at - since > limitMs,
  };
}

interface Session { ctx: AudioContext; tap?: AudioWorkletNode; worker?: Worker; timer?: ReturnType<typeof setInterval>; uiTimer?: ReturnType<typeof setInterval>; sunk: boolean }
let session: Session | null = null;
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

// Speakers back at once, then the tap, the worker (it closes the socket) and the native host.
function release(s: Session) {
  clearInterval(s.timer);
  clearInterval(s.uiTimer);
  if (s.sunk) setMasterSink(s.ctx, null);
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

/** Call `unlockPlaybackAudio()` in the click first. Errors end up in a toast; the bus never stays muted. */
export async function startMasterHost(path: string): Promise<void> {
  const ctx = playbackContext();
  if (!ctx || session) return;
  const s: Session = { ctx, sunk: false };
  session = s;
  publish({ status: "starting" });
  let reason = FAILED;
  try {
    await stopping;
    const [{ default: tapUrl }, { default: workerUrl }] = await Promise.all([
      import("./audio/master-tap.worklet.js?worker&url"), import("./audio/masterTap.worker.ts?worker&url"),
    ]);
    const { value } = await nativeAction<Started>("master_host_start", { path, sample_rate: ctx.sampleRate }, START_TIMEOUT_MS)
      .catch((error: Error) => { reason = error instanceof TypeError ? FAILED : error.message; throw error; });
    if (session !== s) return;
    if (!value) throw new Error("no host");
    const restored = value.restored === true;
    await ctx.audioWorklet.addModule(tapUrl);
    if (session !== s) return;
    const tap = s.tap = new AudioWorkletNode(ctx, "cratemind-master-tap", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
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
        publish({ status: "on", name: value.name, restored, stats: { ...data.stats, ui_stall_ms: Math.round(uiStall), ui_stall_session_ms: Math.round(uiStallSession) } });
        uiStall = 0;
      }
    };
    worker.onerror = () => fail(s, LOST);
    await withMasterDip(ctx, () => {
      if (session !== s) return;
      setMasterSink(ctx, tap);
      s.sunk = true;
    });
    if (session !== s) return;
    const started = watch = stallWatch(STALL_MS, performance.now()); // the stall clock starts with the switch
    let strikes = 0; // one late check after a busy page is not a stall: its stats are still queued
    s.timer = setInterval(() => {
      strikes = started.stalled(performance.now()) ? strikes + 1 : 0;
      if (strikes > 1) fail(s, LOST);
    }, WATCH_EVERY_MS);
    publish({ status: "on", name: value.name, restored, stats: null });
    setPref("masterHostPlugin", path);
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
  stopping = (async () => {
    if (s.sunk) {
      await withMasterDip(s.ctx, async () => {
        await new Promise(resolve => setTimeout(resolve, drainMs));
        release(s);
      }).catch(() => release(s));
    } else release(s);
    await nativeAction("master_host_stop", {}, ACTION_TIMEOUT_MS).catch(() => {});
  })();
  await stopping;
}

export function openMasterHostEditor(): Promise<unknown> {
  return nativeAction("master_host_editor", {}, ACTION_TIMEOUT_MS);
}

/** Mounted once, in AppShell: leaving two-deck mode stops the host (single-deck playback bypasses the bus). */
export function useMasterHostWatcher(twoDeck: boolean): void {
  useEffect(() => {
    if (twoDeck || !session) return;
    void stopMasterHost();
    toast("Η έξοδος μέσω plugin σταμάτησε: λειτουργεί μόνο με δύο decks.");
  }, [twoDeck]);
}
