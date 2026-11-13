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

/**
 * Switch theme with a circular reveal from (x, y) where View Transitions exist; instant otherwise or under
 * reduced motion (OS or the in-app data-reduce-motion). `flush` commits React's re-render inside the transition
 * (the caller passes react-dom's flushSync, which keeps this module free of react-dom). CSS: styles/shell.css.
 */
export function setThemeAnimated(theme: Theme, x: number, y: number, flush: (fn: () => void) => void): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const start = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition?.bind(document);
  const reduce = root.hasAttribute("data-reduce-motion")
    || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (!start || reduce) { setTheme(theme); return; }
  root.style.setProperty("--cm-vt-x", `${x}px`);
  root.style.setProperty("--cm-vt-y", `${y}px`);
  start(() => { flush(() => setTheme(theme)); });
}

/** React hook to read and change active theme. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setLocalTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    const fn = (t: Theme) => setLocalTheme(t);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  return [theme, setTheme];
}
