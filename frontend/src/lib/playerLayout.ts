/** Shared by the resizable app dock and standalone/reference decks. */
export const PLAYER_MIN_HEIGHT = 136;
export const PLAYER_MAX_HEIGHT = 170;
export const PLAYER_DEFAULT_HEIGHT = 170;

/** Old saved sizes and direct callers must respect the same dock bounds. */
export function playerDockHeight(height: number): number {
  return Number.isFinite(height)
    ? Math.max(PLAYER_MIN_HEIGHT, Math.min(PLAYER_MAX_HEIGHT, height))
    : PLAYER_DEFAULT_HEIGHT;
}
