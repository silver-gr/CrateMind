import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Track } from "./types";
import { api } from "./api";
import { ANALYSIS_FINISHED, BPM_UPDATED, applyBpmFields, type BpmUpdatedDetail } from "./bpmUpdates";
import { getPref } from "./prefs";
import { unlockPlaybackAudio } from "./playbackAudio";
import { toast } from "sonner";
import type { MediaLike } from "./media";
import { getMixer, isTwoDeck, useMidiConnected } from "./mixer";

export type DeckId = "A" | "B";
export type DeckSlot = { track: Track | null; token: number; autoPlay: boolean };
export type DeckSlots = Record<DeckId, DeckSlot>;
export type LoadOptions = { play?: boolean; ifIdle?: boolean };

export const emptySlots = (): DeckSlots => ({
  A: { track: null, token: 0, autoPlay: true },
  B: { track: null, token: 0, autoPlay: true },
});

/** Pure slot transitions; the provider owns the state. Returns null when `ifIdle` refuses a playing deck. */
export function loadIntoSlots(slots: DeckSlots, deck: DeckId, track: Track, opts: LoadOptions, playing: boolean): DeckSlots | null {
  if (opts.ifIdle && playing) return null;
  return { ...slots, [deck]: { track, token: slots[deck].token + 1, autoPlay: opts.play ?? true } };
}
export const ejectFromSlots = (slots: DeckSlots, deck: DeckId): DeckSlots =>
  ({ ...slots, [deck]: { ...slots[deck], track: null } });
export const clearSlots = (slots: DeckSlots): DeckSlots => ejectFromSlots(ejectFromSlots(slots, "A"), "B");
/** Updates a loaded track's fields in place. The token stays, so the deck's load effect does not fire and playback goes on. */
export function patchSlotsTrack(slots: DeckSlots, trackId: number, patch: (track: Track) => Track): DeckSlots {
  if (slots.A.track?.id !== trackId && slots.B.track?.id !== trackId) return slots;
  const patchSlot = (slot: DeckSlot): DeckSlot => (slot.track?.id === trackId ? { ...slot, track: patch(slot.track) } : slot);
  return { A: patchSlot(slots.A), B: patchSlot(slots.B) };
}

export type PlayRoute = { deck: DeckId; play: boolean } | null;
/**
 * Where "play this track" goes. Single-deck: A. Two-deck: an empty deck (A first), else a deck that
 * isn't playing (both free: the one that isn't `lastActive`). Null (refuse) only when both play.
 * `play` is false when the other deck is playing: the track is loaded cued instead of started.
 */
export function routePlay(slots: DeckSlots, isPlaying: (deck: DeckId) => boolean, lastActive: DeckId | null, twoDeck: boolean): PlayRoute {
  if (!twoDeck) return { deck: "A", play: true };
  const deck = slots.A.track === null ? "A"
    : slots.B.track === null ? "B"
    : !isPlaying("A") && !isPlaying("B") ? (lastActive === "A" ? "B" : "A")
    : !isPlaying("A") ? "A"
    : !isPlaying("B") ? "B" : null;
  if (deck === null) return null;
  return { deck, play: !isPlaying(deck === "A" ? "B" : "A") };
}

interface PlayerState {
  /** Deck A's track and token (aliases of slots.A) */
  current: Track | null;
  /** monotonic token — bumps on every load so re-playing the same track works */
  token: number;
  slots: DeckSlots;
  /** Same as `playRouted`: every UI "play this track" goes through deck routing. */
  play: (track: Track) => void;
  playRouted: (track: Track) => void;
  /** Returns false (changing nothing) when `ifIdle` is set and that deck is playing. */
  load: (deck: DeckId, track: Track, opts?: LoadOptions) => boolean;
  eject: (deck: DeckId) => void;
  deckIsPlaying: (deck: DeckId) => boolean;
  clear: () => void;
  playingTrackId: number | null;
  processingStatus: string;
}

const PlayerCtx = createContext<PlayerState | null>(null);

// Both decks can be audible; activeAudio marks the last-started one, which the keyboard controls.
let activeAudio: MediaLike | null = null;
// The deck that last started; unlike activeAudio it survives releaseAudio, so routing can still avoid it.
let lastActiveDeck: DeckId | null = null;
export const getLastActiveDeck = () => lastActiveDeck;
type DeckState = { trackId: number | null; playing: boolean; status: string; primary: boolean; deck?: DeckId };
const decks = new Map<MediaLike, DeckState>();
const playbackListeners = new Set<() => void>();
const idlePlayback = { playingTrackId: null as number | null, processingStatus: "" };
let playbackSnapshot = idlePlayback;
function publishPlayback() {
  const owner = playbackKeyOwner();
  const ownerDeck = owner ? decks.get(owner) : [...decks.values()].find(deck => deck.primary);
  const deck = ownerDeck?.playing ? ownerDeck : [...decks.values()].find(d => d.playing) ?? ownerDeck;
  const playingTrackId = deck?.playing ? deck.trackId : null;
  const processingStatus = deck?.status ?? "";
  if (playingTrackId === playbackSnapshot.playingTrackId && processingStatus === playbackSnapshot.processingStatus) return;
  playbackSnapshot = { playingTrackId, processingStatus };
  playbackListeners.forEach(listener => listener());
}
export function reportPlayback(audio: MediaLike, state: DeckState) {
  decks.set(audio, state);
  publishPlayback();
}
const subscribePlayback = (listener: () => void) => {
  playbackListeners.add(listener);
  return () => { playbackListeners.delete(listener); };
};
export const getPlaybackSnapshot = () => playbackSnapshot;
export function deckIsPlaying(deck: DeckId): boolean {
  return [...decks.values()].some(state => state.deck === deck && state.playing);
}
function playbackKeyOwner(): MediaLike | null {
  if (activeAudio) return activeAudio;
  const loaded = [...decks.entries()].filter(([, deck]) => deck.trackId !== null);
  return loaded.find(([, deck]) => deck.primary)?.[0] ?? loaded[0]?.[0] ?? null;
}
export function hasPlaybackKeyOwner() { return playbackKeyOwner() !== null; }

export function activateAudio(audio: MediaLike) {
  activeAudio = audio;
  lastActiveDeck = decks.get(audio)?.deck ?? lastActiveDeck;
  publishPlayback();
}

export function releaseAudio(audio: MediaLike) {
  audio.pause();
  if (activeAudio === audio) activeAudio = null;
  decks.delete(audio);
  publishPlayback();
}

export function ownsPlaybackKeys(audio: MediaLike, primary: boolean) {
  const owner = playbackKeyOwner();
  return owner === audio || (owner === null && primary);
}

export function audioUrl(trackId: number): string {
  return `/api/tracks/${trackId}/audio`;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const playback = useSyncExternalStore(subscribePlayback, getPlaybackSnapshot, () => idlePlayback);
  const [slots, setSlots] = useState(emptySlots);
  const slotsRef = useRef(slots);
  const commit = (next: DeckSlots) => { slotsRef.current = next; setSlots(next); };

  const load = (deck: DeckId, track: Track, opts: LoadOptions = {}): boolean => {
    const next = loadIntoSlots(slotsRef.current, deck, track, opts, deckIsPlaying(deck));
    if (!next) return false;
    if (opts.play ?? true) {
      // Decide on the resulting mode: this gesture may be what first loads Deck B.
      const twoDeck = isTwoDeck(getMixer().midiConnected, next.B.track);
      if (getPref("autoGain") || getPref("audioLimiter") || twoDeck) void unlockPlaybackAudio().catch(() => {});
    }
    commit(next);
    return true;
  };
  const playRouted = (track: Track) => {
    const twoDeck = isTwoDeck(getMixer().midiConnected, slotsRef.current.B.track);
    const route = routePlay(slotsRef.current, deckIsPlaying, lastActiveDeck, twoDeck);
    if (!route) { toast("Και τα δύο decks παίζουν"); return; }
    load(route.deck, track, { play: route.play });
    if (!route.play) toast(`Φορτώθηκε στο Deck ${route.deck} — πάτα Play`);
  };
  const eject = (deck: DeckId) => commit(ejectFromSlots(slotsRef.current, deck));
  // A manual BPM fix or a finished analysis updates the loaded tracks without reloading the decks.
  useEffect(() => {
    function onBpmUpdated(e: Event) {
      const detail = (e as CustomEvent<BpmUpdatedDetail>).detail;
      if (detail) commit(patchSlotsTrack(slotsRef.current, detail.trackId, track => applyBpmFields(track, detail.fields)));
    }
    function onAnalysisFinished() {
      const ids = new Set([slotsRef.current.A.track?.id, slotsRef.current.B.track?.id].filter((id): id is number => id != null));
      for (const id of ids) {
        api.getTrack(id).then(d => commit(patchSlotsTrack(slotsRef.current, id, track => ({ ...track, ...d.track })))).catch(() => {});
      }
    }
    window.addEventListener(BPM_UPDATED, onBpmUpdated);
    window.addEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
    return () => {
      window.removeEventListener(BPM_UPDATED, onBpmUpdated);
      window.removeEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
    };
  }, []);
  const clear = () => commit(clearSlots(slotsRef.current));

  return (
    <PlayerCtx.Provider value={{ current: slots.A.track, token: slots.A.token, slots, play: playRouted, playRouted, load, eject, deckIsPlaying, clear, ...playback }}>
      {children}
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within <PlayerProvider>");
  return ctx;
}

export function useTwoDeck(): boolean {
  return isTwoDeck(useMidiConnected(), usePlayer().slots.B.track);
}
