import { preferenceStorage } from "./preferenceStorage";
/**
 * Local-first UI preferences. CrateMind's backend settings are read-only
 * (env-driven); the shared adapter uses browser storage on web and hydrated
 * per-device storage on desktop. Typed, subscribable, with a React hook.
 */
import { useEffect, useState } from "react";
import type { BackgroundId } from "../components/backgrounds/backgrounds";
import type { DjRangeKey } from "./tempoRanges";

export type LibraryProfile = "dj" | "therapy";

export interface Prefs {
  density: "comfortable" | "compact";
  reduceMotion: boolean; // user override on top of OS setting
  defaultQueue: "untagged" | "testing" | "";
  autoplayOnSelect: boolean;
  exportConfirm: boolean;
  showWaveform: boolean; // cosmetic transport waveform
  keyFormat: "camelot" | "musical" | "both";
  autoGain: boolean;
  audioLimiter: boolean;
  background: BackgroundId;
  waveformZoomBars: number; // deck scroll-waveform zoom, 2..32 bars
  waveformPalette: "theme" | "frequency"; // shared deck detail/overview colours
  waveformStrongGrid: boolean; // deck scroll-waveform «Έντονο beatgrid»: bolder beat/bar lines than the subtle default
  waveformTranslucent: boolean; // deck waveform panels partly see-through («Διαφανές πάνελ κυματομορφών»)
  deckViewPosition: "top" | "bottom"; // two-deck waveform panel: under the title bar, or above the dock
  dockCollapsed: boolean; // bottom deck dock folded to a thin strip (decks stay mounted and keep playing)
  deckViewCollapsed: boolean; // two-deck waveform panel folded to a thin strip (waveforms unmount; playback unaffected)
  libraryProfile: LibraryProfile; // DJ or «Μουσικοθεραπεία»: labels, keys and visible routes
  profileChosen: boolean; // false only on a fresh install, until the first-launch chooser is answered
  djTempoRange: DjRangeKey; // DJ profile's default BPM analysis window
  tempoRangeByRoot: Record<string, DjRangeKey>; // per music folder (listed root string) BPM window, DJ profile only
  libraryFacetPanel: { open: boolean; collapsed: string[] }; // Library «Φίλτρα» rail: shown, and its folded sections
  mainCrateId: number | null; // the dashboard hero's «Κύριο crate» (a saved search id); null shows «Όπλα»
}

export const DEFAULT_PREFS: Prefs = {
  density: "comfortable",
  reduceMotion: false,
  defaultQueue: "untagged",
  autoplayOnSelect: false,
  exportConfirm: true,
  showWaveform: true,
  keyFormat: "camelot",
  autoGain: false,
  audioLimiter: false,
  background: "soft-aurora",
  waveformZoomBars: 8,
  waveformPalette: "theme",
  waveformStrongGrid: false,
  waveformTranslucent: false,
  deckViewPosition: "top",
  dockCollapsed: false,
  deckViewCollapsed: false,
  libraryProfile: "dj",
  profileChosen: false,
  djTempoRange: "psy",
  tempoRangeByRoot: {},
  libraryFacetPanel: { open: false, collapsed: [] },
  mainCrateId: null,
};

/**
 * Keys only a used install has (Library columns and sort), even when no `Prefs`
 * field was ever changed. Written by tablePreferences.ts and Library.tsx, whose
 * page cannot open before the chooser is answered. Not the theme: the sidebar
 * toggle writes it while the chooser is still showing.
 */
const OLDER_INSTALL_KEYS = ["cratemind:table:full:v2", "cratemind:colw:v1", "cratemind:library-sort"];

export function hasOlderInstallKeys(getItem: (key: string) => string | null): boolean {
  return OLDER_INSTALL_KEYS.some(key => getItem(key) !== null);
}

/**
 * The profile prefs for a stored snapshot. A snapshot that exists but has no
 * `libraryProfile` comes from an install older than the switch: that user is a
 * DJ and never sees the chooser. So does an install with other CrateMind
 * preferences (`olderInstall`). Nothing stored means a fresh install.
 */
export function resolveProfilePrefs(
  stored: Partial<Prefs> | null, olderInstall = false,
): Pick<Prefs, "libraryProfile" | "profileChosen"> {
  if (stored?.libraryProfile === "dj" || stored?.libraryProfile === "therapy") {
    return { libraryProfile: stored.libraryProfile, profileChosen: stored.profileChosen ?? true };
  }
  const existing = (stored !== null && Object.keys(stored).length > 0) || olderInstall;
  return { libraryProfile: "dj", profileChosen: existing };
}

const KEY = "cratemind:prefs:v1";
const listeners = new Set<(p: Prefs) => void>();
let cache: Prefs | null = null;

function read(): Prefs {
  if (cache) return cache;
  try {
    const raw = preferenceStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<Prefs>) : null;
    const olderInstall = !stored?.libraryProfile && hasOlderInstallKeys(key => preferenceStorage.getItem(key));
    cache = { ...DEFAULT_PREFS, ...stored, ...resolveProfilePrefs(stored, olderInstall) };
  } catch {
    cache = { ...DEFAULT_PREFS };
  }
  return cache;
}

export function getPrefs(): Prefs {
  return read();
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return read()[key];
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...read(), [key]: value };
  cache = next;
  try {
    preferenceStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private-mode */
  }
  listeners.forEach((fn) => fn(next));
}

export function resetPrefs(): void {
  cache = { ...DEFAULT_PREFS };
  try {
    preferenceStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(cache as Prefs));
}

/** Subscribe to a single pref; returns [value, setter]. */
export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const [value, setValue] = useState<Prefs[K]>(() => read()[key]);
  useEffect(() => {
    const fn = (p: Prefs) => setValue(p[key]);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [key]);
  return [value, (v: Prefs[K]) => setPref(key, v)];
}
