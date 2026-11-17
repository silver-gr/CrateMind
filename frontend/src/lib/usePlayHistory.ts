import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import { deckGain, getMixer, isTwoDeck } from "./mixer";
import { deckPlayback, usePlayer } from "./player";
import {
  AUDIBLE_GAIN, PLAY_LOGGED, emptyOpenPlays, isTaggingScreen, markPlayDead, retryPlayCreate, stepPlayHistory,
  type DeckSample, type PlayAction,
} from "./playHistory";

const TICK_MS = 1_000;
const iso = (ms: number) => new Date(ms).toISOString();
const notify = () => window.dispatchEvent(new Event(PLAY_LOGGED));
let warned = false;

/** The play-history recorder: mount once (AppShell). Logs a play once a deck has been heard for 30 s. */
export function usePlayHistory() {
  const { slots } = usePlayer();
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    let open = emptyOpenPlays();
    // One create per play key; every update for that play chains on it, so it always waits for the id.
    const creates = new Map<string, Promise<number | null>>();
    const kill = (key: string, cause: unknown) => {
      open = markPlayDead(open, key);
      if (!warned) { warned = true; console.warn("Play history: a play could not be written", cause); }
    };

    function send(action: PlayAction) {
      if (action.kind === "create") {
        creates.set(action.key, api.historyCreatePlay({
          track_id: action.trackId, deck: action.deck, started_at: iso(action.startedAt), ended_at: iso(action.endedAt), played_seconds: action.playedSeconds,
        }).then(play => { notify(); return play.id; }, cause => {
          // dataset_busy: rejected before anything was written, so the next tick may send it again.
          if ((cause as { code?: string }).code === "dataset_busy") open = retryPlayCreate(open, action.key);
          else kill(action.key, cause);
          return null;
        }));
        return;
      }
      const created = creates.get(action.key);
      if (!created) return;
      if (action.reason === "close") creates.delete(action.key);
      void created.then(id => id == null ? undefined : api.historyUpdatePlay(id, {
        track_id: action.trackId, ended_at: iso(action.endedAt), played_seconds: action.playedSeconds,
      }).then(() => { if (action.reason !== "heartbeat") notify(); }, cause => {
        // A 404: the row was deleted while playing. Other errors (dataset_busy…) wait for the next update.
        if (cause instanceof Error && cause.message.startsWith("404:")) kill(action.key, cause);
      }));
    }

    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      const current = slotsRef.current;
      const mixer = getMixer();
      const twoDeck = isTwoDeck(mixer.midiConnected, current.B.track);
      const samples = (["A", "B"] as const).map((deck): DeckSample => {
        const playback = deckPlayback(deck);
        return {
          deck, trackId: current[deck].track?.id ?? null, token: current[deck].token,
          regTrackId: playback?.trackId ?? null, playing: playback?.playing ?? false, currentTime: playback?.currentTime ?? null,
          audible: !twoDeck || deckGain(deck, mixer) >= AUDIBLE_GAIN,
        };
      });
      const step = stepPlayHistory(open, samples, now, dt, !isTaggingScreen(pathRef.current));
      open = step.open;
      step.actions.forEach(send);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
