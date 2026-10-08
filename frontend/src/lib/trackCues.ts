import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "./api";
import type { TrackCue, TrackCueCreate, TrackCueKind, TrackCueUpdate } from "./types";

interface CueSnapshot {
  cues: TrackCue[];
  loading: boolean;
  error: string | null;
  pendingKinds: ReadonlySet<TrackCueKind>;
  pendingCueIds: ReadonlySet<number>;
}

const emptySnapshot: CueSnapshot = {
  cues: [],
  loading: false,
  error: null,
  pendingKinds: new Set(),
  pendingCueIds: new Set(),
};

interface CueStore {
  trackId: number;
  snapshot: CueSnapshot;
  listeners: Set<() => void>;
  loaded: boolean;
  readGeneration: number;
  mutationEpoch: number;
  inFlight: Promise<void> | null;
  needsRefresh: boolean;
}

const stores = new Map<number, CueStore>();

function storeFor(trackId: number): CueStore {
  let store = stores.get(trackId);
  if (!store) {
    store = {
      trackId,
      snapshot: emptySnapshot,
      listeners: new Set(),
      loaded: false,
      readGeneration: 0,
      mutationEpoch: 0,
      inFlight: null,
      needsRefresh: false,
    };
    stores.set(trackId, store);
  }
  return store;
}

function publish(store: CueStore, patch: Partial<CueSnapshot>) {
  store.snapshot = { ...store.snapshot, ...patch };
  store.listeners.forEach((listener) => listener());
}

function sorted(cues: TrackCue[]) {
  return [...cues].sort((a, b) => a.position_ms - b.position_ms || a.id - b.id);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Αποτυχία αποθήκευσης ή φόρτωσης των cues.";
}

function hasPendingWrites(store: CueStore) {
  return store.snapshot.pendingKinds.size > 0 || store.snapshot.pendingCueIds.size > 0;
}

function refreshWhenSettled(store: CueStore) {
  if (store.needsRefresh && !store.inFlight && !hasPendingWrites(store)) {
    store.needsRefresh = false;
    void fetchCues(store, false).catch(() => { /* The snapshot exposes the read error. */ });
  }
}

function fetchCues(store: CueStore, clearError = true): Promise<void> {
  const generation = ++store.readGeneration;
  const epoch = store.mutationEpoch;
  const beganDuringWrite = hasPendingWrites(store);
  publish(store, { loading: true, ...(clearError ? { error: null } : {}) });

  const request = (async () => {
    try {
      const cues = await api.getTrackCues(store.trackId);
      if (generation !== store.readGeneration) return;
      // Even a completed write invalidates a read that began before it.
      if (beganDuringWrite || epoch !== store.mutationEpoch || hasPendingWrites(store)) {
        store.needsRefresh = true;
        return;
      }
      store.loaded = true;
      store.needsRefresh = false;
      publish(store, { cues: sorted(cues) });
    } catch (error) {
      if (generation !== store.readGeneration) return;
      if (epoch !== store.mutationEpoch || beganDuringWrite) {
        store.needsRefresh = true;
        return;
      }
      publish(store, { error: errorMessage(error) });
      throw error;
    } finally {
      if (generation === store.readGeneration) {
        store.inFlight = null;
        publish(store, { loading: false });
        refreshWhenSettled(store);
      }
    }
  })();
  store.inFlight = request;
  return request;
}

async function mutateCue<T>(
  store: CueStore,
  pending: { kind: TrackCueKind } | { cueId: number },
  write: () => Promise<T>,
  apply: (result: T, cues: TrackCue[]) => TrackCue[],
): Promise<T> {
  const pendingKinds = new Set(store.snapshot.pendingKinds);
  const pendingCueIds = new Set(store.snapshot.pendingCueIds);
  if ("kind" in pending) {
    if (pendingKinds.has(pending.kind)) throw new Error("Η αποθήκευση αυτού του cue βρίσκεται ήδη σε εξέλιξη.");
    pendingKinds.add(pending.kind);
  } else {
    if (pendingCueIds.has(pending.cueId)) throw new Error("Η αλλαγή αυτού του cue βρίσκεται ήδη σε εξέλιξη.");
    pendingCueIds.add(pending.cueId);
  }
  // A failed initial read leaves the cache incomplete even after a saved cue.
  if (!store.loaded) store.needsRefresh = true;
  store.mutationEpoch += 1;
  publish(store, { pendingKinds, pendingCueIds, error: null });
  try {
    const result = await write();
    // Merge into the current snapshot, so other successful writes survive.
    publish(store, { cues: sorted(apply(result, store.snapshot.cues)) });
    return result;
  } catch (error) {
    publish(store, { error: errorMessage(error) });
    throw error;
  } finally {
    store.mutationEpoch += 1;
    const nextKinds = new Set(store.snapshot.pendingKinds);
    const nextIds = new Set(store.snapshot.pendingCueIds);
    if ("kind" in pending) nextKinds.delete(pending.kind);
    else nextIds.delete(pending.cueId);
    publish(store, { pendingKinds: nextKinds, pendingCueIds: nextIds });
    refreshWhenSettled(store);
  }
}

function requireStore(store: CueStore | null): CueStore {
  if (!store) throw new Error("Δεν έχει επιλεγεί κομμάτι για το cue.");
  return store;
}

export function useTrackCues(trackId: number | null) {
  const bindings = useMemo(() => {
    const store = trackId === null ? null : storeFor(trackId);
    return {
      subscribe: (listener: () => void) => {
        store?.listeners.add(listener);
        return () => { store?.listeners.delete(listener); };
      },
      getSnapshot: () => store?.snapshot ?? emptySnapshot,
      ensureLoaded: () => {
        if (store && !store.loaded && !store.inFlight) {
          void fetchCues(store).catch(() => { /* The snapshot exposes the read error. */ });
        }
      },
      refresh: async () => {
        if (store) await fetchCues(store);
      },
      createCue: async (input: TrackCueCreate) => {
        const target = requireStore(store);
        return mutateCue(target, { kind: input.kind },
          () => api.createTrackCue(target.trackId, input),
          (cue, cues) => [...cues.filter((existing) => existing.id !== cue.id), cue]);
      },
      updateCue: async (cueId: number, input: TrackCueUpdate) => {
        const target = requireStore(store);
        return mutateCue(target, { cueId },
          () => api.updateTrackCue(target.trackId, cueId, input),
          (cue, cues) => [...cues.filter((existing) => existing.id !== cue.id), cue]);
      },
      deleteCue: async (cueId: number) => {
        const target = requireStore(store);
        await mutateCue(target, { cueId },
          () => api.deleteTrackCue(target.trackId, cueId),
          (_, cues) => cues.filter((cue) => cue.id !== cueId));
      },
    };
  }, [trackId]);

  const snapshot = useSyncExternalStore(bindings.subscribe, bindings.getSnapshot, bindings.getSnapshot);
  useEffect(bindings.ensureLoaded, [bindings]);

  return {
    ...snapshot,
    createCue: bindings.createCue,
    updateCue: bindings.updateCue,
    deleteCue: bindings.deleteCue,
    refresh: bindings.refresh,
  };
}
