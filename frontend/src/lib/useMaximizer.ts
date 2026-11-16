import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { DEFAULT_PREFS, getPref, setPref, usePref } from "./prefs";
import { playbackContext } from "./playbackAudio";
import { setMasterInsert, withMasterDip } from "./audio/masterBus";
import type { Maximizer, MaximizerMeters } from "./audio/maximizer";

export const TARGET_RANGE = { min: -18, max: -6 } as const;
export const CEILING_RANGE = { min: -3, max: 0 } as const;
/** Inside the bus dip's own 2 s cap, so the insert always happens at zero output. */
const READY_WAIT_MS = 1800;
const UNAVAILABLE = "Το Maximizer δεν είναι διαθέσιμο.";

const clamp = (value: number, { min, max }: { min: number; max: number }, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const levels = () => ({
  targetDb: clamp(getPref("maximizerTargetDb"), TARGET_RANGE, DEFAULT_PREFS.maximizerTargetDb),
  ceilingDb: clamp(getPref("maximizerCeilingDb"), CEILING_RANGE, DEFAULT_PREFS.maximizerCeilingDb),
});

// ~30 Hz meter store; null while the Maximizer is not processing. Only leaf meter elements subscribe.
let meters: MaximizerMeters | null = null;
const listeners = new Set<() => void>();
function publish(next: MaximizerMeters | null) {
  if (next === meters) return;
  meters = next;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getMeters = () => meters;
export const useMaximizerMeters = () => useSyncExternalStore(subscribe, getMeters, getMeters);

// One engine per session, never disposed: toggling only bypasses it and takes it off the bus.
let engine: Maximizer | null = null;
let engineReady = false;
let inserted = false;
let failed = false;
let watched: AudioContext | null = null;
let syncing = false;
let again = false;

function fail(ctx: AudioContext) {
  if (failed) return;
  failed = true;
  if (inserted) setMasterInsert(ctx, null);
  inserted = false;
  publish(null);
  setPref("maximizer", false); // the switch and the mixer chip must not claim it still runs
  toast.error(UNAVAILABLE);
}

function watch(ctx: AudioContext) {
  if (watched === ctx) return;
  watched = ctx;
  // Nothing happens on a suspended context; the first play gesture resumes it and this picks up from there.
  ctx.addEventListener("statechange", () => {
    if (ctx.state !== "running") publish(null);
    syncMaximizer();
  });
}

async function create(ctx: AudioContext) {
  // Code, wasm and worklet module load before any dip; a slow load or a suspended context is "not yet".
  const { createMaximizer, loadMaximizer, MaximizerNotYet } = await import("./audio/maximizer");
  let wasm: ArrayBuffer;
  try {
    wasm = await loadMaximizer(ctx);
  } catch (error) {
    // Not yet: try again once the load ends (a late rejection then fails on that pass).
    if (error instanceof MaximizerNotYet) error.loading.then(syncMaximizer, syncMaximizer);
    else fail(ctx);
    return;
  }
  if (failed || engine || !getPref("maximizer") || ctx.state !== "running") return;
  // init() stalls the render thread for tens of ms: it happens while the bus is silent.
  await withMasterDip(ctx, async () => {
    const created = engine = createMaximizer(ctx, wasm);
    created.onMeters(next => { if (inserted && engine === created) publish(next); });
    created.onError(() => fail(ctx));
    created.ready.then(() => {
      engineReady = true;
      // Ready after the dip gave up waiting: the next pass inserts it behind a new dip.
      if (!inserted) syncMaximizer();
    }, () => {});
    created.set(levels());
    await Promise.race([created.ready, new Promise(resolve => setTimeout(resolve, READY_WAIT_MS))]).catch(() => {});
    if (failed || !engineReady) return;
    if (getPref("maximizer")) {
      setMasterInsert(ctx, created.node);
      inserted = true;
    } else {
      created.setActive(false);
    }
  });
}

async function step() {
  if (failed) {
    // Failed for this session: a re-enable flips straight back off instead of sitting on silently.
    if (getPref("maximizer")) { setPref("maximizer", false); toast.error(UNAVAILABLE); }
    return;
  }
  const want = getPref("maximizer");
  const ctx = want || engine ? playbackContext() : undefined;
  if (!ctx) return;
  watch(ctx);
  if (ctx.state !== "running") return;
  if (!engine) {
    if (want) await create(ctx);
    return;
  }
  const current = engine;
  if (!engineReady || want === inserted) return;
  await withMasterDip(ctx, () => {
    if (failed || engine !== current) return;
    current.setActive(want);
    setMasterInsert(ctx, want ? current.node : null);
    inserted = want;
    if (!want) publish(null);
  });
}

/** Brings the bus in line with the `maximizer` pref; calls during a pass coalesce into one more pass. */
export function syncMaximizer(): void {
  if (syncing) { again = true; return; }
  syncing = true;
  void (async () => {
    try {
      do { again = false; await step(); } while (again);
    } catch {
      // A failed rewire leaves the bus as it was; the next toggle or statechange tries again.
    } finally {
      syncing = false;
    }
  })();
}

/** Mounted once, in AppShell: keeps the Maximizer on the master bus in step with the prefs. */
export function useMaximizer(): void {
  const [on] = usePref("maximizer");
  const [targetDb] = usePref("maximizerTargetDb");
  const [ceilingDb] = usePref("maximizerCeilingDb");
  useEffect(() => { syncMaximizer(); }, [on]);
  useEffect(() => { engine?.set(levels()); }, [targetDb, ceilingDb]);
}
