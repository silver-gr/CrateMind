import { useCallback, useEffect, useState } from "react";
import { preferenceStorage } from "./preferenceStorage";
import type { TrackCue } from "./types";

export type CuePadSlots = (number | null)[];
type Layouts = Record<string, CuePadSlots>;
type Storage = Pick<typeof preferenceStorage, "getItem" | "setItem">;
const layoutListeners = new Set<(trackId: number, slots: CuePadSlots) => void>();
const emptySlots = (): CuePadSlots => Array(8).fill(null);
// Fixed buckets keep desktop preference keys bounded and distribute layout size.
const storageKey = (trackId: number) => `cm:cue-pads:v1:${trackId % 16}`;
function readLayouts(storage: Storage, trackId: number): Layouts {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey(trackId)) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Layouts : {};
  } catch { return {}; }
}
function validSlots(value: unknown): value is CuePadSlots {
  return Array.isArray(value) && value.length === 8
    && value.every(id => id === null || (Number.isSafeInteger(id) && id > 0))
    && new Set(value.filter(id => id !== null)).size === value.filter(id => id !== null).length;
}
export function loadCuePadSlots(storage: Storage, trackId: number, cues: TrackCue[]): CuePadSlots {
  const saved = readLayouts(storage, trackId)[trackId];
  if (validSlots(saved)) {
    // Leave holes: deletion must never move another cue to a different key.
    const ids = new Set(cues.map(cue => cue.id));
    return saved.map(id => id !== null && ids.has(id) ? id : null);
  }
  const chronological = [...cues].sort((a, b) => a.position_ms - b.position_ms || a.id - b.id);
  return emptySlots().map((_, index) => chronological[index]?.id ?? null);
}
export function saveCuePadSlots(storage: Storage, trackId: number, slots: CuePadSlots) {
  if (!validSlots(slots)) throw new Error("Μη έγκυρη διάταξη cue pads.");
  const layouts = readLayouts(storage, trackId);
  layouts[trackId] = slots;
  storage.setItem(storageKey(trackId), JSON.stringify(layouts));
  layoutListeners.forEach(listener => listener(trackId, slots));
}
export function assignCuePad(slots: CuePadSlots, index: number, cueId: number | null): CuePadSlots {
  if (!Number.isInteger(index) || index < 0 || index > 7) return slots;
  return slots.map((id, slot) => slot === index ? cueId : cueId !== null && id === cueId ? null : id);
}
export function useCuePadLayout(trackId: number | null, cues: TrackCue[], ready: boolean) {
  const [layout, setLayout] = useState<{ trackId: number; slots: CuePadSlots } | null>(null);
  useEffect(() => {
    const changed = (changedTrackId: number, slots: CuePadSlots) => {
      if (changedTrackId === trackId) setLayout({ trackId, slots });
    };
    layoutListeners.add(changed);
    return () => { layoutListeners.delete(changed); };
  }, [trackId]);
  useEffect(() => {
    if (trackId === null || !ready) return;
    const slots = loadCuePadSlots(preferenceStorage, trackId, cues);
    // Visiting an uncued track should not fill durable preferences with eight nulls.
    if (slots.some(id => id !== null) || readLayouts(preferenceStorage, trackId)[trackId]) {
      saveCuePadSlots(preferenceStorage, trackId, slots);
    }
    setLayout(previous => previous?.trackId === trackId && previous.slots.every((id, index) => id === slots[index])
      ? previous : { trackId, slots });
  }, [trackId, ready, cues]);
  const assign = useCallback((index: number, cueId: number | null) => {
    if (trackId === null) return;
    // Read the captured track's mapping afresh: concurrent capture completions merge.
    const saved = readLayouts(preferenceStorage, trackId)[trackId];
    const slots = assignCuePad(validSlots(saved) ? saved : emptySlots(), index, cueId);
    saveCuePadSlots(preferenceStorage, trackId, slots);
    setLayout(previous => previous?.trackId === trackId ? { trackId, slots } : previous);
  }, [trackId]);
  return { slots: layout?.trackId === trackId ? layout.slots : emptySlots(), assign };
}
