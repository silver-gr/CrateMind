import { preferenceStorage } from "./preferenceStorage";
/**
 * Local-first UI preferences. CrateMind's backend settings are read-only
 * (env-driven); the shared adapter uses browser storage on web and hydrated
 * per-device storage on desktop. Typed, subscribable, with a React hook.
 */
import { useEffect, useState } from "react";
import type { BackgroundId } from "../components/backgrounds/backgrounds";
import type { GroupKey } from "./libraryGrouping";
import type { DjRangeKey } from "./tempoRanges";

export type LibraryProfile = "dj" | "therapy";
/** One deck's saved effect: preset id, amount 0..1, and BEATS indexes by preset id (non-default entries only). */
export type FxRackDeckPrefs = { preset: string; amount: number; beats: Record<string, number> };
/** Saved deck FX rack (fxRack.ts sanitises it on read). */
export type FxRackPrefs = { A: FxRackDeckPrefs; B: FxRackDeckPrefs; favourites: string[]; phraseRelease: { A: boolean; B: boolean } };
/** The Library side panel's tabs: «Φίλτρα», «Καλλιτέχνες», «Ιστορικό». */
export type LibraryPanelTab = "filters" | "artists" | "history";
export const LIBRARY_PANEL_TABS: readonly LibraryPanelTab[] = ["filters", "artists", "history"];
export function isLibraryPanelTab(value: unknown): value is LibraryPanelTab {
  return LIBRARY_PANEL_TABS.includes(value as LibraryPanelTab);
}

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
  maximizer: boolean; // built-in Maximizer on the master bus (master_me)
  maximizerTargetDb: number; // its loudness target, LUFS, -18..-6
  maximizerCeilingDb: number; // its sample-peak ceiling, dB, -3..0
  recordingFormat: "wav" | "aac256" | "aac128"; // set recordings: kept as WAV, or converted to AAC at stop
  background: BackgroundId;
  waveformZoomBars: number; // deck scroll-waveform zoom, 2..32 bars
  waveformPalette: "theme" | "frequency"; // shared deck detail/overview colours
  waveformStrongGrid: boolean; // deck scroll-waveform «Έντονο beatgrid»: bolder beat/bar lines than the subtle default
  waveformTranslucent: boolean; // deck waveform panels partly see-through («Διαφανές πάνελ κυματομορφών»)
  deckViewPosition: "top" | "bottom"; // two-deck waveform panel: under the title bar, or above the dock
  sidebarCollapseStyle: "dock" | "rail"; // a collapsed sidebar: the floating dock, or a narrow icon rail on the left edge
  dockCollapsed: boolean; // bottom deck dock folded to a thin strip (decks stay mounted and keep playing)
  deckViewCollapsed: boolean; // two-deck waveform panel folded to a thin strip (waveforms unmount; playback unaffected)
  setsCandidatesFolded: boolean; // Set Builder: the candidates panel folded to a thin strip
  setsAnalysisFolded: boolean; // Set Builder: the analysis panel folded to a thin strip
  libraryProfile: LibraryProfile; // DJ or «Μουσικοθεραπεία»: labels, keys and visible routes
  profileChosen: boolean; // false only on a fresh install, until the first-launch chooser is answered
  djTempoRange: DjRangeKey; // DJ profile's default BPM analysis window
  tempoRangeByRoot: Record<string, DjRangeKey>; // per music folder (listed root string) BPM window, DJ profile only
  libraryFacetPanel: { open: boolean; collapsed: string[]; tab: LibraryPanelTab }; // Library side panel: shown, the folded «Φίλτρα» sections, and its tab
  libraryGroupBy: GroupKey; // Library «Ομαδοποίηση»: the track list split into collapsible sections
  mainCrateId: number | null; // the dashboard hero's «Κύριο crate» (a saved search id); null shows «Bangers»
  recentDeckLoads: { id: number; deck: "A" | "B"; at: number }[]; // dashboard «Φορτώθηκαν πρόσφατα», newest first (deckHistory.ts)
  fxRack: FxRackPrefs | null; // deck FX rack (fxRack.ts); null until first saved, which means the first-run defaults
  masterHostPlugin: string | null; // the VST3 plugin path of the master slot at the last start that succeeded (desktop, macOS)
  hostPluginDeckA: string | null; // the same for the Deck A slot; null = «Κανένα»
  hostPluginDeckB: string | null; // the same for the Deck B slot; null = «Κανένα»
  transitionStructureTiming: boolean; // «Χρονισμός από τη δομή»: unsaved transition windows are timed from the tracks' structure
  cueSuggestions: boolean; // «Προτεινόμενα cues από τη δομή»: empty pads 5–8 show cues suggested from the track's structure
  quantize: boolean; // two-deck «Q»: loops and hot cues land on the beats of a trusted grid (lib/quantize.ts)
  jogNudge: boolean; // «Jog nudge»: while a deck plays, an unshifted controller jog turn bends its tempo for a moment (lib/midi.ts)
  fxButtonsPickEffect: boolean; // «Τα κουμπιά FX διαλέγουν εφέ»: the six FX buttons set an effect on both decks instead of a transition note (lib/fxButtons.ts)
  fxButtonPresets: string[] | null; // the six FX buttons' effects (preset ids, wire order); null = the printed names' defaults
  deckRating: boolean; // «Γρήγορη βαθμολογία»: the decks show status, energy and darkness controls (components/DeckRatingStrip.tsx)
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
  maximizer: false,
  maximizerTargetDb: -9,
  maximizerCeilingDb: -1,
  recordingFormat: "wav",
  background: "soft-aurora",
  waveformZoomBars: 8,
  waveformPalette: "theme",
  waveformStrongGrid: false,
  waveformTranslucent: false,
  deckViewPosition: "top",
  sidebarCollapseStyle: "dock",
  dockCollapsed: false,
  deckViewCollapsed: false,
  setsCandidatesFolded: false,
  setsAnalysisFolded: false,
  libraryProfile: "dj",
  profileChosen: false,
  djTempoRange: "psy",
  tempoRangeByRoot: {},
  libraryFacetPanel: { open: false, collapsed: [], tab: "filters" },
  libraryGroupBy: "none",
  mainCrateId: null,
  recentDeckLoads: [],
  fxRack: null,
  masterHostPlugin: null,
  hostPluginDeckA: null,
  hostPluginDeckB: null,
  transitionStructureTiming: false,
  cueSuggestions: false,
  quantize: false,
  jogNudge: false,
  fxButtonsPickEffect: false,
  fxButtonPresets: null,
  deckRating: false,
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

/** A stored panel pref read whole: values saved before the tabs (or with an unknown tab) open on «Φίλτρα». */
export function normalizeFacetPanel(stored: Partial<Prefs["libraryFacetPanel"]> | undefined): Prefs["libraryFacetPanel"] {
  return {
    open: stored?.open === true,
    collapsed: Array.isArray(stored?.collapsed) ? stored.collapsed : [],
    tab: isLibraryPanelTab(stored?.tab) ? stored.tab : "filters",
  };
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
    cache = {
      ...DEFAULT_PREFS, ...stored, ...resolveProfilePrefs(stored, olderInstall),
      libraryFacetPanel: normalizeFacetPanel(stored?.libraryFacetPanel),
    };
  } catch {
    cache = { ...DEFAULT_PREFS };
  }
  return cache;
}

// Another web tab wrote the blob: drop this tab's cache so its next setPref merges onto the fresh copy.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== KEY) return;
    cache = null;
    const next = read();
    listeners.forEach((fn) => fn(next));
  });
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
