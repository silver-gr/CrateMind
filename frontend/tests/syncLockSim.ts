// A closed-loop model of the Sync lock for tests: the reference deck runs free, the locked deck plays at whatever the
// lock step returns, and every tick the true beat error is noted. Deterministic (the read jitter is seeded).
import type { BeatGrid } from "../src/lib/beatGrid";
import { newLock, phaseShift, type LockInput, type LockResult, type LockState } from "../src/lib/deckSync";

export type LockSim = {
  step: (st: LockState, i: LockInput) => LockResult;
  own: { grid: BeatGrid; position: number; loop?: { start: number; end: number } };
  ref: { grid: BeatGrid; position: number; rate?: number };
  seconds: number;
  /** Seconds between lock steps (the app's timer: 0.1). */
  tick?: number;
  fold?: number;
  /** The locked deck's engine runs this fraction off the rate it was given. */
  drift?: number;
  /** The locked deck's playhead is read up to this many seconds off (uniform, seeded). */
  jitter?: number;
  /** The DJ seeks the locked deck `to` at time `at`. */
  seek?: { at: number; to: number };
  /** False: the hold only starts at the first step (the start offset is kept). Default: already holding, so the start
   * error is the lock's to close. */
  holding?: boolean;
};
export type LockSimResult = {
  /** Seconds the locked deck is from the beat it is held on at each tick, read before that tick's step. */
  errors: number[];
  snaps: number;
  /** Seconds spent more than 10 ms off the beat: two kicks heard apart. */
  flam: number;
  /** Rate changes added up (0.01 = 1%): how much the lock works the tempo. */
  rateTravel: number;
  state: LockState;
};

export function simulateLock(o: LockSim): LockSimResult {
  const tick = o.tick ?? 0.1, fold = o.fold ?? 1, refRate = o.ref.rate ?? 1, loop = o.own.loop ?? null;
  let seed = 12345;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 2 ** 32 * 2 - 1) * (o.jitter ?? 0); };
  const wrap = (p: number) => loop && p >= loop.end ? loop.start + (p - loop.start) % (loop.end - loop.start) : p;
  let own = o.own.position, ref = o.ref.position, rate = refRate, snaps = 0, flam = 0, rateTravel = 0;
  let st: LockState = o.holding === false ? newLock() : { ...newLock(), holding: true, ownPos: own, refPos: ref, ownRate: rate, refRate };
  const errors: number[] = [];
  for (let n = 0, at = 0; at <= o.seconds; at = ++n * tick) {
    if (n > 0) { own = wrap(own + rate * (1 + (o.drift ?? 0)) * tick); ref += refRate * tick; }
    const sought = o.seek != null && Math.abs(at - o.seek.at) < tick / 2;
    if (sought) own = o.seek!.to;
    const error = phaseShift({ grid: o.own.grid, position: own }, { grid: o.ref.grid, position: ref }, st.offset, fold) ?? 0;
    if (!sought) { errors.push(error); if (Math.abs(error) > 0.01) flam += tick; }
    const r = o.step(st, {
      at, own: { grid: o.own.grid, position: own + noise(), rate }, ref: { grid: o.ref.grid, position: ref, rate: refRate },
      expected: refRate, canHold: true, snap: sought, hand: false, fold, loop: loop !== null,
    });
    st = r.state;
    const next = r.rate ?? refRate;
    rateTravel += Math.abs(next - rate);
    rate = next;
    if (r.snap) { snaps++; own = st.ownPos; }
  }
  return { errors, snaps, flam, rateTravel, state: st };
}
