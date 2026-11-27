/** Shared by the resizable app dock and standalone/reference decks. */
export const PLAYER_MIN_HEIGHT = 136;
export const PLAYER_MAX_HEIGHT = 170;
export const PLAYER_DEFAULT_HEIGHT = 170;

/** Two-deck dock bounds (starting point; tuned in the app). */
export const DECK_MIN_HEIGHT = 200;
export const DECK_MAX_HEIGHT = 280;
export const DECK_DEFAULT_HEIGHT = 208;

/** Old saved sizes and direct callers must respect the same dock bounds. */
export function playerDockHeight(height: number, twoDeck = false): number {
  const [min, max, fallback] = twoDeck
    ? [DECK_MIN_HEIGHT, DECK_MAX_HEIGHT, DECK_DEFAULT_HEIGHT]
    : [PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, PLAYER_DEFAULT_HEIGHT];
  return Number.isFinite(height) ? Math.max(min, Math.min(max, height)) : fallback;
}

export const DECK_HEIGHT_KEY = "cm:deck-height";
const DECK_HEIGHT_MOVED_KEY = "cm:deck-height-208";
/** The two-deck default while the overview still lived in the dock. */
const OLD_DECK_DEFAULT_HEIGHT = 240;

/**
 * Once: a stored two-deck height of exactly the old default was never a choice, so it becomes the new default. Any other
 * stored height is kept, and a height set to 240 after this ran stays.
 */
export function moveOldDeckHeight(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }): void {
  if (storage.getItem(DECK_HEIGHT_MOVED_KEY) !== null) return;
  storage.setItem(DECK_HEIGHT_MOVED_KEY, "1");
  if (storage.getItem(DECK_HEIGHT_KEY) === String(OLD_DECK_DEFAULT_HEIGHT)) storage.setItem(DECK_HEIGHT_KEY, String(DECK_DEFAULT_HEIGHT));
}

/**
 * The narrowest dock that keeps both decks whole (measured on the real two-deck dock at 208 px): from 1,312 px each deck keeps
 * its full 248 px info column and 166 px of pads, as many as at 1,496 px, where the cover art (at least 80 px) also fits.
 * Narrower, the info column shrinks (to 150 px) and the pads stop at 120 px; under about 1,020 px the outer pads clip. The cover
 * is a picture (the facts row above the dock names the track), so it is the part given up for the side columns.
 */
export const DOCK_COLUMN_MIN_WIDTH = 1312;

/** Which side columns (the sidebar or a page's left panel, and a page's right panel) run beside the dock to the window's bottom. */
export type DockSides = "both" | "left" | "right" | "none";

/**
 * Where the two-deck dock sits, from the page column's width and the two side columns' widths (0 when empty). Both side columns
 * run to the bottom when the column between them leaves the dock at least DOCK_COLUMN_MIN_WIDTH; otherwise one of them, the
 * right panel first (it holds the longer content: the track editor and its save button), when the dock spans under the other
 * one and is still that wide; otherwise the dock spans the window under both, as with one deck.
 */
export function dockSides(columnWidth: number, leftWidth: number, rightWidth: number, twoDeck: boolean): DockSides {
  if (!twoDeck || columnWidth <= 0) return "none";
  if (columnWidth >= DOCK_COLUMN_MIN_WIDTH) return "both";
  if (rightWidth > 0 && columnWidth + leftWidth >= DOCK_COLUMN_MIN_WIDTH) return "right";
  if (leftWidth > 0 && columnWidth + rightWidth >= DOCK_COLUMN_MIN_WIDTH) return "left";
  return "none";
}

/**
 * The narrowest page column beside which the right rail also takes the top row (measured 2026-11-27): the two-deck lanes span only
 * the page column then, and each half of the facts row needs about 284 px for its numbers (bars, tempo, key, time left), so under
 * 720 px they run into the centre cell. Narrower, the rail starts under the top deck panel and the lanes span over it.
 */
export const RAIL_TOP_MIN_COLUMN = 720;
