import { describe, expect, test } from "bun:test";
import { forgetOnBpmChange, newLock, planSync, type SyncSource } from "../src/lib/deckSync";
import { getMixer } from "../src/lib/mixer";

const source = (bpm: number | null): SyncSource => ({ bpm, engine: true, fx: getMixer().fx.A });

describe("a Sync lock after a BPM change", () => {
  test("keeps its fold, step and held rate while neither deck's BPM changes", () => {
    const step = { ...newLock(), offset: 0.25 };
    const st = { ownBpm: 276, refBpm: 138, fold: 0.5 as const, step, rate: 1.01, tempo: 1 };
    expect(forgetOnBpmChange(st, source(276), source(138))).toBe(false);
    expect(st).toEqual({ ownBpm: 276, refBpm: 138, fold: 0.5, step, rate: 1.01, tempo: 1 });
  });

  test("forgets the fold after the menu's ×½ on the locked deck, so the next plan is not folded twice", () => {
    const st = { ownBpm: 276 as number | null, refBpm: 138 as number | null, fold: 0.5 as 0.5 | 1 | 2 | null, step: { ...newLock(), offset: 0.25 }, rate: 1.01 as number | null, tempo: 1 as number | null };
    const own = source(138), ref = source(138);
    expect(forgetOnBpmChange(st, own, ref)).toBe(true);
    expect(st.fold).toBeNull();
    expect(st.step).toEqual(newLock());
    expect(st.rate).toBeNull();
    expect(st.tempo).toBeNull();
    expect(st.ownBpm).toBe(138);
    const plan = planSync(own, ref, st.fold);
    expect(plan.ok && plan.fold).toBe(1);
  });

  test("forgets it too when the other deck's BPM changes", () => {
    const st = { ownBpm: 140 as number | null, refBpm: 140 as number | null, fold: 1 as 0.5 | 1 | 2 | null, step: newLock(), rate: null, tempo: null };
    expect(forgetOnBpmChange(st, source(140), source(70))).toBe(true);
    expect(st.fold).toBeNull();
    expect(st.refBpm).toBe(70);
  });
});
