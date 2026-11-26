// Sync: match this deck's fader tempo to the other deck's effective tempo (planSync), put its beats on the other deck's
// beats (phaseShift) when both decks have a trusted grid, and, while the deck stays locked, keep them there (lockStep).
// One of the tempos may be counted at half or double the other (138 against 276): Sync then folds it (`SyncFold`).
import { beatPhase, beatPosition, gridBpm, shiftByBeats, type BeatGrid } from "./beatGrid";
import { faderRate, planRate, type DeckFx, type PitchPlan } from "./mixer";
import type { DeckId } from "./player";

/** What Sync needs to know about a deck. `engine`: playing on the stretch engine (an element deck is pinned at 1x). */
export type SyncSource = { bpm: number | null; engine: boolean; fx: DeckFx };

const sources: Partial<Record<DeckId, () => SyncSource | null>> = {};
export function registerSyncSource(deck: DeckId, getter: () => SyncSource | null): () => void {
  sources[deck] = getter;
  return () => { if (sources[deck] === getter) delete sources[deck]; };
}
export const syncSourceOf = (deck: DeckId): SyncSource | null => sources[deck]?.() ?? null;

const usable = (bpm: number | null): bpm is number => typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0;

/** The reference deck's tempo in BPM: bpm x fader rate (bend ignored) on an engine deck, bpm x 1 on an element deck. */
export function referenceTempo(ref: SyncSource): number | null {
  return usable(ref.bpm) ? ref.bpm * (ref.engine ? faderRate(ref.fx) : 1) : null;
}

/**
 * How Sync counts the locked deck's beats against the other deck's: 1 as they are, 0.5 every second beat (its BPM is
 * stored at double, so half of it is matched), 2 every half beat (stored at half). Never a half- or double-speed rate.
 */
export type SyncFold = 0.5 | 1 | 2;
const FOLDS: readonly SyncFold[] = [1, 0.5, 2];
/** How near 1 a folded ratio must be to fold a pair that Sync could also reach as it is: a real octave error. */
export const FOLD_NEAR = 0.08;
/**
 * The fold for `bpm` against `target`. As they are whenever `fits(1)` (the pitch range reaches it), unless a fold
 * lands within FOLD_NEAR of the same tempo (276 against 138); otherwise the fold that brings them nearest (as a ratio).
 */
export function syncFold(bpm: number, target: number, fits: (fold: SyncFold) => boolean = () => false): SyncFold {
  const off = (f: SyncFold) => Math.abs(Math.log(target / (bpm * f)));
  const nearest = FOLDS.reduce((best, f) => off(f) < off(best) - 1e-9 ? f : best, 1);
  if (nearest === 1 || !fits(1)) return nearest;
  return Math.abs(target / (bpm * nearest) - 1) <= FOLD_NEAR ? nearest : 1;
}
/** The note beside Sync while a fold is in effect, and its explanation; null without a fold. */
export function foldNote(fold: SyncFold): { label: string; title: string } | null {
  if (fold === 1) return null;
  return fold === 0.5
    ? { label: "÷2", title: "Sync ÷2: το BPM αυτού του track είναι γραμμένο στο διπλάσιο από του άλλου deck. Το Sync ταιριάζει το μισό του, ώστε το track να παίζει κανονικά και όχι στη μισή ταχύτητα." }
    : { label: "×2", title: "Sync ×2: το BPM αυτού του track είναι γραμμένο στο μισό από του άλλου deck. Το Sync ταιριάζει το διπλάσιό του, ώστε το track να παίζει κανονικά και όχι στη διπλή ταχύτητα." };
}

export type SyncPlan = { ok: true; plan: PitchPlan; fold: SyncFold } | { ok: false; reason: "no-bpm" | "out-of-range" };
/** Range and pitch that make `own` play at the reference tempo, folded by an octave as `syncFold` says; the range
 * steps up (8 -> 16 -> 50) when needed. `held`: the fold a running lock chose, kept so a fader move never flips it. */
export function planSync(own: SyncSource, ref: SyncSource, held?: SyncFold | null): SyncPlan {
  const target = referenceTempo(ref);
  if (!usable(own.bpm) || target === null) return { ok: false, reason: "no-bpm" };
  const bpm = own.bpm;
  const fold = held ?? syncFold(bpm, target, f => planRate(own.fx, target / (bpm * f)) !== null);
  const plan = planRate(own.fx, target / (own.bpm * fold));
  return plan ? { ok: true, plan, fold } : { ok: false, reason: "out-of-range" };
}

/** A stored steady grid that contradicts the deck's tempo (a manual BPM won) says nothing about its beats. */
export const gridFits = (grid: BeatGrid | null, bpm: number | null): boolean =>
  grid != null && (grid.kind !== "straight" || grid.estimated || gridBpm(grid, bpm) !== null);

/** A deck's grid and where its playhead is at the moment in question. */
export type PhaseSide = { grid: BeatGrid | null; position: number };
const wrapBeat = (beats: number) => ((beats + 0.5) % 1 + 1) % 1 - 0.5;
/**
 * With a fold Sync counts beats in the coarser of the two grids, every second beat of the one counted at double, from
 * its own downbeat: half beats of the finer grid would put a real beat on an off-beat. `ownCount`/`refCount`: counted
 * beats per beat of the locked deck's grid and of the reference's.
 */
export const ownCount = (fold: number): number => Math.min(fold, 1);
const refCount = (fold: number): number => Math.min(1, 1 / fold);
/** `beatPhase` counting every second beat of the grid when `count` is 0.5. */
function foldedPhase(side: PhaseSide, count: number): number {
  const phase = beatPhase(side.grid, side.position);
  if (count === 1 || phase < 0 || !side.grid) return phase;
  const x = beatPosition(side.grid, side.position) * count;
  return x - Math.floor(x);
}
/**
 * Seconds to move `own`'s playhead so its beats fall `offsetBeats` after `ref`'s: the nearest way round, so never more
 * than half a beat. null when either grid cannot be trusted there (a plain BPM estimate, or outside a flexible grid).
 * `fold` (a `SyncFold`): the offset and the half beat are then in the counted beats (see `ownCount`).
 */
export function phaseShift(own: PhaseSide, ref: PhaseSide, offsetBeats = 0, fold = 1): number | null {
  const a = foldedPhase(own, ownCount(fold));
  const b = foldedPhase(ref, refCount(fold));
  if (a < 0 || b < 0 || !own.grid) return null;
  return shiftByBeats(own.grid, own.position, wrapBeat(b + offsetBeats - a) / ownCount(fold));
}
/** How far `own`'s beats sit after `ref`'s right now, in counted beats (-0.5..0.5); null as in `phaseShift`. */
export function phaseOffset(own: PhaseSide, ref: PhaseSide, fold = 1): number | null {
  const a = foldedPhase(own, ownCount(fold));
  const b = foldedPhase(ref, refCount(fold));
  return a < 0 || b < 0 ? null : wrapBeat(a - b);
}
/** A loop on the locked deck a whole number of the beats Sync counts long: its wrap keeps the beats where they were. */
export function loopKeepsBeats(grid: BeatGrid, loop: { start: number; end: number }, fold = 1): boolean {
  const beats = (beatPosition(grid, loop.end) - beatPosition(grid, loop.start)) * ownCount(fold);
  return Math.round(beats) >= 1 && Math.abs(beats - Math.round(beats)) < 1e-3;
}

// Sync lock. Beats further apart than LOCK_JUMP_S are closed by a jump or kept as the offset; closer ones by a rate trim
// of at most LOCK_TRIM, spread over LOCK_HORIZON_S. A grid tempo more than LOCK_SPAN from the faders' is not followed,
// and a gap in a beat list more than LOCK_SPAN from its tempo is not a beat.
export const LOCK_JUMP_S = 0.03;
/** A deck that is jumping anyway lands on the beat when it would be further off than this. */
export const LOCK_LAND_S = 0.002;
export const LOCK_TRIM = 0.003;
export const LOCK_HORIZON_S = 0.5;
export const LOCK_SPAN = 0.08;
/** How long the lock rides through a stretch whose grid tempo it cannot follow before it gives the beats up. */
export const LOCK_COAST_S = 2;

/** A deck at one moment: grid, playhead, and the engine rate it plays at. */
export type LockSide = PhaseSide & { rate: number };
/**
 * What the lock remembers between steps. `offset`: beats the locked deck is held after the reference (0 = on its beats).
 * `manual`: the DJ set that offset by hand (bend, scrub), so the deck's own cues keep it.
 */
export type LockState = { offset: number; manual: boolean; holding: boolean; at: number; ownPos: number; refPos: number; ownRate: number; refRate: number };
export const newLock = (): LockState => ({ offset: 0, manual: false, holding: false, at: 0, ownPos: 0, refPos: 0, ownRate: 1, refRate: 1 });
export type LockInput = {
  /** Audio-clock time both positions were read at. */
  at: number;
  own: LockSide;
  ref: LockSide;
  /** The rate the faders alone would give the locked deck now (own fader x the reference's bend). */
  expected: number;
  /** Both decks play on the engine with grids that fit, no loop that moves the beats, no bend held on the locked deck,
   * neither at its end. */
  canHold: boolean;
  /** The locked deck's own transport just moved it (play, cue, seek) or Sync was pressed: it lands on the beat. */
  snap: boolean;
  /** The DJ moved the locked deck by hand since the last hold (bend, scrub): where it is now is what the lock keeps. */
  hand: boolean;
  /** How the locked deck's beats are counted against the reference's (a `SyncFold`); 1 when left out. */
  fold?: number;
  /** The locked deck plays a loop (`loopKeepsBeats`): its wraps are not transport moves, and it cannot be jumped. */
  loop?: boolean;
};
/** `rate`: what the locked deck's engine should play at (null: no beat hold now, use the fader). `base`: the same without
 * the trim. `snap`: jump the deck onto the beat (the caller shifts it by `phaseShift` at its landing time). */
export type LockResult = { state: LockState; rate: number | null; base: number | null; snap: boolean };

/**
 * The beat length the lock steers by at `t`, and whether `t` sits at a gap that is not a beat (a timing jump in a beat
 * list). A list at one tempo uses that tempo; any other list the mean of the four beats around `t`, so uneven beats do
 * not wobble the rate.
 */
function tempoAt(grid: BeatGrid, t: number): { beat: number; odd: boolean } {
  if (grid.kind === "straight") return { beat: grid.period, odd: false };
  const beat = grid.period ?? (shiftByBeats(grid, t, 2) - shiftByBeats(grid, t, -2)) / 4;
  return { beat, odd: !(Math.abs(shiftByBeats(grid, t, 1) / beat - 1) <= LOCK_SPAN) };
}

/**
 * One step of the lock. The locked deck plays at the reference's rate times the ratio of the two grids' beat lengths,
 * trimmed to close a small phase error. Who moves when the beats are apart:
 * - the locked deck's own transport moved it (`snap`, or its playhead jumped): it lands on the beat;
 * - the DJ's hand moved it, the hold is only now starting, or the reference jumped: it stays where it is and that
 *   offset is held, so an audible deck is never moved by the other one;
 * - neither playhead jumped (a timing jump inside a grid): it is put back on the beat. The odd gap itself is ridden
 *   through at the held rate, with the memory untouched.
 * A locked deck in a loop is never jumped: a small error is trimmed, a larger one becomes the held offset.
 */
export function lockStep(st: LockState, i: LockInput): LockResult {
  const idle: LockResult = { state: { ...st, holding: false }, rate: null, base: null, snap: false };
  if (!i.canHold || !i.own.grid || !i.ref.grid) return idle;
  const fold = i.fold ?? 1;
  const mine = tempoAt(i.own.grid, i.own.position), theirs = tempoAt(i.ref.grid, i.ref.position);
  let offset = st.offset, manual = st.manual;
  let shift = phaseShift(i.own, i.ref, offset, fold);
  if (shift === null || !(mine.beat > 0) || !(theirs.beat > 0)) return idle;
  if (mine.odd || theirs.odd) {
    return st.holding && i.at >= st.at && i.at - st.at <= LOCK_COAST_S ? { state: st, rate: st.ownRate, base: st.ownRate, snap: false } : idle;
  }
  const base = i.ref.rate * mine.beat / (fold * theirs.beat);
  if (!(Math.abs(base / i.expected - 1) <= LOCK_SPAN)) return idle;
  const dt = st.holding ? Math.max(0, i.at - st.at) : 0;
  const jumped = (position: number, before: number, rate: number) => st.holding && Math.abs(position - (before + dt * rate)) > LOCK_JUMP_S;
  const keep = (byHand: boolean) => { offset = phaseOffset(i.own, i.ref, fold) ?? offset; manual = byHand; shift = 0; };
  let snap = false;
  if (i.hand) keep(true);
  else if (i.loop) { if (!st.holding || Math.abs(shift) > LOCK_JUMP_S) keep(false); }
  else if (i.snap || jumped(i.own.position, st.ownPos, st.ownRate)) {
    // The deck is jumping anyway: land it on the beat (or on the DJ's own offset), however small the error.
    if (!manual && offset !== 0) { offset = 0; shift = phaseShift(i.own, i.ref, 0, fold) ?? 0; }
    snap = Math.abs(shift) > LOCK_LAND_S;
  } else if (!st.holding) keep(false);
  else if (Math.abs(shift) > LOCK_JUMP_S) {
    if (jumped(i.ref.position, st.refPos, st.refRate)) keep(false);
    else snap = true;
  }
  const limit = LOCK_TRIM * base;
  const rate = snap ? base : base + Math.max(-limit, Math.min(limit, shift / Math.max(LOCK_HORIZON_S, 2 * dt)));
  const state = { offset, manual, holding: true, at: i.at, ownPos: i.own.position + (snap ? shift : 0), refPos: i.ref.position, ownRate: rate, refRate: i.ref.rate };
  return { state, rate, base, snap };
}
