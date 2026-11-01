import { preferenceStorage } from "./preferenceStorage";
/**
 * Local-first UI preferences. CrateMind's backend settings are read-only
 * (env-driven); the shared adapter uses browser storage on web and hydrated
 * per-device storage on desktop. Typed, subscribable, with a React hook.
 */
import { useEffect, useState } from "react";
import type { BackgroundId } from "../components/backgrounds/backgrounds";

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
  waveformPalette: "theme" | "frequency"; // deck scroll-waveform colours
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
};

const KEY = "cratemind:prefs:v1";
const listeners = new Set<(p: Prefs) => void>();
let cache: Prefs | null = null;

function read(): Prefs {
  if (cache) return cache;
  try {
    const raw = preferenceStorage.getItem(KEY);
    cache = raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULT_PREFS };
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
