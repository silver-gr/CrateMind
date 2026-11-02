// Focused-list browse for the controller: pages register their track lists here, the
// controller's browse knob / push / Load act on whichever list has focus. The cursor lives
// in this store (synchronous), so a MIDI batch (several turns, then Load) hits the right row
// before React re-renders; pages mirror the cursor into their own selection via `onCursor`.
import { useEffect, useRef, useSyncExternalStore, type PointerEvent, type WheelEvent } from "react";
import { useMidiConnected } from "./mixer";
import type { Track } from "./types";

export type BrowseListSpec = {
  /** Current rows, in display order. */
  rows: () => readonly Track[];
  /** The cursor moved: mirror it into the page selection and scroll it into view. */
  onCursor: (track: Track, index: number) => void;
  /** Controller hold on Load: add this track to the page's set. */
  addToSet?: (track: Track) => void;
};
type Entry = { getSpec: () => BrowseListSpec; cursor: number; key: number | null };

/** Soft cyan glow along the left and right inner edges only, an overlay on the (non-scrolling) list wrapper; used where a page has more than one list; applied through `data-browse-focused` (only set while a controller is connected). */
export const BROWSE_FOCUS_CLASS =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-30 after:rounded-[inherit] after:opacity-0 after:transition-opacity after:shadow-[inset_20px_0_12px_-16px_color-mix(in_oklch,var(--cm-cyan)_45%,transparent),inset_-20px_0_12px_-16px_color-mix(in_oklch,var(--cm-cyan)_45%,transparent)] data-[browse-focused]:after:opacity-100 motion-reduce:after:transition-none";

const lists = new Map<string, Entry>();
let focusedId: string | null = null;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach(l => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Re-resolve the cursor against the current rows (they may have been re-sorted or reloaded). */
function resolve(entry: Entry): number {
  const rows = entry.getSpec().rows();
  if (rows.length === 0) return (entry.cursor = -1);
  if (entry.key !== null && rows[entry.cursor]?.id !== entry.key) {
    const at = rows.findIndex(t => t.id === entry.key);
    entry.cursor = at >= 0 ? at : Math.min(entry.cursor, rows.length - 1);
  }
  return entry.cursor;
}

function setCursor(entry: Entry, index: number) {
  const rows = entry.getSpec().rows();
  if (index < 0 || index >= rows.length) return;
  entry.cursor = index;
  entry.key = rows[index].id;
  entry.getSpec().onCursor(rows[index], index);
}

export function registerBrowseList(id: string, getSpec: () => BrowseListSpec): () => void {
  const entry: Entry = { getSpec, cursor: -1, key: null };
  lists.set(id, entry);
  if (focusedId === null) focusedId = id;
  bump();
  return () => {
    if (lists.get(id) !== entry) return;
    lists.delete(id);
    if (focusedId === id) focusedId = lists.keys().next().value ?? null;
    bump();
  };
}

export function focusBrowseList(id: string) {
  if (!lists.has(id) || focusedId === id) return;
  focusedId = id;
  bump();
}

/** Next registered list gets focus; a list with no cursor yet starts on its first row. */
export function cycleFocus() {
  const ids = [...lists.keys()];
  if (ids.length < 2) return;
  const next = ids[(Math.max(ids.indexOf(focusedId ?? ""), 0) + 1) % ids.length];
  focusedId = next;
  const entry = lists.get(next)!;
  if (resolve(entry) < 0) setCursor(entry, 0);
  bump();
}

export const getFocusedBrowseId = () => focusedId;
const focused = () => (focusedId ? lists.get(focusedId) ?? null : null);

/** Move the focused list's cursor by `delta` rows (clamped; from "no cursor" the first move lands on row 0). */
export function moveBrowse(delta: number) {
  const entry = focused();
  if (!entry || delta === 0) return;
  const rows = entry.getSpec().rows();
  if (rows.length === 0) return;
  const at = resolve(entry);
  const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta));
  if (next !== at) setCursor(entry, next);
}

export function getBrowseSelected(): Track | null {
  const entry = focused();
  if (!entry) return null;
  const at = resolve(entry);
  return at < 0 ? null : entry.getSpec().rows()[at] ?? null;
}

/** Runs the focused list's add-to-set callback on its cursor row; false when it has none or nothing is selected. */
export function browseAddToSet(): boolean {
  const entry = focused();
  const track = getBrowseSelected();
  const add = entry?.getSpec().addToSet;
  if (!track || !add) return false;
  add(track);
  return true;
}

/** The page selected `trackId` itself (click, keyboard): move the cursor there without echoing `onCursor`. */
export function syncBrowseCursor(id: string, trackId: number) {
  const entry = lists.get(id);
  if (!entry || entry.key === trackId) return;
  const at = entry.getSpec().rows().findIndex(t => t.id === trackId);
  if (at < 0) return;
  entry.cursor = at;
  entry.key = trackId;
}

export function resetBrowseForTests() {
  lists.clear();
  focusedId = null;
  bump();
}

/** Register a list for the lifetime of the component. `selectedId` keeps the cursor in step with page-driven selection. */
export function useBrowseList(id: string, spec: BrowseListSpec, selectedId?: number | null) {
  const specRef = useRef(spec);
  specRef.current = spec;
  useEffect(() => registerBrowseList(id, () => specRef.current), [id]);
  useEffect(() => {
    if (selectedId != null) syncBrowseCursor(id, selectedId);
  }, [id, selectedId]);
  useSyncExternalStore(subscribe, () => version, () => version);
  const connected = useMidiConnected();
  const hasFocus = focusedId === id;
  return {
    focused: connected && hasFocus,
    /** Spread on the list's container element: focus follows pointerdown/wheel, never scroll. */
    bind: {
      onPointerDownCapture: (_e: PointerEvent) => focusBrowseList(id),
      onWheelCapture: (_e: WheelEvent) => focusBrowseList(id),
      "data-browse-focused": connected && hasFocus ? true : undefined,
    },
  };
}
