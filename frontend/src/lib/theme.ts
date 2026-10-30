import { preferenceStorage } from "./preferenceStorage";
/**
 * CrateMind Theme Manager (Night Void ⇄ Solar Void)
 *
 * Persists user preference under "cratemind-theme" in preferenceStorage.
 * Sets `data-theme="light" | "dark"` and toggles .dark / .light classes on <html>.
 * Zero re-render required for CSS token switching; React components subscribe via `useTheme`.
 */
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "cratemind-theme";
// Solid browser-owned window controls and the PWA's matching edge patches.
export const BROWSER_THEME_COLORS: Record<Theme, string> = { dark: "#040510", light: "#f2f5fe" };
const listeners = new Set<(t: Theme) => void>();

export function getTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const val = preferenceStorage.getItem(THEME_STORAGE_KEY);
    if (val === "light" || val === "dark") return val;
  } catch {
    /* ignore */
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  const color = BROWSER_THEME_COLORS[theme];
  root.style.setProperty("--cm-browser-theme-color", color);
  let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColor) {
    themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
  }
  themeColor.content = color;
  if (theme === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    preferenceStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(theme));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** React hook to read and change active theme. */
export function useTheme(): [Theme, (t: Theme) => void, () => Theme] {
  const [theme, setLocalTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    const fn = (t: Theme) => setLocalTheme(t);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  return [theme, setTheme, toggleTheme];
}
