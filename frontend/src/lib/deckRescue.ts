// Deck rescue: what is saved about the decks every two seconds, and how a saved snapshot is brought back after a
// crash, a force-quit or a page reload. The hook around it is lib/useDeckRescue.ts.
import { relativeTime } from "./deckHistory";
import {
  setCrossfader, setDeckEq, setDeckFilter, setDeckKeylock, setDeckRangePitch, setDeckTrim, setMasterGain, setMixerVolume,
  type MixerState,
} from "./mixer";
import type { DeckId, DeckSlots } from "./player";
import type { DeckRescueBody, DeckRescueDeck, Track } from "./types";

const DECKS = ["A", "B"] as const;

/** The part of a deck's transport (lib/mix/deckTransport.ts) a snapshot reads. */
export interface RescueTransport {
  trackId: number | null;
  ready: boolean;
  onEngine: boolean;
  position(): number;
  engine: { loop: { start: number; end: number } | null } | null;
}

/** The decks and mixer as they are now; null when no deck holds a track. A deck whose source is not loaded yet is at 0. */
export function buildSnapshot(
  slots: DeckSlots, mixer: MixerState, transports: Record<DeckId, RescueTransport | null>,
): DeckRescueBody | null {
  const deck = (id: DeckId): DeckRescueDeck | null => {
    const track = slots[id].track;
    if (!track) return null;
    const t = transports[id];
    const live = t != null && t.ready && t.trackId === track.id ? t : null;
    const loop = live?.onEngine ? live.engine?.loop ?? null : null;
    const fx = mixer.fx[id];
    return {
      track_id: track.id,
      position_s: live ? Math.round(Math.max(0, live.position()) * 1000) / 1000 : 0,
      pitch: fx.pitch, range: fx.range, keylock: fx.keylock,
      eq: { hi: fx.eq.hi, mid: fx.eq.mid, lo: fx.eq.lo }, filter: fx.filter, trim: fx.trim,
      loop: loop ? { start_s: loop.start, end_s: loop.end } : null,
    };
  };
  const decks = { A: deck("A"), B: deck("B") };
  if (!decks.A && !decks.B) return null;
  return { v: 1, decks, mixer: { volume: { A: mixer.volume.A, B: mixer.volume.B }, crossfader: mixer.crossfader, master: mixer.master } };
}

/** The writer between two ticks: `sent` is the last snapshot the server holds from this page (its JSON), `owns` says
 *  this page wrote or restored the file, so emptying both decks may delete it. */
export type RescueWriter = { sent: string | null; owns: boolean; busy: boolean; restoring: boolean };
export const newRescueWriter = (): RescueWriter => ({ sent: null, owns: false, busy: false, restoring: false });

/** What one tick does with the current snapshot's JSON (null: both decks are empty). */
export function writeDecision(writer: RescueWriter, json: string | null): "write" | "clear" | "none" {
  if (writer.busy || writer.restoring) return "none";
  if (json === null) return writer.owns ? "clear" : "none";
  return json === writer.sent ? "none" : "write";
}

export type RestoreDeck = { deck: DeckId; track: Track; saved: DeckRescueDeck };

/** The saved decks whose track is still in the library with its file in place; none left means the snapshot is useless. */
export function restorableDecks(snapshot: DeckRescueBody, found: ReadonlyMap<number, Track>): RestoreDeck[] {
  return DECKS.flatMap(deck => {
    const saved = snapshot.decks[deck];
    const track = saved ? found.get(saved.track_id) : undefined;
    return saved && track && !track.missing ? [{ deck, track, saved }] : [];
  });
}

/** Puts the saved mixer back for the decks that return. Tempo goes through the soft takeover; with a controller
 *  connected its own faders and knobs are the truth, so only tempo, range and key lock are set. */
export function applyMixer(snapshot: DeckRescueBody, decks: RestoreDeck[], midiConnected: boolean): void {
  for (const { deck, saved } of decks) {
    setDeckRangePitch(deck, saved.range, saved.pitch);
    setDeckKeylock(deck, saved.keylock);
    if (midiConnected) continue;
    setMixerVolume(deck, snapshot.mixer.volume[deck]);
    for (const band of ["hi", "mid", "lo"] as const) setDeckEq(deck, band, saved.eq[band]);
    setDeckFilter(deck, saved.filter);
    setDeckTrim(deck, saved.trim);
  }
  if (midiConnected) return;
  setCrossfader(snapshot.mixer.crossfader);
  setMasterGain(snapshot.mixer.master);
}

export const RESCUE_PROMPT = "Επαναφορά των decks από την προηγούμενη συνεδρία;";

/** «A: Καλλιτέχνης – Τίτλος · B: Τίτλος · πριν 12 λ.» */
export function rescuePromptText(decks: RestoreDeck[], ageS: number): string {
  const names = decks.map(({ deck, track }) => `${deck}: ${track.artist ? `${track.artist} – ` : ""}${track.title || track.file_name}`);
  return [...names, relativeTime(0, ageS * 1000)].join(" · ");
}
