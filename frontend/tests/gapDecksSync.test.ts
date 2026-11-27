// Gaps in the Sync tests: fold symmetry, the plan's tempo invariant, unusable tempos, the phase shift as an idempotent
// operation (steady, list and folded grids), lockStep purity and its refusals, and the odd-gap coast limit.
import { describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import {
  LOCK_COAST_S, lockStep, loopKeepsBeats, newLock, ownCount, phaseOffset, phaseShift, planSync, syncFold,
  type LockInput, type LockState, type SyncFold, type SyncSource,
} from "../src/lib/deckSync";
import { NEUTRAL_FX, type DeckFx } from "../src/lib/mixer";

const fx = (range: number, pitch: number): DeckFx => ({ ...NEUTRAL_FX, range, pitch });
const src = (bpm: number | null, engine = true, f: DeckFx = NEUTRAL_FX): SyncSource => ({ bpm, engine, fx: f });
const steady = (bpm: number, anchor = 0): BeatGrid => ({ kind: "straight", anchor, period: 60 / bpm, estimated: false, overridden: false });
const list = (times: number[], period?: number): BeatGrid => ({ kind: "list", times, downIndex: 0, estimated: false, overridden: false, period });
const always = () => true;

describe("syncFold symmetry: which deck is locked never changes whether the pair is folded", () => {
  // Pairs well away from the FOLD_NEAR edge (see the report for the band near it).
  test.each([
    [276, 138], [138, 276], [140, 75], [140, 77], [100, 141], [100, 142], [100, 70], [100, 71], [174, 90], [128, 64.5], [128, 130],
  ])("%d against %d", (a, b) => {
    for (const fits of [undefined, always]) {
      const there = syncFold(a, b, fits), back = syncFold(b, a, fits);
      expect(back).toBe(there === 1 ? 1 : there === 0.5 ? 2 : 0.5);
    }
  });

  test("near the FOLD_NEAR edge both decks agree too (the margin is a ratio either way)", () => {
    for (const [a, b] of [[100, 54.2], [100, 53.5], [100, 186], [100, 184], [138, 128], [138, 149.5]]) {
      const there = syncFold(a, b, always), back = syncFold(b, a, always);
      expect(back).toBe(there === 1 ? 1 : there === 0.5 ? 2 : 0.5);
    }
    expect(syncFold(100, 54.2, always)).toBe(1);
    expect(syncFold(276, 138, always)).toBe(0.5);
  });

  test("an exact half-octave (√2) is not folded either way: neither fold is nearer", () => {
    expect(syncFold(100, 100 * Math.SQRT2)).toBe(1);
    expect(syncFold(100, 100 / Math.SQRT2)).toBe(1);
  });

  test("a 4:1 pair is folded once, at most: ×2 still leaves it out of range", () => {
    expect(syncFold(70, 280)).toBe(2);
    expect(planSync(src(70), src(280))).toEqual({ ok: false, reason: "out-of-range" });
  });
});

describe("planSync lands the locked deck on the reference tempo", () => {
  test.each([
    // own BPM, reference, the fold expected
    ["128 to 130", src(128), src(130), 1],
    ["174 counted at double, against 87", src(174), src(87), 0.5],
    ["85 counted at half, against 172", src(85), src(172), 2],
    ["140 against 70 with the reference at +4%", src(140), src(70, true, fx(0.08, 0.5)), 0.5],
    ["150 against 75.5", src(150), src(75.5), 0.5],
    ["120 against an element deck whose fader is ignored", src(120), src(128, false, fx(0.08, -1)), 1],
    ["already on a 16% range, small move", src(126, true, fx(0.16, 0.25)), src(127), 1],
  ] as const)("%s", (_name, own, ref, fold) => {
    const r = planSync(own, ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const target = ref.bpm! * (ref.engine ? 1 + ref.fx.pitch * ref.fx.range : 1);
    expect(r.fold).toBe(fold as SyncFold);
    expect(Math.abs(r.plan.pitch)).toBeLessThanOrEqual(1);
    // The deck's real tempo (its stored BPM counted with the fold) times its new rate is the reference's tempo.
    expect(own.bpm! * r.fold * (1 + r.plan.pitch * r.plan.range)).toBeCloseTo(target, 9);
    // The range never narrows below what the deck already had.
    expect(r.plan.range).toBeGreaterThanOrEqual(own.fx.range);
  });

  test("held = null is the same as no held fold", () => {
    expect(planSync(src(276), src(138), null)).toEqual(planSync(src(276), src(138)));
  });

  test.each([NaN, Infinity, -Infinity, -128, 0])("an unusable tempo (%p) on either deck is «no-bpm», never a plan", bpm => {
    expect(planSync(src(bpm), src(128))).toEqual({ ok: false, reason: "no-bpm" });
    expect(planSync(src(128), src(bpm))).toEqual({ ok: false, reason: "no-bpm" });
  });
});

/** Circular distance between two phases (in beats). */
const phaseGap = (a: number, b: number) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);

describe("phaseShift is idempotent and short", () => {
  // own grid, ref grid, fold, the own beat length the shift is bounded by (half a counted beat, in own seconds)
  const ownList = list(Array.from({ length: 80 }, (_, n) => 0.2 + n * 0.46 + (n >= 40 ? 0.07 : 0)));
  const cases: [string, BeatGrid, BeatGrid, number, number][] = [
    ["steady 128 against steady 130", steady(128, 0.11), steady(130, 0.37), 1, 60 / 128 / 2],
    ["a list with a timing jump against steady 130", ownList, steady(130, 0.37), 1, 0.5 * 0.46 + 0.07],
    ["276 counted at double, against 138", steady(276, 0.05), steady(138, 0.3), 0.5, 60 / 276],
    ["69 counted at half, against 138", steady(69, 0.05), steady(138, 0.3), 2, 60 / 69 / 2],
  ];
  test.each(cases)("%s", (_name, ownGrid, refGrid, fold, bound) => {
    for (const ownPos of [3.01, 7.77, 12.345, 20.5]) {
      for (const refPos of [4.2, 9.99, 15.03]) {
        for (const offset of [-0.4, -0.2, 0, 0.25, 0.45]) {
          const own = { grid: ownGrid, position: ownPos }, ref = { grid: refGrid, position: refPos };
          const shift = phaseShift(own, ref, offset, fold)!;
          expect(shift).not.toBeNull();
          expect(Math.abs(shift)).toBeLessThanOrEqual(bound + 1e-9);
          const landed = { grid: ownGrid, position: ownPos + shift };
          // Where it lands, the beats sit at the asked offset, and asking again moves it nowhere.
          expect(phaseGap(phaseOffset(landed, ref, fold)!, offset)).toBeLessThan(1e-9);
          expect(Math.abs(phaseShift(landed, ref, offset, fold)!)).toBeLessThan(1e-9);
        }
      }
    }
  });

  test("swapping the decks (and the fold) mirrors the offset", () => {
    const a = { grid: steady(276, 0.05), position: 11.3 }, b = { grid: steady(138, 0.3), position: 7.9 };
    expect(phaseOffset(a, b, 0.5)!).toBeCloseTo(-phaseOffset(b, a, 2)!, 9);
    const c = { grid: steady(128, 0.11), position: 5.55 }, d = { grid: steady(130, 0.37), position: 6.1 };
    expect(phaseOffset(c, d)!).toBeCloseTo(-phaseOffset(d, c)!, 9);
  });

  test.each([
    ["a plain estimate on the locked deck", { grid: { ...steady(128), estimated: true }, position: 5 }, { grid: steady(128), position: 5 }],
    ["a plain estimate on the reference", { grid: steady(128), position: 5 }, { grid: { ...steady(128), estimated: true }, position: 5 }],
    ["no grid on the locked deck", { grid: null, position: 5 }, { grid: steady(128), position: 5 }],
    ["the reference outside its beat list", { grid: steady(128), position: 5 }, { grid: list([10, 10.5, 11, 11.5]), position: 5 }],
    ["a non-finite playhead", { grid: steady(128), position: NaN }, { grid: steady(128), position: 5 }],
  ] as const)("no shift with %s", (_name, own, ref) => {
    expect(phaseShift(own, ref)).toBeNull();
    expect(phaseOffset(own, ref)).toBeNull();
  });

  test("an estimate with the DJ's downbeat is trusted", () => {
    const marked = { grid: { ...steady(128), estimated: true, overridden: true }, position: 5 };
    expect(phaseShift(marked, { grid: steady(128), position: 5.1 })).not.toBeNull();
  });
});

describe("loopKeepsBeats edges", () => {
  const G = steady(120);
  test.each([
    ["no length", { start: 4, end: 4 }, false],
    ["backwards", { start: 6, end: 4 }, false],
    ["half a beat", { start: 4, end: 4.25 }, false],
    ["a beat, within float error", { start: 4, end: 4 + 0.5 * 0.9995 }, true],
    ["a beat and 0.4% over", { start: 4, end: 4 + 0.5 * 1.004 }, false],
  ] as const)("%s", (_name, loop, keeps) => {
    expect(loopKeepsBeats(G, loop)).toBe(keeps);
  });
  test("the counted beat follows ownCount", () => {
    expect(ownCount(0.5)).toBe(0.5);
    expect(ownCount(2)).toBe(1);
    expect(loopKeepsBeats(G, { start: 4, end: 5 }, 0.5)).toBe(true);   // 2 beats = 1 counted beat
    expect(loopKeepsBeats(G, { start: 4, end: 4.5 }, 0.5)).toBe(false); // 1 beat = half a counted beat
  });
});

const G = steady(120);
const input = (own: number, ref: number, more: Partial<LockInput> = {}): LockInput => ({
  at: 0, own: { grid: G, position: own, rate: 1 }, ref: { grid: G, position: ref, rate: 1 }, expected: 1, canHold: true, snap: false, hand: false, ...more,
});
const held = (more: Partial<LockState> = {}): LockState => ({ offset: 0, manual: false, holding: true, at: 0, ownPos: 10, refPos: 10, ownRate: 1, refRate: 1, ...more });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}

describe("lockStep is pure", () => {
  test.each([
    ["in phase", held(), input(10.1, 10.1, { at: 0.1 })],
    ["a small error", held(), input(10.099, 10.1, { at: 0.1 })],
    ["a cue on the locked deck", held({ offset: -0.4 }), input(40.2, 10.1, { at: 0.1 })],
    ["the DJ's hand", held(), input(10.15, 10.1, { at: 0.1, hand: true })],
    ["a looping deck", held(), input(10.2, 10.1, { at: 0.1, loop: true })],
    ["a hold that only starts", newLock(), input(10.11, 10.1)],
  ] as const)("%s: inputs are not written to, and the same step gives the same answer", (_name, st, i) => {
    const before = JSON.stringify([st, i]);
    const frozenState = deepFreeze(structuredClone(st)), frozenInput = deepFreeze(structuredClone(i));
    const a = lockStep(frozenState, frozenInput);
    expect(lockStep(frozenState, frozenInput)).toEqual(a);
    expect(JSON.stringify([st, i])).toBe(before);
  });
});

describe("lockStep refuses a hold it cannot make sense of", () => {
  test.each([
    ["the faders' rate is NaN", input(10.1, 10.1, { at: 0.1, expected: NaN })],
    ["the faders' rate is 0", input(10.1, 10.1, { at: 0.1, expected: 0 })],
    ["the faders' rate is Infinity", input(10.1, 10.1, { at: 0.1, expected: Infinity })],
    ["the reference is stopped (rate 0)", { ...input(10.1, 10.1, { at: 0.1 }), ref: { grid: G, position: 10.1, rate: 0 } }],
    ["no grid on the reference", { ...input(10.1, 10.1, { at: 0.1 }), ref: { grid: null, position: 10.1, rate: 1 } }],
    ["no grid on the locked deck", { ...input(10.1, 10.1, { at: 0.1 }), own: { grid: null, position: 10.1, rate: 1 } }],
  ] as const)("%s", (_name, i) => {
    const r = lockStep(held({ offset: 0.1, manual: true }), i);
    expect(r).toMatchObject({ rate: null, base: null, snap: false, state: { holding: false } });
    // The DJ's offset survives a step without a hold.
    expect(r.state).toMatchObject({ offset: 0.1, manual: true });
  });
});

describe("riding through an odd gap in a beat list", () => {
  // The reference's kick stops for 4 s at 11 s: 13 s is inside a gap that is not a beat.
  const gap = list([10, 10.5, 11, 15, 15.5, 16], 0.5);
  const step = (st: LockState, at: number) => lockStep(st, { ...input(13, 13, { at }), ref: { grid: gap, position: 13, rate: 1 } });
  const last = held({ at: 10.5, ownRate: 1.001 });

  test("up to LOCK_COAST_S after the last hold, the held rate and memory are kept", () => {
    expect(LOCK_COAST_S).toBe(2);
    const r = step(last, 10.5 + LOCK_COAST_S);
    expect(r.rate).toBe(1.001);
    expect(r.base).toBe(1.001);
    expect(r.snap).toBe(false);
    expect(r.state).toBe(last);
  });
  test("just past it, the hold ends", () => {
    expect(step(last, 10.5 + LOCK_COAST_S + 1e-3).rate).toBeNull();
  });
  test("an audio clock that went backwards does not coast", () => {
    expect(step(last, 10.4).rate).toBeNull();
  });
  test("a lock that was not holding does not coast", () => {
    expect(step({ ...last, holding: false }, 11).rate).toBeNull();
  });
});
