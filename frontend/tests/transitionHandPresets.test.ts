// The two presets chosen by hand: «Έξοδος με echo» and «Μακριά ανάμειξη» (plan building and the echo's store driver).
import { beforeEach, describe, expect, test } from "bun:test";
import type { BeatGrid } from "../src/lib/beatGrid";
import { engage, getFxRack, release, resetFxRack, selectPreset, setAmount, setAvailable } from "../src/lib/fxRack";
import { ECHO_PRESET, startEcho } from "../src/lib/mix/echoFx";
import { resetPrefs } from "../src/lib/prefs";
import { eqAt, volumeAt } from "../src/lib/transitions/curves";
import { ECHO_AMOUNT, echoLevel, echoWindow } from "../src/lib/transitions/echoOut";
import { bassClashBars } from "../src/lib/transitions/flags";
import { planTransition, type LaneInput } from "../src/lib/transitions/planner";
import { HAND_PRESETS, PRESETS } from "../src/lib/transitions/presets";
import type { HandPreset, NamedPreset, TransitionParams } from "../src/lib/transitions/types";

const straight = (bpm = 120): BeatGrid => ({ kind: "straight", anchor: 0, period: 60 / bpm, estimated: false, overridden: false });
const lane = (o: Partial<LaneInput> = {}): LaneInput => ({ trackId: 1, grid: straight(), duration: 240, cues: [], rate: 1, onEngine: true, ...o });
const hand = (preset: HandPreset, o: Partial<TransitionParams> = {}): TransitionParams =>
  ({ ...HAND_PRESETS[preset], preset, out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...o });

describe("the echo's rise", () => {
  test("the last 8 beats before the cut at the middle; the whole first half when that is shorter", () => {
    expect(echoWindow(1 / 64)).toEqual({ fromU: 0.375, toU: 0.5 }); // 16 bars
    expect(echoWindow(1 / 8)).toEqual({ fromU: 0, toU: 0.5 });      // 2 bars
  });
  test("level: 0 before the rise, linear through it, 1 from the cut on", () => {
    const e = echoWindow(1 / 64);
    expect(echoLevel(e, 0)).toBe(0);
    expect(echoLevel(e, 0.375)).toBe(0);
    expect(echoLevel(e, 0.4375)).toBeCloseTo(0.5, 9);
    expect(echoLevel(e, 0.5)).toBe(1);
    expect(echoLevel(e, 0.9)).toBe(1);
    expect(echoLevel({ fromU: 0.5, toU: 0.5 }, 0.49)).toBe(0);
  });
});

describe("«Έξοδος με echo»: the plan", () => {
  test("16 bars: the outgoing deck alone until the cut at the middle, the incoming deck heard from there", () => {
    const plan = planTransition(lane(), lane(), hand("echo_out"));
    expect(plan.kind).toBe("mix");
    expect(plan.bars).toBe(16);
    expect(plan.echo).toEqual({ fromU: 0.375, toU: 0.5 });
    const { out, in: inn } = plan.curves!;
    const n = plan.curves!.n, mid = Math.ceil((n - 1) / 2);
    expect([out.volume[0], out.volume[mid - 1], out.volume[mid], out.volume[n - 1]]).toEqual([1, 1, 0, 0]);
    expect([inn.volume[0], inn.volume[mid - 1], inn.volume[mid], inn.volume[n - 1]]).toEqual([0, 0, 1, 1]);
    // The incoming deck runs silent under the first half, so it is heard 8 bars after its start: its next phrase line.
    expect(plan.inStartS + (plan.inEndS - plan.inStartS) / 2).toBeCloseTo(plan.inStartS + 16, 9);
  });
  test("the echo follows the volume curve: a custom transition keeps it, every other preset has no echo key", () => {
    expect(planTransition(lane(), lane(), hand("echo_out", { preset: "custom", eq_curve: "bass_cut_long", bars: 4 })).echo).toEqual({ fromU: 0, toU: 0.5 });
    for (const p of Object.keys(PRESETS) as NamedPreset[]) {
      expect("echo" in planTransition(lane(), lane(), { ...PRESETS[p], preset: p, out_anchor_s: null, in_anchor_s: null, tempo_match: true })).toBe(false);
    }
    expect("echo" in planTransition(lane(), lane(), hand("long_blend"))).toBe(false);
    expect(volumeAt("echo_out", 0.3)).toEqual(volumeAt("center_cut", 0.3));
  });
  test("a plan that falls back to a cut has no echo", () => {
    const plan = planTransition(lane({ grid: null }), lane(), hand("echo_out"));
    expect(plan.kind).toBe("cut");
    expect("echo" in plan).toBe(false);
  });
});

describe("«Μακριά ανάμειξη»: the plan", () => {
  test("32 bars when both tracks have room, halved until it fits when one has not", () => {
    expect(planTransition(lane(), lane(), hand("long_blend")).bars).toBe(32);
    expect(planTransition(lane(), lane({ duration: 40 }), hand("long_blend")).bars).toBe(16);
    expect(planTransition(lane({ duration: 20 }), lane(), hand("long_blend")).bars).toBe(8);
  });
  test("staged EQ: the incoming deck enters without lows, the basses swap at the middle, the outgoing mids and highs leave last", () => {
    const at = (u: number) => eqAt("bass_swap_staged", u, 1 / 128);
    expect(at(0)).toEqual({ out: { lo: 0, mid: 0, hi: 0 }, in: { lo: -1, mid: 0, hi: 0 } });
    expect(at(0.44)).toEqual(at(0));
    expect(at(0.5).out.lo).toBeCloseTo(-0.5, 9);
    expect(at(0.5).in.lo).toBeCloseTo(-0.5, 9);
    expect(at(0.56)).toEqual({ out: { lo: -1, mid: 0, hi: 0 }, in: { lo: 0, mid: 0, hi: 0 } });
    expect(at(0.75).out).toEqual({ lo: -1, mid: 0, hi: 0 });
    expect(at(0.875).out.mid).toBeCloseTo(-0.5, 9);
    expect(at(1)).toEqual({ out: { lo: -1, mid: -1, hi: -1 }, in: { lo: 0, mid: 0, hi: 0 } });
    // The incoming deck fades in over the first half and the outgoing one stays up to the end (the EQ takes it out).
    expect(volumeAt(HAND_PRESETS.long_blend.volume_curve, 0.25)).toEqual({ out: 1, in: 0.5 });
    expect(volumeAt(HAND_PRESETS.long_blend.volume_curve, 0.99).out).toBe(1);
  });
  test("two bass sections under the whole window: the swap keeps «Δύο μπάσα μαζί» away", () => {
    const structure = { sections: [{ start_s: 0, beats: 480, bass: true, level: 1 }], quality: 1 };
    const flagLane = { grid: straight(), structure };
    const w = { outStartS: 120, inStartS: 0, bars: 32, rateIn: null };
    expect(bassClashBars(flagLane, flagLane, hand("long_blend"), w)).toBeNull();
    expect(bassClashBars(flagLane, flagLane, { ...hand("long_blend"), eq_curve: "none" }, w)).not.toBeNull();
  });
});

describe("the echo's FX rack driver", () => {
  beforeEach(() => { resetPrefs(); resetFxRack(); });

  test("on at amount 0 with the rack's Echo, rises with the level, and the deck's own preset and amount come back", () => {
    selectPreset("A", "flanger");
    setAmount("A", 0.4);
    const run = startEcho("A")!;
    expect(getFxRack().decks.A).toMatchObject({ preset: ECHO_PRESET, amount: 0, on: true, held: false });
    expect(getFxRack().decks.B.on).toBe(false);
    run.level(0.5);
    expect(getFxRack().decks.A.amount).toBeCloseTo(ECHO_AMOUNT / 2, 9);
    run.level(1);
    expect(getFxRack().decks.A.amount).toBe(ECHO_AMOUNT);
    run.end();
    expect(getFxRack().decks.A).toMatchObject({ preset: "flanger", amount: 0.4, on: false });
    run.level(1); run.end(); // nothing after the end
    expect(getFxRack().decks.A).toMatchObject({ preset: "flanger", amount: 0.4, on: false });
  });

  test("no echo when the rack is unavailable or the deck's effect is already on", () => {
    engage("A", "latch");
    const before = getFxRack().decks.A;
    expect(startEcho("A")).toBeNull();
    expect(getFxRack().decks.A).toBe(before);
    setAvailable(false);
    expect(startEcho("B")).toBeNull();
    expect(getFxRack().decks.B.on).toBe(false);
  });

  test("the user takes the effect over (a release, another preset): the driver lets go and restores nothing", () => {
    const released = startEcho("A")!;
    release("A");
    released.level(1);
    released.end();
    expect(getFxRack().decks.A).toMatchObject({ preset: ECHO_PRESET, amount: 0, on: false });
    const switched = startEcho("B")!;
    selectPreset("B", "reverb");
    switched.level(1);
    switched.end();
    expect(getFxRack().decks.B).toMatchObject({ preset: "reverb", amount: 0, on: true });
  });
});
