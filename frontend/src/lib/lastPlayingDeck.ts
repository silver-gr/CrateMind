import type { DeckId } from "./player";

// Which deck played last, kept apart from player.tsx so that the MIDI bridge can read it without importing the player.
const playing: Record<DeckId, boolean> = { A: false, B: false };
/** The deck that most recently went from stopped to playing (null until one has). */
let lastStarted: DeckId | null = null;

/** The player reports each deck's play state here whenever one of its media changes. */
export function noteDeckPlaying(deck: DeckId, isPlaying: boolean) {
  if (isPlaying && !playing[deck]) lastStarted = deck;
  playing[deck] = isPlaying;
}

/**
 * The last playing deck: the one that started most recently if it still plays, else the other one if that plays, else the
 * one that started most recently (now stopped); null when no deck has played yet. Shift + BEATS on the controller acts on it.
 */
export function lastPlayingDeck(): DeckId | null {
  if (!lastStarted || playing[lastStarted]) return lastStarted;
  const other: DeckId = lastStarted === "A" ? "B" : "A";
  return playing[other] ? other : lastStarted;
}

/** Test hook. */
export function resetLastPlayingDeck() {
  playing.A = playing.B = false;
  lastStarted = null;
}
