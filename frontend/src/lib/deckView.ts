import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export const WAVE_MIN_HEIGHT = 48;
export const WAVE_MAX_HEIGHT = 128;
export const WAVE_DEFAULT_HEIGHT = 72;
/** The facts row under the waveforms: each deck's numbers (30 px) over its overview (26 px), 2 px above and below. */
export const DECK_BAR_HEIGHT = 60;
/** The same row in a window too short for the overviews: the numbers alone. */
export const DECK_BAR_COMPACT_HEIGHT = 34;
/** The top bar over the window's first 32 px, in every host. */
export const TOP_BAR_HEIGHT = 32;
/** The routed page always keeps at least this much height. */
export const MAIN_MIN_HEIGHT = 240;

/** "full": both lanes and the facts row. "headers": the facts row alone. "compact": its numbers alone. */
export type DeckViewMode = "full" | "headers" | "compact" | "hidden";

/** Both lanes stacked edge to edge plus the facts row; headers-only keeps just the row. */
export function deckViewHeight(mode: DeckViewMode, waveHeight: number): number {
  if (mode === "hidden") return 0;
  if (mode === "compact") return DECK_BAR_COMPACT_HEIGHT;
  return DECK_BAR_HEIGHT + (mode === "full" ? 2 * waveHeight : 0);
}

/** Full panel if it fits between the top bar and the dock, else the facts row only, else its numbers only, else hidden. */
export function deckViewMode(windowHeight: number, dockHeight: number, waveHeight: number, chrome = TOP_BAR_HEIGHT): DeckViewMode {
  const room = windowHeight - dockHeight - chrome - MAIN_MIN_HEIGHT;
  return (["full", "headers", "compact"] as const).find(mode => room >= deckViewHeight(mode, waveHeight)) ?? "hidden";
}

/** What feeds `--cm-player-height` and the Toaster offset: the dock plus the panel. */
export const combinedPlayerHeight = (dockHeight: number, panelHeight: number) => dockHeight + panelHeight;

// The panel's DOM slots: each MiniPlayer portals its scrolling lane into its half of the shared screen and its facts
// (numbers and overview) into its half of the row under it.
// The lane height is not in the store, so dragging the panel's handle never re-renders a MiniPlayer.
interface ViewState { waveA: HTMLElement | null; waveB: HTMLElement | null; factsA: HTMLElement | null; factsB: HTMLElement | null; mode: DeckViewMode }
interface DeckSlots { wave: HTMLElement | null; facts: HTMLElement | null; mode: DeckViewMode }
let state: ViewState = { waveA: null, waveB: null, factsA: null, factsB: null, mode: "hidden" };
const EMPTY: DeckSlots = { wave: null, facts: null, mode: "hidden" };
let snaps: Record<DeckId, DeckSlots> = { A: EMPTY, B: EMPTY };
const listeners = new Set<() => void>();

function snapFor(deck: DeckId, prev: DeckSlots): DeckSlots {
  const wave = deck === "A" ? state.waveA : state.waveB;
  const facts = deck === "A" ? state.factsA : state.factsB;
  return prev.wave === wave && prev.facts === facts && prev.mode === state.mode ? prev : { wave, facts, mode: state.mode };
}

export function setDeckView(patch: Partial<ViewState>) {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof ViewState)[]).every(k => next[k] === state[k])) return;
  state = next;
  snaps = { A: snapFor("A", snaps.A), B: snapFor("B", snaps.B) };
  listeners.forEach(fn => fn());
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** For tests: the snapshot a deck's MiniPlayer sees. */
export const getDeckSlots = (deck: DeckId) => snaps[deck];

/** A deck's own lane and facts slots. The object only changes when one of that deck's slots or the mode changes. */
export function useDeckView(deck: DeckId): DeckSlots {
  return useSyncExternalStore(subscribe, () => snaps[deck]);
}
