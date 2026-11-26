// The suggested cues a deck's pads show («Προτεινόμενα cues από τη δομή»): nothing is asked for or computed with the switch off.
import { useMemo } from "react";
import type { BeatGrid } from "./beatGrid";
import type { CuePadSlots } from "./cuePads";
import { usePref } from "./prefs";
import { cueSuggestions, ghostPads, type CueSuggestion } from "./trackStructure";
import { useTrackStructure } from "./trackStructureStore";
import type { TrackCue } from "./types";

const NONE: readonly (CueSuggestion | null)[] = [];

/** One entry per pad (or none at all): the suggestion that pad shows. `ready`: the track's cues have loaded. */
export function usePadGhosts(trackId: number | null, grid: BeatGrid | null, duration: number, slots: CuePadSlots, cues: TrackCue[], ready: boolean): readonly (CueSuggestion | null)[] {
  const [on] = usePref("cueSuggestions");
  const structure = useTrackStructure(on ? trackId : null);
  return useMemo(() => (on && ready && structure ? ghostPads(cueSuggestions(structure, grid, duration), slots, cues) : NONE),
    [on, ready, structure, grid, duration, slots, cues]);
}
