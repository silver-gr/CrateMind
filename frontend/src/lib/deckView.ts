import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export const WAVE_MIN_HEIGHT = 48;
export const WAVE_MAX_HEIGHT = 128;
export const WAVE_DEFAULT_HEIGHT = 72;
/** The slim bar under the waveforms with the fold and view toggles. Each deck's info lives in the dock. */
export const DECK_BAR_HEIGHT = 22;
/** The routed page always keeps at least this much height. */
export const MAIN_MIN_HEIGHT = 240;

export type DeckViewMode = "full" | "headers" | "hidden";

/** Both lanes stacked edge to edge plus the bar; headers-only keeps just the bar. */
export function deckViewHeight(mode: DeckViewMode, waveHeight: number): number {
  if (mode === "hidden") return 0;
  return DECK_BAR_HEIGHT + (mode === "full" ? 2 * waveHeight : 0);
}

/** Full panel if it fits above the dock, else the bar only, else hidden. */
export function deckViewMode(windowHeight: number, dockHeight: number, waveHeight: number, chrome = 0): DeckViewMode {
  const room = windowHeight - dockHeight - chrome - MAIN_MIN_HEIGHT;
  if (room >= deckViewHeight("full", waveHeight)) return "full";
  if (room >= deckViewHeight("headers", waveHeight)) return "headers";
  return "hidden";
}

/** What feeds `--cm-player-height` and the Toaster offset: the dock plus the panel. */
export const combinedPlayerHeight = (dockHeight: number, panelHeight: number) => dockHeight + panelHeight;

// The panel's DOM slots: each MiniPlayer portals its scrolling lane into its half of the shared screen.
// The lane height is not in the store, so dragging the panel's handle never re-renders a MiniPlayer.
interface ViewState { waveA: HTMLElement | null; waveB: HTMLElement | null; mode: DeckViewMode }
interface DeckSlots { wave: HTMLElement | null; mode: DeckViewMode }
let state: ViewState = { waveA: null, waveB: null, mode: "hidden" };
const EMPTY: DeckSlots = { wave: null, mode: "hidden" };
let snaps: Record<DeckId, DeckSlots> = { A: EMPTY, B: EMPTY };
const listeners = new Set<() => void>();

function snapFor(deck: DeckId, prev: DeckSlots): DeckSlots {
  const wave = deck === "A" ? state.waveA : state.waveB;
  return prev.wave === wave && prev.mode === state.mode ? prev : { wave, mode: state.mode };
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

/** A deck's own lane slot. The object only changes when that deck's slot or the mode changes. */
export function useDeckView(deck: DeckId): DeckSlots {
  return useSyncExternalStore(subscribe, () => snaps[deck]);
}
