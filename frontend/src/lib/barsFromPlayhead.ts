// The overview's seek hover: how far the pointer is from the playhead, in bar lines on the deck's own grid.
import { beatPosition, type BeatGrid } from "./beatGrid";
import { sectionKinds, SECTION_LABELS, type StructureSection } from "./trackStructure";

const BAR_EPS = 1e-6; // a time on a bar line (up to float error) counts as on it
const MINUS = "−";

/** The bar a time sits in, counted from bar 1's downbeat; before it and past the grid's last beat the edge tempo continues. */
const barAt = (grid: BeatGrid, t: number) => Math.floor(beatPosition(grid, t) / 4 + BAR_EPS);

/** Bar lines crossed going from `from` to `to` (negative backwards). The pitch fader plays no part: these are the track's bars. */
export function barsBetween(grid: BeatGrid, from: number, to: number): number {
  return barAt(grid, to) - barAt(grid, from) || 0; // never -0
}

const signed = (n: number, text: string) => (n > 0 ? `+${text}` : n < 0 ? `${MINUS}${text}` : text);

/** «+0:26», «−1:04», «0:00»: whole seconds from the playhead to the pointer. */
function timeOffset(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  return signed(Math.round(seconds), `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`);
}

/** The name of the part the time falls in, once the first part has begun; null with no measured sections. */
export function sectionAt(sections: readonly StructureSection[] | null | undefined, t: number): string | null {
  if (!sections?.length || t < sections[0].start_s) return null;
  const kinds = sectionKinds([...sections]);
  let i = 0;
  while (i + 1 < sections.length && sections[i + 1].start_s <= t) i++;
  return SECTION_LABELS[kinds[i]];
}

/**
 * The hover's chip: «+16 bars», «−28 bars», «0 bars»; «≈ +16 bars» on a grid estimated from the tempo and the entry cue
 * alone; the time («+0:26») when the deck has no tempo at all.
 */
export function seekHoverText(grid: BeatGrid | null, playhead: number, pointer: number): string {
  if (!grid) return timeOffset(pointer - playhead);
  const n = barsBetween(grid, playhead, pointer);
  const text = signed(n, `${Math.abs(n)} bars`);
  return grid.estimated && !grid.overridden ? `≈ ${text}` : text;
}
