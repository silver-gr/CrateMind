import type { DeckId } from "./player";
import type { PlayHistoryEntry } from "./types";

/** Heard time before a play is logged. */
export const PLAY_THRESHOLD_MS = 30_000;
/** A logged play's end is re-sent every this much more heard time. */
export const HEARTBEAT_MS = 30_000;
/** A tick never adds more than this (a sleep/wake gap or a throttled timer). */
export const MAX_TICK_MS = 5_000;
/** Deck gain below this (−40 dB) is silent; the fader taper is squared, so a resting fader is near-silent but > 0. */
export const AUDIBLE_GAIN = 0.01;
/** Fired after a play is logged or its end is written; the history page refreshes on it. */
export const PLAY_LOGGED = "cratemind:play-logged";

/** One deck at one tick: the slot's track/token and the registry's view of the media element. */
export type DeckSample = {
  deck: DeckId;
  trackId: number | null;
  token: number;
  regTrackId: number | null;
  playing: boolean;
  currentTime: number | null;
  audible: boolean;
};

export type OpenPlay = {
  trackId: number;
  token: number;
  heardMs: number;
  startedAt: number | null;
  lastHeardAt: number | null;
  /** Whether the previous tick was heard: the first heard tick is only a baseline. */
  prevHeard: boolean;
  lastCurrentTime: number | null;
  logged: boolean;
  /** A failed create or a 404 update: never written again, never re-created for this token. */
  dead: boolean;
  sentHeardMs: number;
  sentLastHeardAt: number | null;
};

export type OpenPlays = Record<DeckId, OpenPlay | null>;

export type PlayAction =
  | { kind: "create"; key: string; deck: DeckId; trackId: number; startedAt: number; endedAt: number; playedSeconds: number }
  | { kind: "update"; key: string; reason: "heartbeat" | "edge" | "close"; trackId: number; endedAt: number; playedSeconds: number };

export const emptyOpenPlays = (): OpenPlays => ({ A: null, B: null });
export const playKey = (deck: DeckId, token: number) => `${deck}:${token}`;

function update(deck: DeckId, play: OpenPlay, reason: "heartbeat" | "edge" | "close", now: number): PlayAction {
  return { kind: "update", key: playKey(deck, play.token), reason, trackId: play.trackId,
    endedAt: play.lastHeardAt ?? now, playedSeconds: play.heardMs / 1000 };
}

/**
 * One recorder tick, pure and synchronous. A tick is heard when the deck plays its slot's track, audibly, off `/tag`;
 * heard time grows by min(dt, 5 s) only when this and the previous tick were heard and the media time moved.
 */
export function stepPlayHistory(open: OpenPlays, samples: DeckSample[], now: number, dtMs: number, counting: boolean): { open: OpenPlays; actions: PlayAction[] } {
  const next: OpenPlays = { ...open };
  const actions: PlayAction[] = [];
  for (const sample of samples) {
    const { deck } = sample;
    let play = next[deck];
    if (play && (play.trackId !== sample.trackId || play.token !== sample.token)) {
      if (play.logged && !play.dead) actions.push(update(deck, play, "close", now));
      play = null;
    }
    if (!play && sample.trackId !== null) {
      play = { trackId: sample.trackId, token: sample.token, heardMs: 0, startedAt: null, lastHeardAt: null, prevHeard: false,
        lastCurrentTime: null, logged: false, dead: false, sentHeardMs: 0, sentLastHeardAt: null };
    }
    if (!play || play.dead) { next[deck] = play; continue; }

    const heard = sample.playing && sample.regTrackId === sample.trackId && sample.audible && counting;
    const moved = sample.currentTime !== null && sample.currentTime !== play.lastCurrentTime;
    const delta = heard && play.prevHeard && moved ? Math.min(Math.max(dtMs, 0), MAX_TICK_MS) : 0;
    const wasHeard = play.prevHeard;
    play = { ...play, prevHeard: heard, lastCurrentTime: sample.currentTime };
    if (delta > 0) play = { ...play, heardMs: play.heardMs + delta, startedAt: play.startedAt ?? now - delta, lastHeardAt: now };

    if (!play.logged && play.heardMs >= PLAY_THRESHOLD_MS) {
      actions.push({ kind: "create", key: playKey(deck, play.token), deck, trackId: play.trackId,
        startedAt: play.startedAt ?? now, endedAt: play.lastHeardAt ?? now, playedSeconds: play.heardMs / 1000 });
      play = { ...play, logged: true, sentHeardMs: play.heardMs, sentLastHeardAt: play.lastHeardAt };
    } else if (play.logged) {
      const heartbeat = play.heardMs - play.sentHeardMs >= HEARTBEAT_MS;
      const edge = !heard && wasHeard && play.lastHeardAt !== play.sentLastHeardAt;
      if (heartbeat || edge) {
        actions.push(update(deck, play, heartbeat ? "heartbeat" : "edge", now));
        play = { ...play, sentHeardMs: play.heardMs, sentLastHeardAt: play.lastHeardAt };
      }
    }
    next[deck] = play;
  }
  return { open: next, actions };
}

/** Marks the open play with `key` dead (its create failed or its row is gone); a closed one is left alone. */
export function markPlayDead(open: OpenPlays, key: string): OpenPlays {
  const next: OpenPlays = { ...open };
  for (const deck of ["A", "B"] as const) {
    const play = next[deck];
    if (play && playKey(deck, play.token) === key) next[deck] = { ...play, dead: true };
  }
  return next;
}

/** Unmarks the open play with `key` as logged, so the next tick sends its create again (the server wrote nothing). */
export function retryPlayCreate(open: OpenPlays, key: string): OpenPlays {
  const next: OpenPlays = { ...open };
  for (const deck of ["A", "B"] as const) {
    const play = next[deck];
    if (play && playKey(deck, play.token) === key) next[deck] = { ...play, logged: false };
  }
  return next;
}

/** The tagging screen (`/tag`, `/tag/…`; not `/tag-cloud`), where nothing counts. */
export const isTaggingScreen = (pathname: string) => pathname === "/tag" || pathname.startsWith("/tag/");

export const playStartMs = (play: PlayHistoryEntry) => Date.parse(play.played_at);
export function playEndMs(play: PlayHistoryEntry): number {
  if (play.ended_at) return Date.parse(play.ended_at);
  return playStartMs(play) + (play.played_seconds ?? 0) * 1000;
}

export type PlaySession = { key: number; plays: PlayHistoryEntry[]; startMs: number; endMs: number };

/**
 * Groups plays into sessions: ascending by (start, id), a new session when a play starts more than `gapMs` after the
 * running maximum end (decks overlap). Plays stay chronological inside a session; sessions come newest first.
 */
export function groupSessions(plays: PlayHistoryEntry[], gapMs = 30 * 60_000): PlaySession[] {
  const sorted = [...plays].sort((a, b) => playStartMs(a) - playStartMs(b) || a.id - b.id);
  const sessions: PlaySession[] = [];
  let current: PlaySession | null = null;
  for (const play of sorted) {
    const start = playStartMs(play);
    if (!current || start > current.endMs + gapMs) {
      current = { key: play.id, plays: [], startMs: start, endMs: start };
      sessions.push(current);
    }
    current.plays.push(play);
    current.endMs = Math.max(current.endMs, playEndMs(play));
  }
  return sessions.reverse();
}

/** «Deck A», or «Set» / «Χειροκίνητα» for rows logged without a deck. */
export function playSourceLabel(play: Pick<PlayHistoryEntry, "deck" | "set_id">): string {
  if (play.deck) return `Deck ${play.deck}`;
  return play.set_id != null ? "Set" : "Χειροκίνητα";
}

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** «Σήμερα», «Χθες», else a Greek date. */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return "Σήμερα";
  if (days === 1) return "Χθες";
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
