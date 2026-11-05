// How automated transitions (lib/mix) read and drive a deck. MiniPlayer registers one getter per deck over its refs;
// while a transition owns a deck (`setTransportOwner`), the deck's own keyboard and controller transport stand aside.
import type { StretchDeck } from "../audio/stretchDeck";
import type { BeatGrid } from "../beatGrid";
import type { MediaLike } from "../media";
import type { DeckId } from "../player";
import type { Track, TrackCue } from "../types";

export interface DeckTransport {
  trackId: number | null;
  engine: StretchDeck | null;
  media: MediaLike | null;
  /** The active source is the stretch engine (false after an element fallback, even when an engine exists). */
  onEngine: boolean;
  /** The current track's source is loaded: decoded on the engine, metadata on the element. */
  ready: boolean;
  playing: boolean;
  /** Engine playback rate; an element deck is pinned at 1. */
  rate: number;
  position(): number;
  duration: number;
  grid: BeatGrid | null;
  cues: TrackCue[];
  bpm: number | null;
  /** MiniPlayer's cueOps.play: prepare() + play. */
  play(): void;
  pause(): void;
  seekTo(s: number): void;
}

export interface TransportRefs {
  engine: () => StretchDeck | null;
  media: () => MediaLike | null;
  loadedTrackId: () => number | null;
  loadedSourceUrl: () => string | null;
  current: () => Track | null;
  grid: () => BeatGrid | null;
  cues: () => TrackCue[];
  bpm: () => number | null;
  play: () => void;
  seek: (s: number) => void;
}

/** Pure adapter over a deck's refs; `ready` mirrors MiniPlayer's hasCurrentSource, plus decoded on the engine. */
export function createDeckTransportGetter(refs: TransportRefs): () => DeckTransport {
  return () => {
    const engine = refs.engine();
    const media = refs.media();
    const current = refs.current();
    const url = refs.loadedSourceUrl();
    const onEngine = media != null && media === engine;
    const ready = media != null && current != null && refs.loadedTrackId() === current.id
      && url != null && media.src === url && media.currentSrc === url
      && media.readyState >= (onEngine ? 4 : 1) && !media.error;
    return {
      trackId: current?.id ?? null,
      engine,
      media,
      onEngine,
      ready,
      playing: media != null && !media.paused,
      rate: onEngine ? media.playbackRate : 1,
      position: () => refs.media()?.currentTime ?? 0,
      duration: media && Number.isFinite(media.duration) ? media.duration : 0,
      grid: refs.grid(),
      cues: refs.cues(),
      bpm: refs.bpm(),
      play: () => refs.play(),
      pause: () => refs.media()?.pause(),
      seekTo: s => refs.seek(s),
    };
  };
}

const getters: Partial<Record<DeckId, () => DeckTransport>> = {};
export function registerDeckTransport(deck: DeckId, getter: () => DeckTransport): () => void {
  getters[deck] = getter;
  return () => { if (getters[deck] === getter) delete getters[deck]; };
}
export const deckTransportOf = (deck: DeckId): DeckTransport | null => getters[deck]?.() ?? null;

const owners: Record<DeckId, string | null> = { A: null, B: null };
export function setTransportOwner(deck: DeckId, owner: string | null): void { owners[deck] = owner; }
export const transportOwnerOf = (deck: DeckId): string | null => owners[deck];
