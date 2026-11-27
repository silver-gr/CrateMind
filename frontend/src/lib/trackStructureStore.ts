// Track structures as the Library list and the decks read them: fetched once per track, kept until an analysis finishes.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { ANALYSIS_FINISHED } from "./bpmUpdates";
import type { StructureSummary, TrackStructure } from "./trackStructure";

/** The batch route takes at most this many ids. */
const BATCH = 300;
const summaries = new Map<number, StructureSummary | null>();   // null: asked, the track has none
const structures = new Map<number, TrackStructure | null>();
const queued = new Set<number>();
const inFlight = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;
function notify() { version += 1; listeners.forEach(listener => listener()); }

async function flush() {
  const ids = [...queued].slice(0, BATCH);
  ids.forEach(id => { queued.delete(id); inFlight.add(id); });
  timer = queued.size ? setTimeout(flush, 0) : null;
  // A failed request counts as "none" until the next analysis or reload, so a broken route is not asked on every scroll.
  const found = await api.getTrackStructures(ids).catch((): Record<string, StructureSummary> => ({}));
  ids.forEach(id => { inFlight.delete(id); summaries.set(id, found[id] ?? null); });
  notify();
}

/** Ask for the sections of `ids`; tracks already known, queued or on their way are skipped. */
export function requestStructureSummaries(ids: readonly number[]): void {
  for (const id of ids) if (!summaries.has(id) && !inFlight.has(id)) queued.add(id);
  if (queued.size && timer == null) timer = setTimeout(flush, 60);   // one request for a burst of rows (a scroll, a new page)
}

/** The sections of the tracks on screen, by track id (missing: not loaded yet; null: the track has no structure). */
export function useStructureSummaries(ids: readonly number[], enabled = true): ReadonlyMap<number, StructureSummary | null> {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (enabled) requestStructureSummaries(ids); });
  return summaries;
}

/** Ask for a track's full structure, unless it is known or on its way. */
function fetchStructure(trackId: number): void {
  if (structures.has(trackId) || inFlight.has(-trackId)) return;
  inFlight.add(-trackId);                                   // negative ids: the full structure, apart from the summaries
  void api.getTrackStructure(trackId).catch(() => null).then(structure => {
    inFlight.delete(-trackId); structures.set(trackId, structure); notify();
  });
}

/** A track's full structure (sections, anchors, phrase lines); null while loading or when it has none. */
export function useTrackStructure(trackId: number | null): TrackStructure | null {
  // This track's entry only, so another track's fetch (or a summary batch) does not re-render the decks. Undefined
  // (not asked) and null (none) stay apart, so a cleared "none" re-renders and the effect asks again.
  const own = () => (trackId == null ? null : structures.get(trackId));
  const value = useSyncExternalStore(subscribe, own, own);
  useEffect(() => { if (trackId != null) fetchStructure(trackId); });
  return value ?? null;
}

/** The same, outside React: undefined while loading (an unknown track is asked for), null when it has none. */
export function peekTrackStructure(trackId: number): TrackStructure | null | undefined {
  fetchStructure(trackId);
  return structures.get(trackId);
}

/** An analysis measures structures: forget what is cached, so rows and decks on screen ask again. */
export function clearStructureCache(): void { summaries.clear(); structures.clear(); queued.clear(); notify(); }
if (typeof window !== "undefined") window.addEventListener(ANALYSIS_FINISHED, clearStructureCache);
