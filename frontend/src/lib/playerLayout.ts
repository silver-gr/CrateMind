/** Shared by the resizable app dock and standalone/reference decks. */
export const PLAYER_MIN_HEIGHT = 136;
export const PLAYER_MAX_HEIGHT = 170;
export const PLAYER_DEFAULT_HEIGHT = 170;

/** Two-deck dock bounds (starting point; tuned in the app). */
export const DECK_MIN_HEIGHT = 200;
export const DECK_MAX_HEIGHT = 280;
export const DECK_DEFAULT_HEIGHT = 240;

/** Old saved sizes and direct callers must respect the same dock bounds. */
export function playerDockHeight(height: number, twoDeck = false): number {
  const [min, max, fallback] = twoDeck
    ? [DECK_MIN_HEIGHT, DECK_MAX_HEIGHT, DECK_DEFAULT_HEIGHT]
    : [PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, PLAYER_DEFAULT_HEIGHT];
  return Number.isFinite(height) ? Math.max(min, Math.min(max, height)) : fallback;
}
