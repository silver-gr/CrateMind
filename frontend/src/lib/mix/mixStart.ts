// Starting a mix session from a click: the deck loads happen inside the gesture (B then A), then the session starts.
import type { DeckId, DeckSlots, LoadOptions } from "../player";
import type { SetTransition } from "../transitions/types";
import type { Track } from "../types";
import { startMixSession } from "./mixSession";

/** A deck is playing a track outside the set: starting would replace it, so the button asks for a second press. */
export function shouldRequireSecondPress(slots: DeckSlots, playing: (deck: DeckId) => boolean, setTrackIds: ReadonlySet<number>): boolean {
  return (["A", "B"] as const).some(d => {
    const t = slots[d].track;
    return t != null && playing(d) && !setTrackIds.has(t.id);
  });
}

export const SECOND_PRESS_MS = 5000;

/** «Πάτα ξανά για αντικατάσταση»: `confirm(now)` is true only for a press within 5 s of the previous one. */
export function createSecondPress() {
  let armedAt: number | null = null;
  return {
    confirm(now: number): boolean {
      if (armedAt != null && now - armedAt < SECOND_PRESS_MS) { armedAt = null; return true; }
      armedAt = now;
      return false;
    },
    reset() { armedAt = null; },
  };
}

export interface PreviewDeps {
  load(deck: DeckId, track: Track, opts?: LoadOptions): boolean;
  /** `unlockPlaybackAudio`, called inside the gesture. */
  unlock(): void;
  mixer(): { fx: Record<DeckId, { keylock: boolean; range: number }> };
}

/** Preview one transition on the decks: the outgoing track on A, the incoming on B, both paused; the conductor seeks
 *  A to 4 bars before the window, plays it and arms the transition. Not tied to a set (set edits never reach it). */
export function startTransitionPreview(deps: PreviewDeps, input: { from: Track; to: Track; transition: SetTransition }): void {
  deps.load("B", input.to, { play: false });
  deps.load("A", input.from, { play: false });
  deps.unlock();
  const { fx } = deps.mixer();
  startMixSession({
    mode: "preview", setId: null, setTitle: "", tracks: [input.from, input.to], transitions: [input.transition], startIndex: 0,
    restore: { keylock: { A: fx.A.keylock, B: fx.B.keylock }, range: { A: fx.A.range, B: fx.B.range } },
  });
}
