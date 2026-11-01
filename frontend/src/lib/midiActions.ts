// The single app-level handler for controller browse/Load actions (mounted once in AppShell).
// The bridge (lib/midi.ts) only dispatches these while no dialog/menu is open; the focused
// list and its cursor live in lib/browseTarget.ts.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { browseAddToSet, cycleFocus, getBrowseSelected, moveBrowse } from "./browseTarget";
import type { MidiAction } from "./midi";
import { usePlayer, type DeckId, type LoadOptions } from "./player";
import type { Track } from "./types";

export type MidiActionPlayer = {
  playRouted: (track: Track) => void;
  load: (deck: DeckId, track: Track, opts?: LoadOptions) => boolean;
  eject: (deck: DeckId) => void;
  deckIsPlaying: (deck: DeckId) => boolean;
};

export function performMidiAction(action: MidiAction, player: MidiActionPlayer, notify: (message: string) => void = m => { toast(m); }) {
  switch (action.type) {
    case "browse": moveBrowse(action.delta); return;
    case "cycle-focus": cycleFocus(); return;
    case "eject":
      if (player.deckIsPlaying(action.deck)) notify(`Το Deck ${action.deck} παίζει — δεν έγινε εξαγωγή`);
      else player.eject(action.deck);
      return;
  }
  const track = getBrowseSelected();
  if (!track) return;
  if (action.type === "play") player.playRouted(track);
  else if (action.type === "load-deck") {
    if (!player.load(action.deck, track, { play: false, ifIdle: true })) notify(`Το Deck ${action.deck} παίζει — δεν φορτώθηκε`);
  } else if (!browseAddToSet()) notify("Εδώ δεν γίνεται προσθήκη στο set");
}

export function useMidiActions() {
  const { playRouted, load, eject, deckIsPlaying } = usePlayer();
  const playerRef = useRef<MidiActionPlayer>({ playRouted, load, eject, deckIsPlaying });
  playerRef.current = { playRouted, load, eject, deckIsPlaying };
  useEffect(() => {
    const onAction = (e: Event) => performMidiAction((e as CustomEvent<MidiAction>).detail, playerRef.current);
    window.addEventListener("cratemind:midi-action", onAction);
    return () => window.removeEventListener("cratemind:midi-action", onAction);
  }, []);
}
