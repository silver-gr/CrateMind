import { beforeEach, describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { LOCK_TRIM, gridFits, lockStep, loopKeepsBeats, newLock, phaseOffset, phaseShift, type LockInput, type LockState } from "../src/lib/deckSync";
import { simulateLock } from "./syncLockSim";
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

describe("octave fold in the lock", () => {
  const P = 60 / 138;                                                   // the other deck: 138 BPM
  const fast = steady(P / 2), slow = steady(P);                         // the same beats counted at 276 and at 138
  test("phase: every second beat of a double-counted grid is a beat; the shift is in that deck's own seconds", () => {
    // 276 against 138: on an odd beat of its own grid the deck is half a (138) beat out, one own beat either way.
    expect(Math.abs(phaseShift({ grid: fast, position: 21 * P / 2 }, { grid: slow, position: 10 * P }, 0, 0.5)!)).toBeCloseTo(P / 2);
    expect(phaseShift({ grid: fast, position: 20 * P / 2 }, { grid: slow, position: 10 * P }, 0, 0.5)).toBeCloseTo(0);
    expect(phaseShift({ grid: fast, position: 20 * P / 2 + 0.01 }, { grid: slow, position: 10 * P }, 0, 0.5)).toBeCloseTo(-0.01);
    expect(phaseOffset({ grid: fast, position: 20 * P / 2 + 0.01 }, { grid: slow, position: 10 * P }, 0.5)).toBeCloseTo(0.01 / P);
    // 69 against 138: counted in its own (coarser) beats, on every second beat of the other deck.
    const half = steady(2 * P);
    expect(phaseShift({ grid: half, position: 8 * P }, { grid: slow, position: 10 * P }, 0, 2)).toBeCloseTo(0);
    expect(phaseShift({ grid: half, position: 8 * P - 0.01 }, { grid: slow, position: 10 * P }, 0, 2)).toBeCloseTo(0.01);
    expect(Math.abs(phaseShift({ grid: half, position: 7 * P }, { grid: slow, position: 10 * P }, 0, 2)!)).toBeCloseTo(P);
  });
  test("phase: 138 against a 276 grid counts every second beat of the other deck, so an off-beat is never a beat", () => {
    // The locked deck on a beat of its own 138 grid, the other deck on an odd beat of its 276 grid: half a real beat out.
    expect(Math.abs(phaseShift({ grid: slow, position: 10 * P }, { grid: fast, position: 21 * P / 2 }, 0, 2)!)).toBeCloseTo(P / 2);
    expect(Math.abs(phaseOffset({ grid: slow, position: 10 * P }, { grid: fast, position: 21 * P / 2 }, 2)!)).toBeCloseTo(0.5);
    expect(phaseShift({ grid: slow, position: 10 * P }, { grid: fast, position: 20 * P / 2 }, 0, 2)).toBeCloseTo(0);
    expect(phaseShift({ grid: slow, position: 10 * P + 0.01 }, { grid: fast, position: 20 * P / 2 }, 0, 2)).toBeCloseTo(-0.01);
  });
  test("rate: the folded beat length is followed, so the deck stays at the other deck's speed", () => {
    const sides = { own: { grid: fast, position: 20 * P / 2, rate: 1 }, ref: { grid: slow, position: 10 * P, rate: 1 } };
    expect(lockStep(newLock(), { ...input(0, 0), ...sides, fold: 0.5 })).toMatchObject({ rate: 1, base: 1, snap: false });
    expect(lockStep(newLock(), { ...input(0, 0), ...sides }).rate).toBeNull();   // without the fold: half speed, not followed
    const up = lockStep(newLock(), { ...input(0, 0), own: { grid: steady(2 * P), position: 6 * P, rate: 1 }, ref: sides.ref, fold: 2 });
    expect(up).toMatchObject({ rate: 1, base: 1 });
  });
  test("as a loop: 276 against 138 closes a 15 ms error without a jump, and a seek lands on a 138 beat", () => {
    const closed = simulateLock({ step: lockStep, own: { grid: fast, position: 40 * P / 2 + 0.015 }, ref: { grid: slow, position: 10 * P }, seconds: 15, fold: 0.5 });
    expect(closed.snaps).toBe(0);
    expect(Math.abs(closed.errors[0])).toBeCloseTo(0.015, 4);
    for (const e of closed.errors.slice(-20)) expect(Math.abs(e)).toBeLessThan(0.0005);
    const sought = simulateLock({ step: lockStep, own: { grid: fast, position: 40 * P / 2 }, ref: { grid: slow, position: 10 * P }, seconds: 10, fold: 0.5, seek: { at: 5, to: 63.3 } });
    expect(sought.snaps).toBe(1);
    for (const e of sought.errors.slice(51)) expect(Math.abs(e)).toBeLessThan(1e-6);
    // The beat it lands on is an even one of its own grid: bar lines stay on bar lines.
    const beat = (sought.state.ownPos - sought.state.refPos) / P;       // both grids start at 0: whole 138 beats apart
    expect(Math.abs(beat - Math.round(beat))).toBeLessThan(1e-6);
  });
});

describe("the locked deck's own loop", () => {
  const loop = { start: 20, end: 22 };                                  // 4 beats of G
  test("loopKeepsBeats: whole beats, counted after the fold", () => {
    expect(loopKeepsBeats(G, loop)).toBe(true);
    expect(loopKeepsBeats(G, { start: 20, end: 20.25 })).toBe(false);   // half a beat
    expect(loopKeepsBeats(G, { start: 20.1, end: 21.1 })).toBe(true);   // not on the beat, still whole beats long
    expect(loopKeepsBeats(G, { start: 20, end: 20.5 }, 0.5)).toBe(false); // one beat of a double-counted grid is half a beat
    expect(loopKeepsBeats(G, { start: 20, end: 21 }, 0.5)).toBe(true);
    expect(loopKeepsBeats(G, { start: 20, end: 20.25 }, 2)).toBe(false); // with ×2 the deck's own beats are counted
    expect(loopKeepsBeats(G, { start: 20, end: 20.5 }, 2)).toBe(true);
  });
  test("the wrap is not a transport move: no jump, the beats stay held, a tempo difference is still trimmed", () => {
    const r = simulateLock({ step: lockStep, own: { grid: G, position: 20.004, loop }, ref: { grid: G, position: 30 }, seconds: 60, drift: 2e-4 });
    expect(r.snaps).toBe(0);
    expect(r.state.offset).toBe(0);
    for (const e of r.errors.slice(-100)) expect(Math.abs(e)).toBeLessThan(0.0002);
    // Without the lock the same deck is 12 ms out after those 60 s.
    const free = simulateLock({ step: () => ({ state: newLock(), rate: null, base: null, snap: false }), own: { grid: G, position: 20, loop }, ref: { grid: G, position: 30 }, seconds: 60, drift: 2e-4 });
    expect(Math.abs(free.errors[free.errors.length - 1])).toBeCloseTo(0.012, 3);
  });
  test("a looping deck is never jumped: a large error becomes the held offset", () => {
    const far = lockStep(held({ ownPos: 21.9 }), input(20.15, 10.1, { at: 0.1, loop: true, snap: true }));
    expect(far).toMatchObject({ snap: false, rate: 1 });
    expect(far.state.offset).toBeCloseTo(0.1);
    const near = lockStep(held({ ownPos: 21.9 }), input(20.11, 10.1, { at: 0.1, loop: true }));  // wrapped, 10 ms late
    expect(near.snap).toBe(false);
    expect(near.state.offset).toBe(0);
    expect(near.rate!).toBeCloseTo(1 - LOCK_TRIM, 9);
  });
});

describe("the lock measured (why there is no deadband and no quicker re-snap)", () => {
  const P = 60 / 138, base = { own: { grid: steady(P), position: 10 * P }, ref: { grid: steady(P), position: 20 * P }, seconds: 120 };
  /** The lock with a deadband: no trim until the error passes `on`, then until it is back under `off`. */
  const deadband = (on: number, off: number) => {
    let active = false;
    return (st: LockState, i: LockInput) => {
      const r = lockStep(st, i);
      if (r.rate === null || r.base === null || r.snap) return r;
      const e = Math.abs(phaseShift(i.own, i.ref, r.state.offset, i.fold ?? 1) ?? 0);
      active = active ? e > off : e > on;
      return active ? r : { ...r, rate: r.base, state: { ...r.state, ownRate: r.base } };
    };
  };
  const mean = (xs: number[]) => xs.slice(50).reduce((s, x) => s + Math.abs(x), 0) / (xs.length - 50);
  test("a tempo difference: the lock holds it at 0.1 ms; a 2 ms deadband lets it sit at 1.5 ms and works the tempo harder", () => {
    const now = simulateLock({ ...base, step: lockStep, drift: 2e-4 });
    const dead = simulateLock({ ...base, step: deadband(0.002, 0.001), drift: 2e-4 });
    expect(mean(now.errors)).toBeCloseTo(0.0001, 5);
    expect(mean(dead.errors)).toBeGreaterThan(0.001);
    expect(dead.rateTravel).toBeGreaterThan(100 * now.rateTravel);
  });
  test("a playhead read 1.5 ms off: the lock stays under 1 ms without a deadband", () => {
    const now = simulateLock({ ...base, step: lockStep, jitter: 0.0015 });
    expect(Math.max(...now.errors.map(Math.abs))).toBeLessThan(0.001);
    expect(now.flam).toBe(0);
  });
  test("the locked deck's own seek is on the beat in the same step", () => {
    const r = simulateLock({ ...base, step: lockStep, seconds: 10, seek: { at: 5, to: 100.123 } });
    expect(r.snaps).toBe(1);
    expect(Math.abs(r.errors[50])).toBeLessThan(1e-6);                  // the first tick after the seek
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
