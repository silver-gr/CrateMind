// One-shot Sync: match this deck's fader tempo to the other deck's effective tempo (planSync), then put its beats on the
// other deck's beats (phaseShift) when both decks have a trusted grid.
import { beatPhase, shiftByBeats, type BeatGrid } from "./beatGrid";
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

/** A deck's grid and where its playhead will be at the moment the shift lands. */
export type PhaseSide = { grid: BeatGrid | null; position: number };
/**
 * Seconds to move `own`'s playhead so its beats fall on `ref`'s: the nearest way round, so never more than half a beat.
 * null when either grid cannot be trusted there (a plain BPM estimate, or outside a flexible grid).
 */
export function phaseShift(own: PhaseSide, ref: PhaseSide): number | null {
  const a = beatPhase(own.grid, own.position);
  const b = beatPhase(ref.grid, ref.position);
  if (a < 0 || b < 0 || !own.grid) return null;
  const beats = ((b - a + 0.5) % 1 + 1) % 1 - 0.5;
  return shiftByBeats(own.grid, own.position, beats);
}
