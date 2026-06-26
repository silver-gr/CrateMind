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
