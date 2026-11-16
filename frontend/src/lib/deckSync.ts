// Sync: match this deck's fader tempo to the other deck's effective tempo (planSync), put its beats on the other deck's
// beats (phaseShift) when both decks have a trusted grid, and, while the deck stays locked, keep them there (lockStep).
import { beatPhase, gridBpm, shiftByBeats, type BeatGrid } from "./beatGrid";
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

export type SyncPlan = { ok: true; plan: PitchPlan } | { ok: false; reason: "no-bpm" | "out-of-range" };
/** Range and pitch that make `own` play at the reference tempo; the range steps up (8 -> 16 -> 50) when needed. */
export function planSync(own: SyncSource, ref: SyncSource): SyncPlan {
  const target = referenceTempo(ref);
  if (!usable(own.bpm) || target === null) return { ok: false, reason: "no-bpm" };
  const plan = planRate(own.fx, target / own.bpm);
  return plan ? { ok: true, plan } : { ok: false, reason: "out-of-range" };
}

/** A stored steady grid that contradicts the deck's tempo (a manual BPM won) says nothing about its beats. */
export const gridFits = (grid: BeatGrid | null, bpm: number | null): boolean =>
  grid != null && (grid.kind !== "straight" || grid.estimated || gridBpm(grid, bpm) !== null);

/** A deck's grid and where its playhead is at the moment in question. */
export type PhaseSide = { grid: BeatGrid | null; position: number };
const wrapBeat = (beats: number) => ((beats + 0.5) % 1 + 1) % 1 - 0.5;
/**
 * Seconds to move `own`'s playhead so its beats fall `offsetBeats` after `ref`'s: the nearest way round, so never more
 * than half a beat. null when either grid cannot be trusted there (a plain BPM estimate, or outside a flexible grid).
 */
export function phaseShift(own: PhaseSide, ref: PhaseSide, offsetBeats = 0): number | null {
  const a = beatPhase(own.grid, own.position);
  const b = beatPhase(ref.grid, ref.position);
  if (a < 0 || b < 0 || !own.grid) return null;
  return shiftByBeats(own.grid, own.position, wrapBeat(b + offsetBeats - a));
}
/** How far `own`'s beats sit after `ref`'s right now, in beats (-0.5..0.5); null as in `phaseShift`. */
export function phaseOffset(own: PhaseSide, ref: PhaseSide): number | null {
  const a = beatPhase(own.grid, own.position);
  const b = beatPhase(ref.grid, ref.position);
  return a < 0 || b < 0 ? null : wrapBeat(a - b);
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
  /** Both decks play on the engine with grids that fit, no loop, no bend held on the locked deck, neither at its end. */
  canHold: boolean;
  /** The locked deck's own transport just moved it (play, cue, seek) or Sync was pressed: it lands on the beat. */
  snap: boolean;
  /** The DJ moved the locked deck by hand since the last hold (bend, scrub): where it is now is what the lock keeps. */
  hand: boolean;
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
 */
export function lockStep(st: LockState, i: LockInput): LockResult {
  const idle: LockResult = { state: { ...st, holding: false }, rate: null, base: null, snap: false };
  if (!i.canHold || !i.own.grid || !i.ref.grid) return idle;
  const mine = tempoAt(i.own.grid, i.own.position), theirs = tempoAt(i.ref.grid, i.ref.position);
  let offset = st.offset, manual = st.manual;
  let shift = phaseShift(i.own, i.ref, offset);
  if (shift === null || !(mine.beat > 0) || !(theirs.beat > 0)) return idle;
  if (mine.odd || theirs.odd) {
    return st.holding && i.at >= st.at && i.at - st.at <= LOCK_COAST_S ? { state: st, rate: st.ownRate, base: st.ownRate, snap: false } : idle;
  }
  const base = i.ref.rate * mine.beat / theirs.beat;
  if (!(Math.abs(base / i.expected - 1) <= LOCK_SPAN)) return idle;
  const dt = st.holding ? Math.max(0, i.at - st.at) : 0;
  const jumped = (position: number, before: number, rate: number) => st.holding && Math.abs(position - (before + dt * rate)) > LOCK_JUMP_S;
  const keep = (byHand: boolean) => { offset = phaseOffset(i.own, i.ref) ?? offset; manual = byHand; shift = 0; };
  let snap = false;
  if (i.hand) keep(true);
  else if (i.snap || jumped(i.own.position, st.ownPos, st.ownRate)) {
    // The deck is jumping anyway: land it on the beat (or on the DJ's own offset), however small the error.
    if (!manual && offset !== 0) { offset = 0; shift = phaseShift(i.own, i.ref, 0) ?? 0; }
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
