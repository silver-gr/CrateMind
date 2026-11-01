import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Track } from "./types";
import { getPref } from "./prefs";
import { unlockPlaybackAudio } from "./playbackAudio";
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

interface PlayerState {
  /** Deck A's track and token (aliases of slots.A) */
  current: Track | null;
  /** monotonic token — bumps on every load so re-playing the same track works */
  token: number;
  slots: DeckSlots;
  play: (track: Track) => void;
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
let activeAudio: HTMLAudioElement | null = null;
type DeckState = { trackId: number | null; playing: boolean; status: string; primary: boolean; deck?: DeckId };
const decks = new Map<HTMLAudioElement, DeckState>();
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
export function reportPlayback(audio: HTMLAudioElement, state: DeckState) {
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
function playbackKeyOwner(): HTMLAudioElement | null {
  if (activeAudio) return activeAudio;
  const loaded = [...decks.entries()].filter(([, deck]) => deck.trackId !== null);
  return loaded.find(([, deck]) => deck.primary)?.[0] ?? loaded[0]?.[0] ?? null;
}
export function hasPlaybackKeyOwner() { return playbackKeyOwner() !== null; }

export function activateAudio(audio: HTMLAudioElement) {
  activeAudio = audio;
  publishPlayback();
}

export function releaseAudio(audio: HTMLAudioElement) {
  audio.pause();
  if (activeAudio === audio) activeAudio = null;
  decks.delete(audio);
  publishPlayback();
}

export function ownsPlaybackKeys(audio: HTMLAudioElement, primary: boolean) {
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
  const play = (track: Track) => { load("A", track, { play: true }); };
  const eject = (deck: DeckId) => commit(ejectFromSlots(slotsRef.current, deck));
  const clear = () => commit(clearSlots(slotsRef.current));

  return (
    <PlayerCtx.Provider value={{ current: slots.A.track, token: slots.A.token, slots, play, load, eject, deckIsPlaying, clear, ...playback }}>
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
