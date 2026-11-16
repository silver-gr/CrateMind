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
// of at most LOCK_TRIM, spread over LOCK_HORIZON_S. A grid tempo more than LOCK_SPAN from the faders' is not followed.
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
/** What the lock remembers between steps. `offset`: beats the locked deck is held after the reference (0 = on its beats). */
export type LockState = { offset: number; holding: boolean; at: number; ownPos: number; refPos: number; ownRate: number; refRate: number };
export const newLock = (): LockState => ({ offset: 0, holding: false, at: 0, ownPos: 0, refPos: 0, ownRate: 1, refRate: 1 });
export type LockInput = {
  /** Audio-clock time both positions were read at. */
  at: number;
  own: LockSide;
  ref: LockSide;
  /** The rate the faders alone would give the locked deck now (own fader x the reference's bend). */
  expected: number;
  /** Both decks play on the engine with grids that fit, no loop, no bend held on the locked deck. */
  canHold: boolean;
  /** The locked deck's own transport just moved it (play, cue, seek) or Sync was pressed: it may jump onto the beat. */
  snap: boolean;
  /** The DJ just moved the locked deck by hand (bend, jog): keep where it is. */
  hand: boolean;
};
/** `rate`: what the locked deck's engine should play at (null: no beat hold now, use the fader). `base`: the same without
 * the trim. `snap`: jump the deck onto the beat (the caller shifts it by `phaseShift` at its landing time). */
export type LockResult = { state: LockState; rate: number | null; base: number | null; snap: boolean };

/**
 * One step of the lock. The locked deck plays at the reference's rate times the ratio of the two grids' beat lengths,
 * trimmed to close a small phase error. A large error is closed by a jump only when the locked deck's own transport made
 * it, or when neither deck jumped (a timing jump inside a grid); when the reference jumped, or the hold is only now
 * starting, the deck is left where it is and that offset is held, so an audible deck is never moved by the other one.
 */
export function lockStep(st: LockState, i: LockInput): LockResult {
  const idle: LockResult = { state: { ...st, holding: false }, rate: null, base: null, snap: false };
  if (!i.canHold || !i.own.grid || !i.ref.grid) return idle;
  const mine = shiftByBeats(i.own.grid, i.own.position, 1);
  const theirs = shiftByBeats(i.ref.grid, i.ref.position, 1);
  let offset = st.offset;
  let shift = phaseShift(i.own, i.ref, offset);
  if (shift === null || !(mine > 0) || !(theirs > 0)) return idle;
  const base = i.ref.rate * mine / theirs;
  if (!(Math.abs(base / i.expected - 1) <= LOCK_SPAN)) {
    // One odd gap in a beat list (a timing jump) reads as another tempo: ride through it at the held rate, with the
    // memory untouched, so the step after it sees two playheads that never jumped and puts the deck back on the beat.
    return st.holding && i.at >= st.at && i.at - st.at <= LOCK_COAST_S ? { state: st, rate: st.ownRate, base: st.ownRate, snap: false } : idle;
  }
  const dt = st.holding ? Math.max(0, i.at - st.at) : 0;
  const jumped = (position: number, before: number, rate: number) => st.holding && Math.abs(position - (before + dt * rate)) > LOCK_JUMP_S;
  // The locked deck is jumping anyway (its own cue, seek or start): land it on the beat, however small the error.
  const moving = i.snap || jumped(i.own.position, st.ownPos, st.ownRate);
  let snap = false;
  if (i.hand) {
    offset = phaseOffset(i.own, i.ref) ?? offset; shift = 0;
  } else if (moving) {
    snap = Math.abs(shift) > LOCK_LAND_S;
  } else if (Math.abs(shift) > LOCK_JUMP_S) {
    if (!st.holding || jumped(i.ref.position, st.refPos, st.refRate)) { offset = phaseOffset(i.own, i.ref) ?? offset; shift = 0; }
    else snap = true;
  }
  const limit = LOCK_TRIM * base;
  const rate = snap ? base : base + Math.max(-limit, Math.min(limit, shift / Math.max(LOCK_HORIZON_S, 2 * dt)));
  const state = { offset, holding: true, at: i.at, ownPos: i.own.position + (snap ? shift : 0), refPos: i.ref.position, ownRate: rate, refRate: i.ref.rate };
  return { state, rate, base, snap };
}
