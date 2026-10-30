/**
 * PWA plumbing: service-worker registration + a captured `beforeinstallprompt`
 * so the app can show its own install UI instead of the browser's mini-infobar.
 * Imported once from main.tsx so the listener is attached before the event fires.
 */
import { useSyncExternalStore } from "react";
import { isDesktopRuntime } from "./desktopRuntime";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed =
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

if (typeof window !== "undefined" && !isDesktopRuntime()) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the browser's own infobar; we render ours
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });

  // Dev runs without a SW so Vite HMR is never served from cache.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* non-fatal: app works as a plain web page */
      });
    });
  }
}

/** iOS/iPadOS Safari never fires beforeinstallprompt — install is manual via Share sheet. */
export const isIOS =
  !isDesktopRuntime() &&
  typeof navigator !== "undefined" &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

interface InstallState {
  canPrompt: boolean;
  installed: boolean;
}
let snapshot: InstallState = { canPrompt: false, installed };

function getSnapshot(): InstallState {
  if (snapshot.canPrompt !== !!deferred || snapshot.installed !== installed) {
    snapshot = { canPrompt: !!deferred, installed };
  }
  return snapshot;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Show the native install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const evt = deferred;
  deferred = null; // a captured event can only be prompted once
  emit();
  await evt.prompt();
  const { outcome } = await evt.userChoice;
  return outcome === "accepted";
}

export function useInstallPrompt(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
