// One-shot Sync: match this deck's fader tempo to the other deck's effective tempo. Tempo only, no phase.
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
