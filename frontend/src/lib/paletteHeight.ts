/**
 * The ⌘K palette's height (components/CommandPalette.tsx): about 70% of the window by default, resizable from its bottom
 * edge, remembered in preference storage. The stored value is what the user chose; every open clamps it to the window
 * it opens in without writing the clamp back, so a height chosen on a big screen survives a session on a small one.
 */
export const PALETTE_HEIGHT_KEY = "cm:palette-height";
export const PALETTE_MIN_HEIGHT = 320;
/** Default share of the window's height. */
export const PALETTE_DEFAULT_SHARE = 0.7;
/** Gap kept under the title bar and above the window's bottom edge. */
export const PALETTE_EDGE = 16;
/** Arrow Up / Down on the handle. */
export const PALETTE_STEP = 40;

export type PaletteFrame = { top: number; min: number; max: number; preferred: number };

/** Where the palette sits in a window `windowHeight` tall under a `titleBar` px title bar, and how tall it may be. */
export function paletteFrame(windowHeight: number, titleBar: number): PaletteFrame {
  const below = Math.max(0, windowHeight - titleBar);
  // A fixed top for the window size, so dragging the bottom edge never moves the field.
  const top = titleBar + Math.max(PALETTE_EDGE, Math.round(below * 0.08));
  const max = Math.max(160, windowHeight - top - PALETTE_EDGE);
  const min = Math.min(PALETTE_MIN_HEIGHT, max);
  const preferred = Math.round(windowHeight * PALETTE_DEFAULT_SHARE);
  return { top, min, max, preferred: clamp(preferred, min, max) };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A stored height, or null for none or anything that is not a positive number. */
export function parsePaletteHeight(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** The height to show: the stored choice clamped to this window, else the default. */
export function paletteHeight(stored: number | null, frame: PaletteFrame): number {
  return stored === null ? frame.preferred : clamp(stored, frame.min, frame.max);
}

/** The handle's keys: Arrow Down grows (the edge moves down), Arrow Up shrinks, Home / End go to the limits; else null. */
export function paletteKeyHeight(key: string, current: number, frame: PaletteFrame): number | null {
  if (key === "ArrowDown") return clamp(current + PALETTE_STEP, frame.min, frame.max);
  if (key === "ArrowUp") return clamp(current - PALETTE_STEP, frame.min, frame.max);
  if (key === "Home") return frame.min;
  if (key === "End") return frame.max;
  return null;
}

/** A drag that started at `startHeight` and moved the pointer `dy` px down. */
export function paletteDragHeight(startHeight: number, dy: number, frame: PaletteFrame): number {
  return Math.round(clamp(startHeight + dy, frame.min, frame.max));
}
