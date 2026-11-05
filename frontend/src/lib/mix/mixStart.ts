// Starting a mix session from a click: the deck loads happen inside the gesture (B then A), then the session starts.
import { useSyncExternalStore } from "react";
import type { DeckId, DeckSlots, LoadOptions } from "../player";
import type { SetTransition } from "../transitions/types";
import type { Track } from "../types";
import { getMixSession, notifyMixSetChanged, startMixSession, subscribeMix, type MixSession } from "./mixSession";

/** A deck is playing a track outside the set, or a set mix is running (`session`): starting would replace it, so the
 *  button asks for a second press. */
export function shouldRequireSecondPress(
  slots: DeckSlots, playing: (deck: DeckId) => boolean, setTrackIds: ReadonlySet<number>, session?: MixSession,
): boolean {
  if (session?.mode === "set" && session.status !== "idle" && session.status !== "stopping") return true;
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

const restoreOf = (mixer: PreviewDeps["mixer"]): MixSession["restore"] => {
  const { fx } = mixer();
  return { keylock: { A: fx.A.keylock, B: fx.B.keylock }, range: { A: fx.A.range, B: fx.B.range } };
};

/** Preview one transition on the decks: the outgoing track on A, the incoming on B, both paused; the conductor seeks
 *  A to 4 bars before the window, plays it and arms the transition. Not tied to a set (set edits never reach it). */
export function startTransitionPreview(deps: PreviewDeps, input: { from: Track; to: Track; transition: SetTransition }): void {
  deps.load("B", input.to, { play: false });
  deps.load("A", input.from, { play: false });
  deps.unlock();
  startMixSession({
    mode: "preview", setId: null, setTitle: "", tracks: [input.from, input.to], transitions: [input.transition], startIndex: 0,
    restore: restoreOf(deps.mixer),
  });
}

/** «Αναπαραγωγή ως μίξη»: the second track on B (paused), then the first on A (playing; a two-deck load unlocks the
 *  audio inside this gesture), then the set session; the conductor pre-loads every later track itself. */
export function startSetMix(
  deps: Pick<PreviewDeps, "load" | "mixer">,
  input: { setId: number; setTitle: string; tracks: Track[]; transitions: SetTransition[] },
): void {
  const [first, second] = input.tracks;
  if (!first || !second) return;
  deps.load("B", second, { play: false });
  deps.load("A", first, { play: true });
  startMixSession({
    mode: "set", setId: input.setId, setTitle: input.setTitle, tracks: input.tracks, transitions: input.transitions, startIndex: 0,
    restore: restoreOf(deps.mixer),
  });
}

/** The header button's state for one set: a running set session for it, one winding down (restoring key lock), or none. */
export function setMixState(s: MixSession, setId: number | null): "idle" | "active" | "stopping" {
  if (setId === null || s.mode !== "set" || s.setId !== setId || s.status === "idle") return "idle";
  return s.status === "stopping" ? "stopping" : "active";
}
/** Re-renders only when the state for this set changes, not on every countdown tick. */
export const useSetMixState = (setId: number | null) => {
  const read = () => setMixState(getMixSession(), setId);
  return useSyncExternalStore(subscribeMix, read, read);
};

/** An edit of the set as the Set Builder saw it (add, reorder, removal, a saved or reset transition): committed (with the
 *  set's order and transitions) or failed (409, network). */
export type SetMutationResult =
  | { ok: true; setId: number; tracks: Track[]; transitions: SetTransition[] }
  | { ok: false; error: unknown };

/** Only a committed edit reaches a running mix of that set (its queue is rebuilt from the new order, or the mix stops
 *  when the playing track was removed); a failed one never does. */
export function afterSetMutation(result: SetMutationResult): void {
  if (result.ok) notifyMixSetChanged(result.setId, result.tracks, result.transitions);
}
