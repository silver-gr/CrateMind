import { useMemo, useState } from "react";
import { api } from "../api";
import { usePlayer, type DeckId } from "../player";
import type { Track } from "../types";
import { mapMenu, type MenuSource } from "./entries";
import { detailTrack, useTrackMenu, type TrackMenuSubject } from "./useTrackMenu";

/**
 * The right-click menu of one deck (`deckMenuEntries`), for every area that shows its loaded track; none on an empty deck.
 * A status chosen here is read back, since the loaded track is not reloaded for a profile change.
 */
export function useDeckMenu(deck: DeckId, track: Track | null): { menu: MenuSource<true> | undefined; dialogs: React.ReactNode } {
  const { eject } = usePlayer();
  const [fresh, setFresh] = useState<{ of: Track; status: Track["personal_status"] } | null>(null);
  const { menu, dialogs } = useTrackMenu({
    onChanged: ids => {
      const of = track;
      if (!of || !ids.includes(of.id)) return;
      api.getTrack(of.id).then(d => setFresh({ of, status: detailTrack(d).personal_status }), () => {});
    },
  });
  const deckMenu = useMemo(() => {
    if (!track) return undefined;
    const shown = fresh?.of === track ? { ...track, personal_status: fresh.status } : track;
    return mapMenu<true, TrackMenuSubject>(menu, () => ({ kind: "deck", deck, track: shown, eject: () => eject(deck) }));
  }, [menu, deck, track, fresh, eject]);
  return { menu: deckMenu, dialogs };
}
