import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { collectDeckTracks } from "./deckHistory";
import {
  RESCUE_PROMPT, applyMixer, buildSnapshot, newRescueWriter, rescuePromptText, restorableDecks, writeDecision,
  type RestoreDeck,
} from "./deckRescue";
import type { MediaLike } from "./media";
import { deckTransportOf } from "./mix/deckTransport";
import { getMixer } from "./mixer";
import { unlockPlaybackAudio } from "./playbackAudio";
import { usePlayer } from "./player";
import { isDeckPlayable } from "./transitions/mixable";
import type { DeckRescueSnapshot } from "./types";

const TICK_MS = 2_000;
const POLL_MS = 200;
const POLL_MAX_MS = 60_000;

type Offer = { snapshot: DeckRescueSnapshot; decks: RestoreDeck[]; ageS: number };

/** The saved decks that can still come back, or null. A snapshot whose tracks are all gone is deleted; when a track
 *  could not be checked (backend busy) the file is left for the next start. */
async function findOffer(): Promise<Offer | null> {
  const { snapshot, age_s } = await api.deckRescueGet();
  if (!snapshot) return null;
  const ids = [snapshot.decks.A, snapshot.decks.B].flatMap(d => d ? [d.track_id] : []);
  const { found, failed } = collectDeckTracks(await Promise.allSettled(ids.map(id => api.getTrack(id))));
  if (failed) return null;
  const decks = restorableDecks(snapshot, found);
  if (!decks.length) { await api.deckRescueClear(); return null; }
  return { snapshot, decks, ageS: age_s ?? 0 };
}

// One check and one prompt per page. StrictMode mounts the effect twice in dev: both mounts share this promise, so
// the first mount's cleanup cannot swallow the prompt.
let offered: Promise<Offer | null> | null = null;
let prompted = false;
let warned = false;

/** Deck rescue: mount once (AppShell). Saves the decks every 2 s and, on a start that finds a snapshot, offers to
 *  bring them back paused at their saved positions. */
export function useDeckRescue() {
  const { slots, load } = usePlayer();
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const loadRef = useRef(load);
  loadRef.current = load;
  const writer = useRef(newRescueWriter());
  const promptRef = useRef<string | number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const w = writer.current;
      const body = buildSnapshot(slotsRef.current, getMixer(), { A: deckTransportOf("A"), B: deckTransportOf("B") });
      const json = body && JSON.stringify(body);
      const decision = writeDecision(w, json);
      if (decision === "none") return;
      w.busy = true;
      (body && decision === "write" ? api.deckRescueSave(body) : api.deckRescueClear()).then(() => {
        w.sent = decision === "write" ? json : null;
        w.owns = decision === "write";
      }, cause => {
        // The next tick tries again (dataset_busy, backend restarting); playback is never interrupted for this.
        if (!warned) { warned = true; console.warn("Deck rescue: the decks could not be saved", cause); }
      }).finally(() => { w.busy = false; });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Seeks one restored deck and sets its loop as soon as its source is loaded, then calls `done` once.
    function settle({ deck, track, saved }: RestoreDeck, done: () => void) {
      const started = Date.now();
      let heard: MediaLike | null = null;
      let over = false;
      const apply = () => {
        const t = deckTransportOf(deck);
        if (!t?.ready || t.trackId !== track.id) return false;
        t.seekTo(saved.position_s);
        // After the seek: a seek outside a loop ends it.
        if (saved.loop && t.onEngine) t.engine?.setLoop(saved.loop.start_s, saved.loop.end_s);
        return true;
      };
      const finish = () => {
        if (over) return;
        over = true;
        window.clearInterval(timer);
        heard?.removeEventListener("loadedmetadata", onLoaded);
        done();
      };
      // The engine fires this before it starts a play pressed during the decode, so the deck never starts at 0:00.
      const onLoaded = () => { if (apply()) finish(); };
      const tick = () => {
        const t = deckTransportOf(deck);
        if (slotsRef.current[deck].track?.id !== track.id || t?.media?.error || Date.now() - started > POLL_MAX_MS || apply()) { finish(); return; }
        // The media changes when the engine falls back to the element.
        if (t?.media && t.media !== heard) {
          heard?.removeEventListener("loadedmetadata", onLoaded);
          heard = t.media;
          heard.addEventListener("loadedmetadata", onLoaded);
        }
      };
      const timer = window.setInterval(tick, POLL_MS);
      window.setTimeout(tick, 0);
    }

    function restore({ snapshot, decks }: Offer) {
      promptRef.current = null;
      const w = writer.current;
      w.restoring = true; // the saved positions must survive a second crash during the loads
      w.owns = true;
      // A paused load does not unlock the audio (player.load): this click is the gesture that can.
      void unlockPlaybackAudio().catch(() => {});
      // Read now, not when the prompt was built: the controller reports itself up to 2 s after the page loads.
      applyMixer(snapshot, decks, getMixer().midiConnected);
      for (const d of decks) loadRef.current(d.deck, d.track, { play: false });
      let open = decks.length;
      const done = () => { if (--open === 0) w.restoring = false; };
      // A track the decks refuse (AIFF) never loads a source: nothing to wait for.
      for (const d of decks) { if (isDeckPlayable(d.track)) settle(d, done); else done(); }
    }

    let cancelled = false;
    offered ??= findOffer().catch(() => null);
    void offered.then(offer => {
      if (cancelled || !offer || prompted) return;
      prompted = true;
      if (slotsRef.current.A.track || slotsRef.current.B.track) return; // a deck was loaded meanwhile: its state wins
      promptRef.current = toast(RESCUE_PROMPT, {
        duration: Infinity,
        // Two track names and two buttons: wider than a normal toast, still centred on the toaster (not on phone widths).
        className: "min-[601px]:w-[min(880px,calc(100vw-2rem))] min-[601px]:ml-[calc((var(--width)-min(880px,100vw-2rem))/2)]",
        description: rescuePromptText(offer.decks, offer.ageS),
        action: { label: "Επαναφορά", onClick: () => restore(offer) },
        cancel: { label: "Όχι", onClick: () => { promptRef.current = null; void api.deckRescueClear().catch(() => {}); } },
      });
    });
    return () => { cancelled = true; };
  }, []);

  // Loading a track any other way answers the prompt: the new state overwrites the file.
  const loaded = slots.A.track != null || slots.B.track != null;
  useEffect(() => {
    if (!loaded || promptRef.current == null) return;
    toast.dismiss(promptRef.current);
    promptRef.current = null;
  }, [loaded]);
}
