// Deck FX rack clock maths (pure): the beat B where the audio reaches the deck's insert, posted to the node as knots.
import { positionAt, type Anchor, type EngineLoop } from "./audio/stretchDeck";
import { beatPosition, timeAtBeat, type BeatGrid } from "./beatGrid";
import { isPhraseDownbeat } from "./deckScroll";
import type { FxClockMsg } from "./fxRack/types";

/** Beats the knots run ahead; on a list grid the host posts new ones when LIST_LOW or fewer are left. */
const AHEAD = 8;
export const LIST_LOW = 4;
/** Φ on an untrusted clock: 16 beats after the engage frame (B = 0 there). */
export const PHI_UNTRUSTED = 16;

/** Stored, or an estimate the user gave a downbeat: B then counts from the bar-1 downbeat. */
export const gridTrusted = (grid: BeatGrid | null) => grid != null && (!grid.estimated || grid.overridden);

/** What W grows by at each wrap of `loop`: its length in beats, rounded to whole beats from 1 b up (exact below). */
export function loopStep(grid: BeatGrid, loop: EngineLoop): number {
  const beats = beatPosition(grid, loop.end) - beatPosition(grid, loop.start);
  return beats >= 1 ? Math.round(beats) : beats;
}

/** How often `anchor` has wrapped inside `loop` by engine time `t`. */
export function wrapsAt(anchor: Anchor, loop: EngineLoop | null, t: number): number {
  if (!loop || !anchor.active || !(loop.end > loop.start)) return 0;
  const raw = anchor.input + Math.max(0, t - anchor.output) * anchor.rate;
  return raw >= loop.end ? Math.floor((raw - loop.start) / (loop.end - loop.start)) : 0;
}

/** An engine deck as the clock reads it; times are ctx seconds. */
export interface EngineView {
  anchor: Anchor;
  loop: EngineLoop | null;
  duration: number;
  grid: BeatGrid;
  /** Seconds from the engine's output to the insert (`playbackLatency`). */
  comp: number;
  /** W from earlier anchors, their wraps already counted. */
  wrapBase: number;
  now: number;
  sampleRate: number;
}

/** W at ctx time `t`: the earlier anchors' wraps plus this one's, each a loop step. */
export const wrapAt = (v: EngineView, t: number) =>
  v.wrapBase + (v.loop ? wrapsAt(v.anchor, v.loop, t - v.comp) * loopStep(v.grid, v.loop) : 0);
/** Track position of the audio reaching the insert at ctx time `t` (wrapped inside a loop). */
export const positionIn = (v: EngineView, t: number) => positionAt(v.anchor, t - v.comp, v.duration, v.loop);
/** B at the insert at ctx time `t`. */
export const beatAt = (v: EngineView, t: number) => beatPosition(v.grid, positionIn(v, t)) + wrapAt(v, t);

/**
 * The clock for an engine deck with a grid. Knots start where the anchor (or now) reaches the insert and run 8 beats
 * ahead: one more knot on a straight grid (the slope extrapolates), one per beat on a list grid; inside a loop they end
 * at the next wrap. Each knot's B is taken at its rounded frame, so the slope is exact. `horizon` is the last knot's B
 * when the host must post more before it runs out (a list grid playing outside a loop), else null.
 */
export function engineClock(v: EngineView, bpm: number | null, seek: boolean): { msg: FxClockMsg; horizon: number | null } {
  const { anchor, grid, sampleRate: fs } = v;
  const start = Math.max(anchor.output + v.comp, v.now);
  const wrap = wrapAt(v, start);
  const p = positionIn(v, start);
  // B at frame f, along this anchor without wrapping (knots stop at the wrap).
  const at = (f: number) => beatPosition(grid, p + (f / fs - start) * (anchor.active ? anchor.rate : 0)) + wrap;
  const f0 = Math.round(start * fs);
  const knots = [f0, at(f0)];
  let horizon: number | null = null;
  if (anchor.active) {
    const b = beatPosition(grid, p);
    const end = v.loop ? v.loop.end : Infinity;
    const targets = grid.kind === "list" ? Array.from({ length: AHEAD }, (_, i) => Math.floor(b) + 1 + i) : [Math.floor(b) + AHEAD];
    let wrapped = false;
    for (const k of targets) {
      let position = timeAtBeat(grid, k);
      if (position >= end) { position = end; wrapped = true; }
      const f = Math.round((start + (position - p) / anchor.rate) * fs);
      if (f > knots[knots.length - 2]) knots.push(f, at(f));
      if (wrapped) break;
    }
    if (grid.kind === "list" && !wrapped) horizon = knots[knots.length - 1];
  }
  // Paused (flat), or a wrap within a frame: a second knot one second on gives the slope.
  if (knots.length < 4) knots.push(f0 + fs, at(f0 + fs));
  return {
    msg: { t: "clock", validFrom: Math.round((anchor.output + v.comp) * fs), playing: anchor.active, knots, bpm, rate: anchor.rate, trusted: gridTrusted(grid), seek },
    horizon,
  };
}

/** The clock of an element deck (rate 1) or a deck without a grid: no knots, so the node counts B from engage at `bpm`. */
export function plainClock(now: number, sampleRate: number, playing: boolean, bpm: number | null, rate: number, seek: boolean): FxClockMsg {
  return { t: "clock", validFrom: Math.round(now * sampleRate), playing, knots: null, bpm, rate, trusted: false, seek };
}

/** Where a deck's beat stands now, for release targets: `grid` and `position` count only when `trusted`. */
export interface DeckBeat {
  grid: BeatGrid | null;
  trusted: boolean;
  /** Track position at the insert now. */
  position: number;
  /** W now. */
  wrap: number;
  playing: boolean;
  looping: boolean;
}

/** The B of the next phrase line after `d.position` by the waveform's rule, or of the next bar when no measured line is ahead. */
export function phraseBeat(d: DeckBeat & { grid: BeatGrid }): number {
  const { grid } = d;
  const b = beatPosition(grid, d.position);
  const next = 4 * Math.floor(b / 4 + 1e-9) + 4;
  const last = grid.phrases?.[grid.phrases.length - 1];
  if (last === undefined) {
    // Without measured lines the waveform marks every PHRASE_BARS bars from bar 1.
    for (let n = next; ; n += 4) if (isPhraseDownbeat(undefined, 0, n >= 0 ? n / 4 + 1 : null)) return n + d.wrap;
  }
  for (let n = next; timeAtBeat(grid, n) <= last + 1; n += 4) {
    if (isPhraseDownbeat(grid.phrases, timeAtBeat(grid, n), n >= 0 ? n / 4 + 1 : null)) return n + d.wrap;
  }
  return next + d.wrap;
}

/**
 * Where a latched release waits: null = now (no tempo, paused or looping), "bar" = the node's next bar (untrusted clock),
 * else the B of the next phrase line (`phrase`) or bar (`bar`).
 */
export function releaseBeat(d: DeckBeat | null, kind: "phrase" | "bar"): number | "bar" | null {
  if (!d || !d.playing || d.looping) return null;
  if (!d.trusted || !d.grid) return "bar";
  if (kind === "phrase") return phraseBeat({ ...d, grid: d.grid });
  return 4 * Math.floor(beatPosition(d.grid, d.position) / 4 + 1e-9) + 4 + d.wrap;
}

/** A Φ ramp's end: the next phrase line (paused or looping too: B still gets there), or 16 beats after engage untrusted. */
export function phiBeat(d: DeckBeat | null): number | null {
  if (!d) return null;
  return d.trusted && d.grid ? phraseBeat({ ...d, grid: d.grid }) : PHI_UNTRUSTED;
}
