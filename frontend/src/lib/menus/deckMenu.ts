import { Disc3, Eject } from "../icons";
import type { DeckId } from "../player";
import type { Track } from "../types";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";
import { MENU_REASONS, trackMenuEntries, type TrackMenuContext } from "./trackMenu";

/** The trigger's pick for a deck area (`ActionContextMenu`): the whole area is the target. */
export const pickDeck = () => true as const;

/**
 * The menu of a deck with a track loaded: eject, the same track on the other deck, then the track menu's
 * «Προσθήκη σε set» · «Κατάσταση» · «BPM» and «Κομμάτια του καλλιτέχνη» · «Εμφάνιση στον φάκελο» · «Αντιγραφή».
 * Play, loads onto either deck, the place's own set, the profile editor, the analysis and Flow Finder stay out.
 */
export function deckMenuEntries(deck: DeckId, track: Track, ctx: TrackMenuContext, eject: () => void): MenuEntry[] {
  const other: DeckId = deck === "A" ? "B" : "A";
  const { load } = ctx;
  const trackItems = trackMenuEntries(track, {
    ...ctx, play: undefined, load: undefined, addToOwnSet: undefined, edit: undefined, analyze: undefined, flowFinder: undefined,
  });
  const reason = (track.missing && MENU_REASONS.missing) || (ctx.mixRunning && MENU_REASONS.mix) || (ctx.deckPlaying[other] && MENU_REASONS.playing) || undefined;
  return tidy([
    { type: "label", label: `Deck ${deck}` },
    { type: "item", icon: Eject, label: "Αφαίρεση από το Deck", onSelect: eject },
    load && { type: "item", icon: Disc3, label: `Φόρτωση και στο Deck ${other}`, disabled: !!reason, reason, onSelect: () => load(other, track) },
    SEPARATOR,
    ...trackItems,
  ]);
}
