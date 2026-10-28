import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Track } from "./types";
import { getPref } from "./prefs";
import { unlockPlaybackAudio } from "./playbackAudio";

interface PlayerState {
  current: Track | null;
  /** monotonic token — bumps on every play() so re-playing the same track works */
  token: number;
  play: (track: Track) => void;
  clear: () => void;
  playingTrackId: number | null;
  processingStatus: string;
}

const PlayerCtx = createContext<PlayerState | null>(null);

// A single audible deck at a time; pausing preserves each element's playhead.
let activeAudio: HTMLAudioElement | null = null;
type DeckState = { trackId: number | null; playing: boolean; status: string; primary: boolean };
const decks = new Map<HTMLAudioElement, DeckState>();
const playbackListeners = new Set<() => void>();
const idlePlayback = { playingTrackId: null as number | null, processingStatus: "" };
let playbackSnapshot = idlePlayback;
function publishPlayback() {
  const owner = playbackKeyOwner();
  const deck = owner ? decks.get(owner) : [...decks.values()].find(deck => deck.primary);
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
const getPlaybackSnapshot = () => playbackSnapshot;
function playbackKeyOwner(): HTMLAudioElement | null {
  if (activeAudio) return activeAudio;
  const loaded = [...decks.entries()].filter(([, deck]) => deck.trackId !== null);
  return loaded.find(([, deck]) => deck.primary)?.[0] ?? loaded[0]?.[0] ?? null;
}
export function hasPlaybackKeyOwner() { return playbackKeyOwner() !== null; }

export function activateAudio(audio: HTMLAudioElement) {
  if (activeAudio && activeAudio !== audio) activeAudio.pause();
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
  const [current, setCurrent] = useState<Track | null>(null);
  const [token, setToken] = useState(0);

  const play = (track: Track) => {
    if (getPref("autoGain") || getPref("audioLimiter")) void unlockPlaybackAudio().catch(() => {});
    setCurrent(track);
    setToken((t) => t + 1);
  };
  const clear = () => setCurrent(null);

  return (
    <PlayerCtx.Provider value={{ current, token, play, clear, ...playback }}>
      {children}
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within <PlayerProvider>");
  return ctx;
}
