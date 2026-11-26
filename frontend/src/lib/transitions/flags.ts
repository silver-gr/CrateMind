// Checks that flag, never fix, a transition between two neighbouring tracks of a set (pure). Each check answers only from
// data it trusts (a sure structure, phrase lines on the grid, a certain key); when that is missing it flags nothing.
import { barSeconds, timeAfterBars, type BeatGrid } from "../beatGrid";
import { fallbackKey, isCompatible, toCamelot, uncertainKey, type Camelot, type KeySources } from "../camelot";
import { STRUCTURE_SURE, type StructureSection, type TrackStructure } from "../trackStructure";
import { eqAt, filterAt, volumeAt } from "./curves";
import type { TransitionParams } from "./types";

export type FlagParams = Pick<TransitionParams, "preset" | "bars" | "volume_curve" | "eq_curve" | "filter_curve" | "loop_beats">;
export interface FlagLane { grid: BeatGrid | null; structure: Pick<TrackStructure, "sections" | "quality"> | null | undefined }
/** The window as the editor shows it: source seconds, `bars` counted on the outgoing grid, `rateIn` the incoming rate (null: 1). */
export interface FlagWindow { outStartS: number; inStartS: number; bars: number; rateIn: number | null }
export interface TransitionFlags { bassBars: number | null; offPhrase: boolean; keyBars: number | null }

/** A deck is heard from −6 dB (volume 0.5); an EQ band is gone from −13 dB (knob −0.5); a high-pass past 0.3 (~120 Hz) takes the bass. */
const HEARD = 0.5, BAND_GONE = -0.5, HPF_BASS = 0.3;
/** Two basses heard together for more than this many bars get a flag. */
export const BASS_FLAG_BARS = 4;
/** Clashing keys heard together for more than this many bars get a flag (the 8-bar presets never do on their own). */
export const KEY_FLAG_BARS = 8;
/** Phrase lines closer than this count as together: more than a beat apart is off (positions sit on beats; the half absorbs rounding). */
const PHRASE_TOL_BEATS = 1.5;

const mixes = (p: FlagParams, bars: number) => p.preset !== "none" && bars > 0;
const sure = (s: FlagLane["structure"]): s is Pick<TrackStructure, "sections" | "quality"> => !!s && s.quality >= STRUCTURE_SURE && s.sections.length > 0;

/** Per beat of the window (at its middle): its place `u` in the window and what each deck lets through, by the curves. */
function beatsHeard(p: FlagParams, bars: number) {
  const n = Math.max(1, Math.round(bars)) * 4;
  return Array.from({ length: n }, (_, b) => {
    const u = (b + 0.5) / n;
    const v = volumeAt(p.volume_curve, u), e = eqAt(p.eq_curve, u, 1 / n), f = filterAt(p.filter_curve, u);
    return {
      u,
      outBass: v.out >= HEARD && e.out.lo > BAND_GONE && f.out < HPF_BASS,
      inBass: v.in >= HEARD && e.in.lo > BAND_GONE && f.in < HPF_BASS,
      outMids: v.out >= HEARD && e.out.mid > BAND_GONE,
      inMids: v.in >= HEARD && e.in.mid > BAND_GONE,
    };
  });
}

/** Whether the track has its bass at `t`: the section `t` falls in (none before the first section). */
function bassAt(sections: readonly StructureSection[], t: number): boolean {
  let bass = false;
  for (const s of sections) {
    if (s.start_s > t) break;
    bass = s.bass;
  }
  return bass;
}

/**
 * «Δύο μπάσα μαζί»: the bars of the window in which both tracks are in a bass section and the curves let both basses
 * through (no bass swap or cut covering it); null unless more than BASS_FLAG_BARS, or without both sure structures.
 */
export function bassClashBars(out: FlagLane, inn: FlagLane, p: FlagParams, w: FlagWindow): number | null {
  if (!mixes(p, w.bars) || !out.grid || !sure(out.structure) || !sure(inn.structure)) return null;
  const outSections = out.structure.sections, inSections = inn.structure.sections;
  const span = timeAfterBars(out.grid, w.outStartS, w.bars) - w.outStartS;
  if (!(span > 0)) return null;
  // A loop holds the outgoing deck inside its first beats.
  const loopS = p.loop_beats ? Math.min(span, (p.loop_beats * barSeconds(out.grid, w.outStartS)) / 4) : span;
  const beats = beatsHeard(p, w.bars).filter(b => b.outBass && b.inBass
    && bassAt(outSections, w.outStartS + ((b.u * span) % loopS))
    && bassAt(inSections, w.inStartS + b.u * span * (w.rateIn ?? 1))).length;
  return beats / 4 > BASS_FLAG_BARS ? beats / 4 : null;
}

/**
 * «Εκτός φράσης»: phrase lines of either track fall inside the window and none of them meets a line of the other track
 * within a beat, so the two tracks' 8-bar phrases do not start together. False without both sure structures and phrase
 * lines, with a loop (the outgoing deck stops moving through its phrases), or when no line falls inside the window.
 */
export function offPhrase(out: FlagLane, inn: FlagLane, p: FlagParams, w: FlagWindow): boolean {
  if (!mixes(p, w.bars) || p.loop_beats || !out.grid || !inn.grid || !sure(out.structure) || !sure(inn.structure)) return false;
  const outLines = out.grid.phrases ?? [], inLines = inn.grid.phrases ?? [];
  if (!outLines.length || !inLines.length) return false;
  const tol = (PHRASE_TOL_BEATS * barSeconds(out.grid, w.outStartS)) / 4;
  const endS = timeAfterBars(out.grid, w.outStartS, w.bars);
  const inside = (t: number) => t >= w.outStartS - tol && t <= endS + tol;
  const near = (t: number, lines: readonly number[]) => lines.some(x => Math.abs(x - t) <= tol);
  // The incoming lines on the outgoing track's clock.
  const inOnOut = inLines.map(t => w.outStartS + (t - w.inStartS) / (w.rateIn ?? 1));
  const outInside = outLines.filter(inside), inInside = inOnOut.filter(inside);
  if (!outInside.length && !inInside.length) return false;
  return !outInside.some(t => near(t, inOnOut)) && !inInside.some(t => near(t, outLines));
}

/** A key the check trusts: the tag, else the fallback key unless it is the unsure last resort; a leading `~` marks a guess. */
function sureKey(track: KeySources): Camelot | null {
  const raw = track.key_text?.trim() || (uncertainKey(track) ? null : fallbackKey(track));
  return raw && !raw.startsWith("~") ? toCamelot(raw) : null;
}

/**
 * «Απότομη αλλαγή τονικότητας»: the keys are not compatible on the Camelot wheel (the recommender's key fit) and both
 * tracks' mids are heard together for more than KEY_FLAG_BARS bars of a `bars`-bar window; null otherwise or without
 * two certain keys. Needs no grid, so the set list can show it from the saved parameters.
 */
export function keyClashBars(from: KeySources, to: KeySources, p: FlagParams, bars: number = p.bars): number | null {
  if (!mixes(p, bars)) return null;
  const a = sureKey(from), b = sureKey(to);
  if (!a || !b || isCompatible(a, b)) return null;
  const together = beatsHeard(p, bars).filter(x => x.outMids && x.inMids).length / 4;
  return together > KEY_FLAG_BARS ? together : null;
}

/** All three checks for the window the editor shows. */
export function transitionFlags(out: FlagLane, inn: FlagLane, from: KeySources, to: KeySources, p: FlagParams, w: FlagWindow): TransitionFlags {
  return { bassBars: bassClashBars(out, inn, p, w), offPhrase: offPhrase(out, inn, p, w), keyBars: keyClashBars(from, to, p, w.bars) };
}
