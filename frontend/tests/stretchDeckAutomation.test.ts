import { afterEach, beforeAll, expect, test } from "bun:test";
import { FILTER_Q_DB } from "../src/lib/mixer";
import { type Ctx, installLocation, setup, teardown } from "./stretchDeckFakes";

beforeAll(installLocation);
afterEach(teardown);

const F32 = (values: number[]) => new Float32Array(values);
const list = (curve: unknown) => Array.from(curve as Float32Array);
/** The stage in signal order: [auto.gain, lo, mid, hi, hp, lp]. */
const stage = (ctx: Ctx) => {
  const [lo, mid, hi, hp, lp] = ctx.filters;
  return { gain: ctx.gains[2], lo, mid, hi, hp, lp };
};
const params = (ctx: Ctx) => {
  const s = stage(ctx);
  return [s.gain.gain, s.lo.gain, s.mid.gain, s.hi.gain, s.hp.frequency, s.lp.frequency];
};

test("the constructor builds a neutral stage between the fade and the output", () => {
  const { deck, ctx } = setup();
  const [output, fade] = ctx.gains;
  const s = stage(ctx);
  expect(deck.output).toBe(output as unknown as GainNode);
  expect(ctx.gains.length).toBe(3);
  expect(fade.connected).toEqual([s.gain]);
  expect(s.gain.connected).toEqual([s.lo]);
  expect(s.lo.connected).toEqual([s.mid]);
  expect(s.mid.connected).toEqual([s.hi]);
  expect(s.hi.connected).toEqual([s.hp]);
  expect(s.hp.connected).toEqual([s.lp]);
  expect(s.lp.connected).toEqual([output]);
  expect(s.gain.gain.value).toBe(1);
  expect([s.lo.type, s.lo.frequency.value, s.lo.gain.value]).toEqual(["lowshelf", 250, 0]);
  expect([s.mid.type, s.mid.frequency.value, s.mid.Q.value, s.mid.gain.value]).toEqual(["peaking", 1000, 0.7, 0]);
  expect([s.hi.type, s.hi.frequency.value, s.hi.gain.value]).toEqual(["highshelf", 4000, 0]);
  expect([s.hp.type, s.hp.frequency.value, s.hp.Q.value]).toEqual(["highpass", 0, FILTER_Q_DB]);
  expect([s.lp.type, s.lp.frequency.value, s.lp.Q.value]).toEqual(["lowpass", 24000, FILTER_Q_DB]);
});

test("scheduleAutomation cancels at `at` and sets value curves; eq through eqDb, filter resampled into hp/lp", async () => {
  const { deck, ctx, load } = setup();
  expect(deck.scheduleAutomation({ at: 5, duration: 4, volume: F32([1, 0.7, 0]) })).toBe(false);
  await load();
  const s = stage(ctx);
  const ok = deck.scheduleAutomation({ at: 5, duration: 4, volume: F32([1, 0.7, 0]), eq: { lo: F32([0, -1]) }, filter: F32([0, -1]) });
  expect(ok).toBe(true);
  const [cancel, curve] = s.gain.gain.calls;
  expect(cancel).toEqual(["cancel", 5]);
  expect(curve[0]).toBe("curve");
  expect(curve[1]).toBeInstanceOf(Float32Array);
  expect(list(curve[1])).toEqual(list(F32([1, 0.7, 0])));
  expect(curve.slice(2)).toEqual([5, 4]);

  expect(s.lo.gain.calls[0]).toEqual(["cancel", 5]);
  expect(s.lo.gain.calls[1][0]).toBe("curve");
  expect(list(s.lo.gain.calls[1][1])).toEqual([0, -26]);
  expect(s.lo.gain.calls[1].slice(2)).toEqual([5, 4]);

  const lp = s.lp.frequency.calls;
  expect(lp[0]).toEqual(["cancel", 5]);
  const lpCurve = lp[1][1] as Float32Array;
  expect(lpCurve).toBeInstanceOf(Float32Array);
  expect(lpCurve.length).toBeGreaterThanOrEqual(64);
  expect(lpCurve[0]).toBe(24000);
  expect(lpCurve[lpCurve.length - 1]).toBeCloseTo(60, 3);
  expect(lp[1].slice(2)).toEqual([5, 4]);
  // Monotonic sweep down: the knob is resampled before the exponential mapping.
  for (let i = 1; i < lpCurve.length; i++) expect(lpCurve[i]).toBeLessThanOrEqual(lpCurve[i - 1]);

  expect(s.hp.frequency.calls).toEqual([]);
  expect(s.mid.gain.calls).toEqual([]);
  expect(s.hi.gain.calls).toEqual([]);
});

test("a high-pass knob curve drives the hp frequency and leaves the lp alone", async () => {
  const { deck, ctx, load } = setup();
  await load();
  const s = stage(ctx);
  expect(deck.scheduleAutomation({ at: 5, duration: 2, filter: F32([0, 0.5, 1]) })).toBe(true);
  const hpCurve = s.hp.frequency.calls[1][1] as Float32Array;
  expect(hpCurve.length).toBeGreaterThanOrEqual(64);
  expect(hpCurve[0]).toBe(0);
  expect(hpCurve[hpCurve.length - 1]).toBeCloseTo(8000, 1);
  expect(s.lp.frequency.calls).toEqual([]);
  expect(s.gain.gain.calls).toEqual([]);
});

test("scheduleAutomation refuses a bad window or a curve with fewer than two points", async () => {
  const { deck, ctx, load } = setup();
  await load();
  expect(deck.scheduleAutomation({ at: 5, duration: 0, volume: F32([1, 0]) })).toBe(false);
  expect(deck.scheduleAutomation({ at: Number.NaN, duration: 2, volume: F32([1, 0]) })).toBe(false);
  expect(deck.scheduleAutomation({ at: 5, duration: 2, volume: F32([1]) })).toBe(false);
  expect(deck.scheduleAutomation({ at: 5, duration: 2, eq: { hi: F32([]) } })).toBe(false);
  for (const p of params(ctx)) expect(p.calls).toEqual([]);
});

test("cancelAutomation neutral holds then glides every stage param to neutral, snapping the filters", async () => {
  const { deck, ctx, load } = setup();
  await load();
  const s = stage(ctx);
  deck.cancelAutomation("neutral");
  expect(s.gain.gain.calls).toEqual([["hold", 10], ["target", 1, 10, 0.015]]);
  expect(s.lo.gain.calls).toEqual([["hold", 10], ["target", 0, 10, 0.015]]);
  expect(s.mid.gain.calls).toEqual([["hold", 10], ["target", 0, 10, 0.015]]);
  expect(s.hi.gain.calls).toEqual([["hold", 10], ["target", 0, 10, 0.015]]);
  expect(s.hp.frequency.calls).toEqual([["hold", 10], ["target", 0, 10, 0.015], ["set", 0, 10.1]]);
  expect(s.lp.frequency.calls).toEqual([["hold", 10], ["target", 24000, 10, 0.015], ["set", 24000, 10.1]]);
});

test("cancelAutomation neutral at a later time uses it; hold only holds", async () => {
  const { deck, ctx, load } = setup();
  await load();
  const s = stage(ctx);
  deck.cancelAutomation("neutral", 10.05);
  expect(s.gain.gain.calls).toEqual([["hold", 10.05], ["target", 1, 10.05, 0.015]]);
  expect(s.lp.frequency.calls[2][2]).toBeCloseTo(10.15);
  for (const p of params(ctx)) p.calls.length = 0;
  deck.cancelAutomation("hold");
  for (const p of params(ctx)) expect(p.calls).toEqual([["hold", 10]]);
});

test("dispose disconnects the stage", () => {
  const { deck, ctx } = setup();
  deck.dispose();
  const s = stage(ctx);
  for (const n of [s.gain, s.lo, s.mid, s.hi, s.hp, s.lp]) expect(n.disconnects).toBeGreaterThan(0);
});
