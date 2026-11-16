import { beforeEach, describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { LOCK_TRIM, gridFits, lockStep, newLock, phaseOffset, phaseShift, type LockInput, type LockState } from "../src/lib/deckSync";
import { getMixer, resetMixer, resetPickup, setDeckPitch, setDeckPitchFromController, setDeckRangePitch, setSyncLock } from "../src/lib/mixer";

const steady = (period: number, anchor = 0): BeatGrid => ({ kind: "straight", anchor, period, estimated: false, overridden: false });
const list = (times: number[]): BeatGrid => ({ kind: "list", times, downIndex: 0, estimated: false, overridden: false });
const G = steady(0.5);

/** An input with both decks on a 120 BPM grid at rate 1; `own` and `ref` are the playhead positions. */
const input = (own: number, ref: number, more: Partial<LockInput> = {}): LockInput => ({
  at: 0, own: { grid: G, position: own, rate: 1 }, ref: { grid: G, position: ref, rate: 1 }, expected: 1, canHold: true, snap: false, hand: false, ...more,
});
/** A lock that has been holding in phase at 10 s, one 100 ms step ago. */
const held = (more: Partial<LockState> = {}): LockState => ({ offset: 0, manual: false, holding: true, at: 0, ownPos: 10, refPos: 10, ownRate: 1, refRate: 1, ...more });

describe("phase helpers", () => {
  test("an offset moves the target; phaseOffset reads it back", () => {
    expect(phaseShift({ grid: G, position: 10 }, { grid: G, position: 10.1 })).toBeCloseTo(0.1);
    expect(phaseShift({ grid: G, position: 10 }, { grid: G, position: 10.1 }, -0.2)).toBeCloseTo(0);
    expect(phaseOffset({ grid: G, position: 10.1 }, { grid: G, position: 10 })).toBeCloseTo(0.2);
    expect(phaseOffset({ grid: { ...G, estimated: true }, position: 10 }, { grid: G, position: 10 })).toBeNull();
  });
  test("gridFits: a steady grid that contradicts the deck's BPM does not fit", () => {
    expect(gridFits(G, 120)).toBe(true);
    expect(gridFits(G, 140)).toBe(false);
    expect(gridFits(null, 120)).toBe(false);
    expect(gridFits(list([0, 0.5, 1]), 140)).toBe(true);
  });
});

describe("lockStep", () => {
  test("in phase: the reference's rate, no trim, no jump", () => {
    const r = lockStep(held(), input(10.1, 10.1, { at: 0.1 }));
    expect(r).toMatchObject({ rate: 1, base: 1, snap: false });
    expect(r.state).toMatchObject({ holding: true, offset: 0, ownPos: 10.1, refPos: 10.1 });
  });
  test("a small error is closed by a trim with the right sign, capped", () => {
    const behind = lockStep(held(), input(10.099, 10.1, { at: 0.1 }));
    expect(behind.snap).toBe(false);
    expect(behind.rate!).toBeCloseTo(1 + 0.001 / 0.5, 6);              // 1 ms over the 0.5 s horizon
    expect(lockStep(held(), input(10.101, 10.1, { at: 0.1 })).rate!).toBeLessThan(1);
    expect(lockStep(held(), input(10.08, 10.1, { at: 0.1 })).rate!).toBeCloseTo(1 + LOCK_TRIM, 9);
  });
  test("the rate follows the reference's rate and the grids' beat lengths", () => {
    const r = lockStep(newLock(), { ...input(10, 10), own: { grid: steady(0.5), position: 10, rate: 1 }, ref: { grid: steady(0.4), position: 10, rate: 0.84 }, expected: 1.05 });
    expect(r.base!).toBeCloseTo(0.84 * 0.5 / 0.4);
    // A beat list with two tempos is followed at its local one: ten beats 0.5 s apart, then ten 0.52 s apart.
    const ref = list([...Array.from({ length: 10 }, (_, n) => n * 0.5), ...Array.from({ length: 10 }, (_, n) => 5 + n * 0.52)]);
    expect(lockStep(newLock(), { ...input(2.25, 2.25), ref: { grid: ref, position: 2.25, rate: 1 } }).base!).toBeCloseTo(1, 6);
    expect(lockStep(newLock(), { ...input(2.25, 7.34), ref: { grid: ref, position: 7.34, rate: 1 } }).base!).toBeCloseTo(0.5 / 0.52, 6);
    // Uneven beats (a flexible grid) do not wobble the rate: it follows the mean of the beats around the playhead.
    const uneven = list(Array.from({ length: 20 }, (_, n) => n * 0.5 + (n % 2 ? 0.006 : 0)));
    const rates = [3.1, 3.35, 3.6, 3.85].map(t => lockStep(newLock(), { ...input(t, t), ref: { grid: uneven, position: t, rate: 1 } }).base!);
    for (const r of rates) expect(Math.abs(r - 1)).toBeLessThan(0.004);
  });
  test("no hold: not allowed, an estimated grid, or a grid tempo far from the faders (half tempo)", () => {
    expect(lockStep(held(), input(10, 10, { canHold: false }))).toMatchObject({ rate: null, base: null, snap: false, state: { holding: false } });
    expect(lockStep(held(), { ...input(10, 10), ref: { grid: { ...G, estimated: true }, position: 10, rate: 1 } }).rate).toBeNull();
    expect(lockStep(newLock(), { ...input(10, 10), ref: { grid: steady(1), position: 10, rate: 1 } }).rate).toBeNull();
    expect(lockStep(newLock(), input(10, 10, { expected: 1.1 })).rate).toBeNull();
  });
  test("the locked deck's own jump snaps it onto the beat", () => {
    const cue = lockStep(held(), input(40.2, 10.1, { at: 0.1 }));      // a hot cue: the position jumped
    expect(cue).toMatchObject({ snap: true, rate: 1 });
    expect(cue.state.ownPos).toBeCloseTo(40.1);                         // where it lands after the shift
    expect(lockStep(newLock(), input(40.2, 10.1, { snap: true })).snap).toBe(true); // play, or Sync pressed
    expect(lockStep(newLock(), input(10.11, 10.1, { snap: true })).snap).toBe(true); // 10 ms off would be a flam: land on the beat
    expect(lockStep(newLock(), input(10.101, 10.1, { snap: true })).snap).toBe(false);
    // An offset left by a cue of the reference is dropped: the deck lands on the beat. One the DJ set by hand is kept.
    const dropped = lockStep(held({ offset: -0.4 }), input(40.2, 10.1, { at: 0.1 }));
    expect(dropped.state.offset).toBe(0);
    expect(dropped.state.ownPos).toBeCloseTo(40.1);
    const kept = lockStep(held({ offset: 0.1, manual: true }), input(40.2, 10.1, { at: 0.1 }));
    expect(kept.state.offset).toBe(0.1);
    expect(kept.state.ownPos).toBeCloseTo(40.15);
  });
  test("a jump of the reference, or a hold that only now starts, leaves the locked deck alone and keeps the offset", () => {
    const cued = lockStep(held(), input(10.1, 33.3, { at: 0.1 }));      // the DJ cues the reference
    expect(cued).toMatchObject({ snap: false, rate: 1 });
    expect(cued.state.offset).toBeCloseTo(-0.4);                        // own phase 0.2, reference phase 0.6
    const next = lockStep(cued.state, input(10.2, 33.4, { at: 0.2 }));
    expect(next.snap).toBe(false);
    expect(next.rate!).toBeCloseTo(1, 9);
    const resumed = lockStep(newLock(), input(10.1, 33.3));
    expect(resumed.snap).toBe(false);
    expect(resumed.state.offset).toBeCloseTo(-0.4);
    // Also when it is only a little off: a hold that starts never pulls the deck, it takes the offset as it is.
    const near = lockStep(newLock(), input(10.11, 10.1));
    expect(near).toMatchObject({ snap: false, rate: 1 });
    expect(near.state.offset).toBeCloseTo(0.02);
  });
  test("a timing jump inside a grid, with both playheads continuous, moves the locked deck", () => {
    // The reference's beats come a quarter beat (0.125 s) late from 12 s on.
    const ref = list([10, 10.5, 11, 11.5, 12.125, 12.625, 13.125]);
    const before = lockStep(held({ ownPos: 11.4, refPos: 11.4 }), { ...input(11.45, 11.45, { at: 0.05 }), ref: { grid: ref, position: 11.45, rate: 1 } });
    expect(before.snap).toBe(false);
    const after = lockStep(held({ ownPos: 12.2, refPos: 12.2 }), { ...input(12.3, 12.3, { at: 0.1 }), ref: { grid: ref, position: 12.3, rate: 1 } });
    expect(after.snap).toBe(true);
    expect(after.state.ownPos).toBeCloseTo(12.175);
  });
  test("a long gap in a beat list is ridden through, and the deck is put on the beat after it", () => {
    // The reference's kick stops for 1.4 beats at 11.5 s (an edit), so its later beats sit 0.4 beat (0.2 s) late.
    const ref: BeatGrid = { ...list([10, 10.5, 11, 11.5, 12.2, 12.7, 13.2, 13.7]), period: 0.5 };
    const step = (st: LockState, t: number) => lockStep(st, { ...input(t, t, { at: t }), ref: { grid: ref, position: t, rate: 1 } });
    const before = step(held({ at: 10.3, ownPos: 10.3, refPos: 10.3 }), 10.4);
    expect(before).toMatchObject({ snap: false, state: { holding: true } });
    const inside = step(before.state, 11.8);                            // 0.7 s is not a beat of this grid: not followed
    expect(inside.state).toBe(before.state);
    expect(inside.rate!).toBeCloseTo(1, 6);
    const after = step(inside.state, 12.3);
    expect(after.snap).toBe(true);
    expect(after.state.ownPos).toBeCloseTo(12.1);                       // 0.2 s back: on the reference's late beats
    // Past two seconds of that, the hold ends.
    const long: BeatGrid = { ...list([10, 10.5, 11, 15, 15.5, 16]), period: 0.5 };
    expect(lockStep(before.state, { ...input(13, 13, { at: 13 }), ref: { grid: long, position: 13, rate: 1 } }).rate).toBeNull();
  });
  test("the DJ's hand sets the offset, whatever else happened", () => {
    const r = lockStep(held(), input(10.15, 10.1, { at: 0.1, hand: true, snap: true }));
    expect(r).toMatchObject({ snap: false, rate: 1, state: { manual: true } });
    expect(r.state.offset).toBeCloseTo(0.1);
    expect(lockStep(r.state, input(10.25, 10.2, { at: 0.2 })).rate!).toBeCloseTo(1); // and it is held
  });
});

/** Two decks stepped through time: the reference runs free, the locked deck plays at whatever lockStep returns. */
function simulate(gaps: number[], start: { own: number; ref: number }, refGrid = G) {
  // Already holding, so the start error is the lock's to close (a hold that only starts would keep it as the offset).
  let st: LockState = { ...newLock(), holding: true, ownPos: start.own, refPos: start.ref }, own = start.own, ref = start.ref, at = 0, rate = 1, snaps = 0;
  const errors: number[] = [];
  for (const gap of [0, ...gaps]) {
    at += gap; own += rate * gap; ref += gap;
    const r = lockStep(st, { ...input(own, ref, { at }), ref: { grid: refGrid, position: ref, rate: 1 } });
    st = r.state; rate = r.rate ?? 1;
    if (r.snap) { snaps++; own = st.ownPos; }
    errors.push(phaseShift({ grid: G, position: own }, { grid: refGrid, position: ref }, st.offset)!);
  }
  return { errors, snaps };
}

describe("the lock as a loop", () => {
  test("closes a 20 ms error and holds a 0.3% tempo difference under 1 ms", () => {
    const { errors, snaps } = simulate(Array(100).fill(0.1), { own: 10.02, ref: 10 }, steady(0.5015, 10 - 20 * 0.5015));
    expect(snaps).toBe(0);
    expect(Math.abs(errors[0])).toBeCloseTo(0.02, 3);
    for (const e of errors.slice(-20)) expect(Math.abs(e)).toBeLessThan(0.001);
  });
  test("a stalled timer does not push it past the beat", () => {
    const { errors, snaps } = simulate([...Array(3).fill(0.1), 2, ...Array(100).fill(0.1)], { own: 10.025, ref: 10 });
    expect(snaps).toBe(0);
    expect(errors[4]).toBeLessThan(0);                                  // still on the same side after the 2 s gap
    expect(Math.abs(errors[4])).toBeLessThan(0.025);
    expect(Math.abs(errors[errors.length - 1])).toBeLessThan(0.002);
  });
});

describe("Sync lock in the mixer", () => {
  beforeEach(resetMixer);
  const lock = () => getMixer().syncLock;
  test("one deck at a time; off with null", () => {
    setSyncLock("A"); expect(lock()).toBe("A");
    setSyncLock("B"); expect(lock()).toBe("B");
    setSyncLock(null); expect(lock()).toBeNull();
  });
  test("the on-screen fader takes the tempo back; the other deck's fader does not", () => {
    setSyncLock("B");
    setDeckPitch("A", 0.3); expect(lock()).toBe("B");
    setDeckPitch("B", 0.1); expect(lock()).toBeNull();
    expect(getMixer().fx.B.pitch).toBe(0.1);
  });
  test("a resting physical fader keeps the lock; a real move releases it and the tempo holds until the fader reaches it", () => {
    setDeckPitchFromController("B", 0.5);                               // where the fader stands
    setDeckRangePitch("B", 0.08, -0.2); setSyncLock("B");               // Sync moved the tempo and locked
    setDeckPitchFromController("B", 0.51); setDeckPitchFromController("B", 0.49);
    expect(lock()).toBe("B"); expect(getMixer().fx.B.pitch).toBe(-0.2);
    setDeckPitchFromController("B", 0.4);                               // a real move
    expect(lock()).toBeNull(); expect(getMixer().fx.B.pitch).toBe(-0.2);
    setDeckPitchFromController("B", -0.25);                             // crossed the held value: the fader takes over
    expect(getMixer().fx.B.pitch).toBe(-0.25);
  });
  test("Sync off after a reconnect leaves the tempo with the screen until the physical fader reaches it", () => {
    setDeckPitchFromController("A", 0.5);
    setDeckRangePitch("A", 0.08, 0.1); setSyncLock("A");
    resetPickup();
    setDeckPitchFromController("A", 0.5);                               // the reconnect's status dump: the baseline
    setSyncLock(null);
    setDeckPitchFromController("A", 0.49);
    expect(getMixer().fx.A.pitch).toBe(0.1);
    setDeckPitchFromController("A", 0.05);                              // crossed
    expect(getMixer().fx.A.pitch).toBe(0.05);
  });
  test("a fader that first reports after the lock, or after a reconnect, still cannot make the tempo jump", () => {
    setDeckRangePitch("A", 0.08, 0.3); setSyncLock("A");
    resetPickup();                                                      // a MIDI reconnect forgets the pending pickup
    setDeckPitchFromController("A", -0.6);                              // first report: the baseline
    expect(lock()).toBe("A"); expect(getMixer().fx.A.pitch).toBe(0.3);
    setDeckPitchFromController("A", -0.5);
    expect(lock()).toBeNull(); expect(getMixer().fx.A.pitch).toBe(0.3);
  });
});
