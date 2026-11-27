// The facts row under the two waveforms: what each deck's half and the centre cell print. Pure helpers, plus the one
// value the centre cell cannot read from a store: each deck's tempo as its own half shows it.
import { useSyncExternalStore } from "react";
import { snapToBar, timeAtBeat, beatPosition, type BeatGrid } from "./beatGrid";
import { barsBetween } from "./barsFromPlayhead";
import { camelotCode, isCompatible, toCamelot } from "./camelot";
import { isPhraseDownbeat } from "./deckScroll";
import { sectionNames, type StructureSection } from "./trackStructure";
import type { DeckId } from "./player";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;

/** «-4:12»: the time left on the deck; «-0:00» before the duration is known. */
export function timeLeftText(duration: number, time: number): string {
  if (!isFinite(duration) || duration <= 0) return "-0:00";
  return `-${clock(Math.max(0, Math.round(duration - time)))}`;
}

/** The last stretch of a track, where the time left turns rose. */
export const lastSeconds = (duration: number, time: number) => Number.isFinite(duration) && duration > 0 && duration - time <= 30;

/** «16 bars → Break»: how many bar lines are left until the next part, and what that part is. */
export type NextPart = { bars: number; to: string };

/** A phrase line this far ahead is not worth counting down to. */
const PHRASE_SEARCH_BARS = 128;

/**
 * Bars from the playhead to the next part of the track: the next measured section («Break», «Build-up», «Drop», «Κύριο μέρος»…), in the last
 * section the end of the track («Τέλος»), and with no measured sections the next phrase line («Φράση»). Null with no grid or
 * on a grid estimated from the tempo and the entry cue alone, where bar 1 is a guess. The count follows the deck's own grid,
 * so the pitch fader does not change it; a section start a few ms off a bar line counts as on it.
 */
export function nextPart(grid: BeatGrid | null, sections: readonly StructureSection[] | null | undefined, time: number, duration: number): NextPart | null {
  if (!grid || (grid.estimated && !grid.overridden) || !Number.isFinite(time)) return null;
  const barsTo = (target: number) => Math.max(0, barsBetween(grid, time, snapToBar(grid, target, "nearest")));
  if (sections?.length) {
    const next = sections.findIndex((s, i) => i > 0 && s.start_s > time);
    if (next > 0) return { bars: barsTo(sections[next].start_s), to: sectionNames(sections)[next] };
    return Number.isFinite(duration) && duration > 0 ? { bars: barsTo(duration), to: "Τέλος" } : null;
  }
  const from = Math.floor(beatPosition(grid, time) / 4 + 1e-6) + 1;
  for (let bar = from; bar < from + PHRASE_SEARCH_BARS; bar++) {
    const at = timeAtBeat(grid, 4 * bar);
    if (Number.isFinite(duration) && duration > 0 && at >= duration) break;
    if (isPhraseDownbeat(grid.phrases, at, bar >= 0 ? bar + 1 : null)) return { bars: bar - from + 1, to: "Φράση" };
  }
  return null;
}

/** The count is urgent from here down. */
export const NEXT_PART_SOON_BARS = 8;

/** «LOOP 4», «LOOP 1/2»: the length the next loop gets, in beats. */
export const loopText = (beats: number) => `LOOP ${beats >= 1 ? beats : `1/${Math.round(1 / beats)}`}`;

/** Whether two keys mix, with both as Camelot codes; null when a deck has no key the wheel knows. */
export function keyRelation(a: string | null | undefined, b: string | null | undefined): { fit: boolean; a: string; b: string } | null {
  const ca = toCamelot(a?.replace(/^~/, "")), cb = toCamelot(b?.replace(/^~/, ""));
  return ca && cb ? { fit: isCompatible(ca, cb), a: camelotCode(ca), b: camelotCode(cb) } : null;
}

/** «Δ 1.1 BPM»: how far apart the two decks' tempos are; null while a deck has none. */
export function tempoGapText(a: number | null, b: number | null): string | null {
  return a == null || b == null ? null : `Δ ${Math.abs(a - b).toFixed(1)} BPM`;
}

// Each deck's tempo as its half of the row prints it (the track's BPM at the fader's rate), for the centre cell's «Δ».
let tempos: Record<DeckId, number | null> = { A: null, B: null };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function publishDeckTempo(deck: DeckId, tempo: number | null) {
  if (tempos[deck] === tempo) return;
  tempos = { ...tempos, [deck]: tempo };
  listeners.forEach(fn => fn());
}
export const getDeckTempos = () => tempos;
export const useDeckTempos = () => useSyncExternalStore(subscribe, getDeckTempos, getDeckTempos);
