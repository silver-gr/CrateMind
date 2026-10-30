import { isDesktopRuntime } from "./desktopRuntime";

export const PWA_OVERLAY_QUERY = "(display-mode: window-controls-overlay)";

export interface PwaTitlebarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): PwaTitlebarGeometry;
}

export function resolvePwaTitlebarGeometry(state: {
  native: boolean;
  overlayMode: boolean;
  visible: boolean;
  fullscreen: boolean;
  rect?: PwaTitlebarGeometry;
}): PwaTitlebarGeometry | null {
  const { native, overlayMode, visible, fullscreen, rect } = state;
  if (native || !overlayMode || !visible || fullscreen || !rect) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function nativeTitlebar(): boolean {
  return isDesktopRuntime() || document.documentElement.dataset.nativeTitlebar === "overlay";
}

function overlayApi(): WindowControlsOverlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
}

export function readPwaTitlebarGeometry(): PwaTitlebarGeometry | null {
  if (typeof window === "undefined" || typeof document === "undefined" || nativeTitlebar()) return null;
  const overlay = overlayApi();
  if (!overlay) return null;
  try {
    return resolvePwaTitlebarGeometry({
      native: false,
      overlayMode: window.matchMedia(PWA_OVERLAY_QUERY).matches,
      visible: overlay.visible,
      fullscreen: Boolean(document.fullscreenElement) || window.matchMedia("(display-mode: fullscreen)").matches,
      rect: overlay.getTitlebarAreaRect(),
    });
  } catch {
    return null;
  }
}

export function subscribePwaTitlebar(update: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined" || nativeTitlebar()) return () => {};
  const overlay = overlayApi();
  if (!overlay) return () => {};
  const mode = window.matchMedia(PWA_OVERLAY_QUERY);
  const fullscreen = window.matchMedia("(display-mode: fullscreen)");
  overlay.addEventListener("geometrychange", update);
  window.addEventListener("resize", update);
  document.addEventListener("fullscreenchange", update);
  mode.addEventListener("change", update);
  fullscreen.addEventListener("change", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
    window.removeEventListener("resize", update);
    document.removeEventListener("fullscreenchange", update);
    mode.removeEventListener("change", update);
    fullscreen.removeEventListener("change", update);
  };
}
