import { beforeEach, describe, expect, test } from 'bun:test';
import { hostDelaySeconds, setHostDelayMs } from '../src/lib/hostDelay';

let now = 1e9; // far past any real performance.now() another test file may have fed the shared module
/** Advance the clock in 16 ms frames and return the smoothed value in ms. */
const run = (ms: number) => {
  const end = now + ms;
  let v = hostDelaySeconds(now) * 1000;
  while (now < end) { now = Math.min(end, now + 16); v = hostDelaySeconds(now) * 1000; }
  return v;
};

beforeEach(() => {
  now += 10_000;
  setHostDelayMs(0, now);
  hostDelaySeconds(now);
});

describe('host delay smoothing', () => {
  test('a change from 0 and to 0 snaps; invalid values count as 0; clamped to 500 ms', () => {
    setHostDelayMs(120, now);
    expect(hostDelaySeconds(now)).toBeCloseTo(0.12);
    setHostDelayMs(0, now);
    expect(hostDelaySeconds(now)).toBe(0);
    setHostDelayMs(5000, now);
    expect(hostDelaySeconds(now)).toBeCloseTo(0.5);
    for (const bad of [NaN, Infinity, -Infinity, -3]) {
      setHostDelayMs(100, now);
      setHostDelayMs(bad, now);
      expect(hostDelaySeconds(now)).toBe(0);
    }
  });

  test('a rise of more than 25 ms applies at once', () => {
    setHostDelayMs(100, now);
    setHostDelayMs(130, now);
    expect(hostDelaySeconds(now) * 1000).toBeCloseTo(130);
  });

  test('a smaller rise slews at 20 ms per second and ends exactly on the target', () => {
    setHostDelayMs(100, now);
    setHostDelayMs(120, now);
    expect(run(500)).toBeCloseTo(110, 5);
    expect(run(2000)).toBe(120);
  });

  test('a value within 3 ms of the target leaves it, so the slew still ends on the target', () => {
    setHostDelayMs(100, now);
    setHostDelayMs(90, now);
    run(200); // part way down
    setHostDelayMs(92, now); // within 3 ms of the target 90: ignored
    expect(run(2000)).toBe(90);
    setHostDelayMs(97, now); // more than 3 ms away: new target
    expect(run(2000)).toBe(97);
  });

  test('a one-window dip (500 ms) moves the value by at most 10 ms and never jumps', () => {
    setHostDelayMs(150, now);
    run(100);
    setHostDelayMs(110, now); // the mean fill dips for one stats window around an underrun
    let prev = hostDelaySeconds(now) * 1000;
    let min = prev;
    const end = now + 500;
    while (now < end) {
      now = Math.min(end, now + 16);
      const v = hostDelaySeconds(now) * 1000;
      expect(prev - v).toBeLessThanOrEqual(20 * 0.016 + 1e-9);
      min = Math.min(min, v); prev = v;
    }
    expect(150 - min).toBeLessThanOrEqual(10 + 1e-9);
    setHostDelayMs(150, now); // back up: under 25 ms below, so it slews back without a jump
    expect(hostDelaySeconds(now) * 1000).toBeCloseTo(min);
    expect(run(1000)).toBe(150);
  });

  test('the slew keeps wall time through stats while no lane draws, so a fall during a pause is done by Play', () => {
    setHostDelayMs(160, now);
    hostDelaySeconds(now);
    setHostDelayMs(110, now); // a fall while both decks are paused
    for (let i = 0; i < 10; i++) { now += 500; setHostDelayMs(110, now); } // stats only, every 500 ms, for 5 s
    expect(hostDelaySeconds(now) * 1000).toBe(110); // the first frame after Play
  });

  test('a one-window dip during a pause with no frames in between moves the value by at most 10 ms', () => {
    setHostDelayMs(150, now);
    hostDelaySeconds(now);
    for (let i = 0; i < 20; i++) { now += 500; setHostDelayMs(150, now); } // 10 s idle, no frames
    setHostDelayMs(110, now); // the dip
    now += 200;
    expect(hostDelaySeconds(now) * 1000).toBeGreaterThanOrEqual(146); // Play 200 ms into the dip: no jump to 110
    now += 300;
    setHostDelayMs(150, now); // back up after one window
    expect(hostDelaySeconds(now) * 1000).toBeGreaterThanOrEqual(140);
    expect(run(1000)).toBe(150);
  });
});
