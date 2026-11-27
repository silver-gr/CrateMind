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
 * The narrowest page column the two-deck dock moves into (measured on the real dock at 208 px): from 1,500 px each deck keeps
 * its cover (at least 80 px), 169 px of pads and the 248 px info column. It is 1,496, 2 px of pads less per deck, because a
 * 1,728 px window beside the 232 px sidebar leaves exactly that, and the sidebar should reach the bottom there. With two decks and a column at least this wide, the
 * dock sits in the page column and the sidebar and the page's right panel run beside it to the window's bottom; otherwise it
 * spans the window under them, as before.
 */
export const DOCK_COLUMN_MIN_WIDTH = 1496;

export function dockInColumn(columnWidth: number, twoDeck: boolean): boolean {
  return twoDeck && columnWidth >= DOCK_COLUMN_MIN_WIDTH;
}
