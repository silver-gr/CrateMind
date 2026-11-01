import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "./api";

interface DownbeatSnapshot { value: number | null; ready: boolean }

interface DownbeatStore {
  trackId: number;
  snapshot: DownbeatSnapshot;
  listeners: Set<() => void>;
  loading: boolean;
  /** Last value the server confirmed (the rollback target). */
  saved: number | null;
  /** Writes for one track run one after another, so the server ends on the last press. */
  chain: Promise<void>;
}

const stores = new Map<number, DownbeatStore>();
const emptySnapshot: DownbeatSnapshot = { value: null, ready: false };

function storeFor(trackId: number): DownbeatStore {
  let store = stores.get(trackId);
  if (!store) {
    store = { trackId, snapshot: emptySnapshot, listeners: new Set(), loading: false, saved: null, chain: Promise.resolve() };
    stores.set(trackId, store);
  }
  return store;
}

function publish(store: DownbeatStore, patch: Partial<DownbeatSnapshot>) {
  store.snapshot = { ...store.snapshot, ...patch };
  store.listeners.forEach(listener => listener());
}

function load(store: DownbeatStore) {
  if (store.snapshot.ready || store.loading) return;
  store.loading = true;
  api.getTrackDownbeat(store.trackId)
    .then(r => { if (!store.snapshot.ready) { store.saved = r.downbeat_s; publish(store, { value: r.downbeat_s, ready: true }); } })
    .catch(() => { /* stays not ready (buttons disabled); retried on the next load of this track */ })
    .finally(() => { store.loading = false; });
}

/** Optimistic write (null = reset), queued behind earlier writes; rolls back only if the store still holds this request's value. */
function write(store: DownbeatStore, next: number | null): Promise<void> {
  publish(store, { value: next });
  store.chain = store.chain.then(async () => {
    try {
      if (next == null) await api.deleteTrackDownbeat(store.trackId);
      else await api.setTrackDownbeat(store.trackId, next);
      store.saved = next;
    } catch (error) {
      if (store.snapshot.value === next) publish(store, { value: store.saved });
      toast.error(error instanceof Error ? `Αποτυχία αποθήκευσης downbeat: ${error.message}` : "Αποτυχία αποθήκευσης downbeat.");
    }
  });
  return store.chain;
}

/** The user's downbeat for a track, shared by every deck showing it. `ready` is false until the first read lands. */
export function useDownbeat(trackId: number | null) {
  const bindings = useMemo(() => {
    const store = trackId === null ? null : storeFor(trackId);
    return {
      subscribe: (listener: () => void) => {
        store?.listeners.add(listener);
        return () => { store?.listeners.delete(listener); };
      },
      getSnapshot: () => store?.snapshot ?? emptySnapshot,
      ensureLoaded: () => { if (store) load(store); },
      set: (seconds: number) => (store ? write(store, seconds) : Promise.resolve()),
      reset: () => (store ? write(store, null) : Promise.resolve()),
    };
  }, [trackId]);
  const snapshot = useSyncExternalStore(bindings.subscribe, bindings.getSnapshot, bindings.getSnapshot);
  useEffect(bindings.ensureLoaded, [bindings]);
  return { ...snapshot, set: bindings.set, reset: bindings.reset };
}
