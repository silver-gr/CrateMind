// Drives a deck's Echo for an «Έξοδος με echo» transition, through the FX rack's store only (the host follows the store).
import { engage, getFxRack, release, selectPreset, setAmount } from "../fxRack";
import type { DeckId } from "../player";
import { ECHO_AMOUNT } from "../transitions/echoOut";

/** The rack's plain Echo: its tail rings on after a release. */
export const ECHO_PRESET = "echo";

export interface EchoRun {
  /** The echo's level 0..1; ignored once the user has taken the deck's effect over. */
  level(x: number): void;
  /** Releases the echo (its tail rings out) and puts the deck's own preset and amount back. */
  end(): void;
}

/**
 * Turns `deck`'s Echo on at amount 0. Null when the rack is not available or the deck's effect is already on (it is
 * the user's): the transition then plays as its plain cut.
 */
export function startEcho(deck: DeckId): EchoRun | null {
  const rack = getFxRack();
  const before = rack.decks[deck];
  if (!rack.available || before.on) return null;
  selectPreset(deck, ECHO_PRESET);
  setAmount(deck, 0);
  engage(deck, "latch");
  /** Still our echo: the user has not released it or switched the preset. */
  const ours = () => { const d = getFxRack().decks[deck]; return d.on && d.preset === ECHO_PRESET; };
  let ended = false;
  return {
    level(x) { if (!ended && ours()) setAmount(deck, x * ECHO_AMOUNT); },
    end() {
      if (ended) return;
      ended = true;
      if (!ours()) return;
      release(deck, true);
      selectPreset(deck, before.preset);
      setAmount(deck, before.amount);
    },
  };
}
