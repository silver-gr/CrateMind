import { createContext, useContext, useState, type ReactNode } from "react";
import type { Track } from "./types";

interface PlayerState {
  current: Track | null;
  /** monotonic token — bumps on every play() so re-playing the same track works */
  token: number;
  play: (track: Track) => void;
  clear: () => void;
}

const PlayerCtx = createContext<PlayerState | null>(null);

// A single audible deck at a time; pausing preserves each element's playhead.
let activeAudio: HTMLAudioElement | null = null;

export function activateAudio(audio: HTMLAudioElement) {
  if (activeAudio && activeAudio !== audio) activeAudio.pause();
  activeAudio = audio;
}

export function releaseAudio(audio: HTMLAudioElement) {
  audio.pause();
  if (activeAudio === audio) activeAudio = null;
}

export function ownsPlaybackKeys(audio: HTMLAudioElement, primary: boolean) {
  return activeAudio === audio || (activeAudio === null && primary);
}

export function audioUrl(trackId: number): string {
  return `/api/tracks/${trackId}/audio`;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Track | null>(null);
  const [token, setToken] = useState(0);

  const play = (track: Track) => {
    setCurrent(track);
    setToken((t) => t + 1);
  };
  const clear = () => setCurrent(null);

  return (
    <PlayerCtx.Provider value={{ current, token, play, clear }}>
      {children}
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within <PlayerProvider>");
  return ctx;
}
