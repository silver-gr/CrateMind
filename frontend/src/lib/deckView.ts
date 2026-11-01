import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export const WAVE_MIN_HEIGHT = 56;
export const WAVE_MAX_HEIGHT = 120;
export const WAVE_DEFAULT_HEIGHT = 88;
/** Header row of one deck (artwork, title, BPM, remaining time, key, overview strip). */
export const DECK_HEADER_HEIGHT = 52;
/** The routed page always keeps at least this much height. */
export const MAIN_MIN_HEIGHT = 240;

export type DeckViewMode = "full" | "headers" | "hidden";

/** Height of the whole panel: both decks' header rows, plus both waveforms unless collapsed to headers. */
export function deckViewHeight(mode: DeckViewMode, waveHeight: number): number {
  if (mode === "hidden") return 0;
  return 2 * (DECK_HEADER_HEIGHT + (mode === "full" ? waveHeight : 0));
}

/** Full panel if it fits above the dock, else headers only, else hidden. */
export function deckViewMode(windowHeight: number, dockHeight: number, waveHeight: number, chrome = 0): DeckViewMode {
  const room = windowHeight - dockHeight - chrome - MAIN_MIN_HEIGHT;
  if (room >= deckViewHeight("full", waveHeight)) return "full";
  if (room >= deckViewHeight("headers", waveHeight)) return "headers";
  return "hidden";
}

/** What feeds `--cm-player-height` and the Toaster offset: the dock plus the panel. */
export const combinedPlayerHeight = (dockHeight: number, panelHeight: number) => dockHeight + panelHeight;

// The panel's DOM slots, so each MiniPlayer can portal its header and waveform into its own deck area.
interface ViewState { A: HTMLElement | null; B: HTMLElement | null; mode: DeckViewMode; waveHeight: number }
let state: ViewState = { A: null, B: null, mode: "hidden", waveHeight: WAVE_DEFAULT_HEIGHT };
const listeners = new Set<() => void>();

export function setDeckView(patch: Partial<ViewState>) {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof ViewState)[]).every(k => next[k] === state[k])) return;
  state = next;
  listeners.forEach(fn => fn());
}

export function useDeckView(deck: DeckId): { slot: HTMLElement | null; mode: DeckViewMode; waveHeight: number } {
  const snap = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
  return { slot: snap[deck], mode: snap.mode, waveHeight: snap.waveHeight };
}
