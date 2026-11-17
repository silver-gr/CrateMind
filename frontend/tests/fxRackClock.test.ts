import { describe, expect, test } from "bun:test";
import { positionAt, type Anchor, type EngineLoop } from "../src/lib/audio/stretchDeck";
import { beatPosition, type BeatGrid } from "../src/lib/beatGrid";
import { camelotRoot } from "../src/lib/camelot";
import {
  LIST_LOW, PHI_UNTRUSTED, beatAt, engineClock, loopStep, phiBeat, plainClock, releaseBeat, wrapAt,
  type DeckBeat, type EngineView,
} from "../src/lib/fxRackClock";

const FS = 48000;
const P = 60 / 145;
const straight: BeatGrid = { kind: "straight", anchor: 0.5, period: P, estimated: false, overridden: false };
// Two tempo sections: 64 beats at 140 BPM, then 64 at 150 (a list grid, downbeat at index 0).
const times = Array.from({ length: 129 }, (_, i) => i <= 64 ? i * 60 / 140 : 64 * 60 / 140 + (i - 64) * 60 / 150);
const list: BeatGrid = { kind: "list", times, downIndex: 0, estimated: false, overridden: false };

const anchorAt = (input: number, output = 0, rate = 1, active = true): Anchor => ({ input, output, rate, active });
function view(anchor: Anchor, o: Partial<EngineView> = {}): EngineView {
  return { anchor, loop: null, duration: 400, grid: straight, comp: 0, wrapBase: 0, now: 0, sampleRate: FS, ...o };
}
const knotsOf = (v: EngineView) => engineClock(v, 145, false);

describe("engine clock knots", () => {
  test("a straight grid sends 2 knots, 8 beats apart, at tempo × rate from now, valid from the anchor", () => {
    const v = view(anchorAt(10, 2, 1.04), { comp: 0.005, now: 5 });
    const { msg, horizon } = knotsOf(v);
    const k = msg.knots!;
    expect(k).toHaveLength(4);
    expect(horizon).toBeNull();
    expect(msg).toMatchObject({ t: "clock", validFrom: Math.round(2.005 * FS), playing: true, bpm: 145, rate: 1.04, trusted: true, seek: false });
    expect(k[0]).toBe(5 * FS);
    expect(k[1]).toBeCloseTo(beatPosition(straight, 10 + (5 - 0.005 - 2) * 1.04), 9);
    expect(k[3] - Math.floor(k[1])).toBeCloseTo(8, 3);
    // Each knot's B is taken at its rounded frame, so the slope is exact.
    expect((k[3] - k[1]) / (k[2] - k[0])).toBeCloseTo(1.04 / P / FS, 15);
  });

  test("a pending anchor starts the knots at its own output plus the limiter latency (comp per path)", () => {
    for (const comp of [0, 240 / FS, (240 + 1024) / FS]) {
      const { msg } = knotsOf(view(anchorAt(20, 6), { comp, now: 5 }));
      expect(msg.validFrom).toBe(Math.round((6 + comp) * FS));
      expect(msg.knots![0]).toBe(msg.validFrom);
      expect(msg.knots![1]).toBeCloseTo(beatPosition(straight, 20), 9);
    }
  });

  test("a list grid sends the next 8 beats on its own beat times and asks for more at 4 or fewer", () => {
    const v = view(anchorAt(times[60] + 0.1, 1, 1), { grid: list, now: 1 });
    const { msg, horizon } = knotsOf(v);
    const k = msg.knots!;
    expect(k).toHaveLength(18);
    for (let i = 1; i <= 8; i++) {
      expect(k[2 * i + 1]).toBeCloseTo(60 + i, 3);
      expect(k[2 * i]).toBe(Math.round((1 + times[60 + i] - (times[60] + 0.1)) * FS));
    }
    expect(horizon).toBe(k[17]);
    expect(horizon!).toBeCloseTo(68, 3);
    // Steady playback: more knots are due once B is within LIST_LOW beats of the last one.
    const due = (t: number) => beatAt(v, t) >= horizon! - LIST_LOW;
    expect(due(1 + times[63] - times[60] - 0.1)).toBe(false);
    expect(due(1 + times[64] - times[60] - 0.1 + 0.01)).toBe(true);
  });

  test("paused: flat knots, not playing", () => {
    const { msg, horizon } = knotsOf(view(anchorAt(30, 4, 1, false), { now: 9 }));
    expect(msg.playing).toBe(false);
    expect(msg.knots![1]).toBe(msg.knots![3]);
    expect(msg.knots![2]).toBeGreaterThan(msg.knots![0]);
    expect(horizon).toBeNull();
  });

  test("a wrap less than a frame ahead still leaves a second knot with the playing slope", () => {
    const loop = { start: 16 * P + straight.anchor, end: 16.125 * P + straight.anchor };
    const k = knotsOf(view(anchorAt(loop.start), { loop, now: 0.125 * P - 0.2 / FS })).msg.knots!;
    expect(k).toHaveLength(4);
    expect((k[3] - k[1]) / (k[2] - k[0])).toBeCloseTo(1 / P / FS, 12);
  });

  test("the element deck sends no knots, its BPM and rate 1, untrusted", () => {
    expect(plainClock(2, FS, true, 145, 1, true)).toEqual({ t: "clock", validFrom: 2 * FS, playing: true, knots: null, bpm: 145, rate: 1, trusted: false, seek: true });
  });

  test("an untrusted (estimated) grid is flagged", () => {
    expect(knotsOf(view(anchorAt(10), { grid: { ...straight, estimated: true } })).msg.trusted).toBe(false);
    expect(knotsOf(view(anchorAt(10), { grid: { ...straight, estimated: true, overridden: true } })).msg.trusted).toBe(true);
  });
});

describe("B inside loops", () => {
  const loopOf = (start: number, beats: number, grid = straight): EngineLoop =>
    ({ start, end: grid.kind === "straight" ? start + beats * grid.period : start + beats * 0.4 });

  test("B is read at the wrapped position (a loop in a list grid's second tempo section) and stays continuous", () => {
    const loop = { start: times[80], end: times[84] }; // 4 beats at 150 BPM
    const v = view(anchorAt(loop.start), { grid: list, loop });
    expect(loopStep(list, loop)).toBe(4);
    for (const t of [0.1, 0.9, 1.7, 4.05]) {
      expect(beatAt(v, t)).toBeCloseTo(80 + t * 150 / 60, 9);
      // The position itself is the wrapped one.
      expect(positionAt(v.anchor, t, 400, loop)).toBeLessThan(loop.end);
    }
  });

  test("a 4 b loop and a ⅛ b roll keep B seamless across wraps; knots end at the wrap", () => {
    for (const beats of [4, 1 / 8]) {
      const loop = loopOf(straight.anchor + 16 * P, beats);
      const v = view(anchorAt(loop.start), { loop });
      expect(loopStep(straight, loop)).toBeCloseTo(beats, 12);
      for (let t = 0.013; t < 6; t += 0.37) expect(beatAt(v, t)).toBeCloseTo(16 + t / P, 6);
      if (beats < 1) {
        const { msg, horizon } = knotsOf({ ...v, now: 0.01 });
        expect(msg.knots).toHaveLength(4);
        expect(msg.knots![2]).toBe(Math.round(beats * P * FS));
        expect(msg.knots![3]).toBeCloseTo(16 + beats, 4);
        expect(horizon).toBeNull();
      }
    }
  });

  test("a 2.7 b manual loop steps B by 0.3 b at each wrap and keeps the audio's beat phase", () => {
    const loop = loopOf(straight.anchor + 10.25 * P, 2.7);
    const v = view(anchorAt(loop.start), { loop });
    expect(loopStep(straight, loop)).toBe(3);
    const wrapT = 2.7 * P;
    for (const [t, wraps] of [[wrapT - 0.01, 0], [wrapT + 0.01, 1], [2 * wrapT + 0.01, 2]] as const) {
      const b = beatAt(v, t);
      expect(b - (10.25 + t / P)).toBeCloseTo(0.3 * wraps, 9);
      const audio = beatPosition(straight, positionAt(v.anchor, t, 400, loop));
      expect(b - Math.floor(b)).toBeCloseTo(audio - Math.floor(audio), 9);
    }
  });

  test("a rate change or clearLoop() inside a loop does not move B", () => {
    const loop = loopOf(straight.anchor + 32 * P, 4);
    const comp = 0.005;
    const old = view(anchorAt(loop.start, 0, 1), { loop, comp });
    const T = 3 * 4 * P + 0.2; // after 3 wraps
    const before = beatAt(old, T + comp);
    const wrapBase = wrapAt(old, T + comp);
    expect(wrapBase).toBe(12);
    // stretchDeck rebases a running anchor at the wrapped position, so W carries the wraps so far.
    const input = positionAt(old.anchor, T, 400, loop);
    const faster = view(anchorAt(input, T, 1.1), { loop, comp, wrapBase });
    const cleared = view(anchorAt(input, T, 1), { loop: null, comp, wrapBase });
    expect(beatAt(faster, T + comp)).toBeCloseTo(before, 9);
    expect(beatAt(cleared, T + comp)).toBeCloseTo(before, 9);
    expect(beatAt(cleared, T + comp + 1)).toBeCloseTo(before + 1 / P, 9);
    expect(beatAt(faster, T + comp + 0.1)).toBeCloseTo(before + 0.11 / P, 9);
  });
});

describe("release beats", () => {
  // 120 BPM from 0:00, measured phrase lines at bars 5, 13 and 21 (8 s, 24 s, 40 s).
  const grid: BeatGrid = { kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false, phrases: [8, 24, 40] };
  const at = (position: number, o: Partial<DeckBeat> = {}): DeckBeat =>
    ({ grid, trusted: true, position, wrap: 0, playing: true, looping: false, ...o });

  test("phrase: the next measured line on a downbeat, plus W", () => {
    expect(releaseBeat(at(9), "phrase")).toBe(48);
    expect(releaseBeat(at(9, { wrap: 6 }), "phrase")).toBe(54);
    expect(releaseBeat(at(9, { grid: { ...grid, phrases: [8, 24.25, 40] } }), "phrase")).toBe(80); // 24.25 s is no downbeat
    expect(releaseBeat(at(41), "phrase")).toBe(84); // no line ahead: the next bar
    expect(releaseBeat(at(9), "bar")).toBe(20);
  });

  test("without measured lines: the waveform's fallback, every 4 bars from bar 1", () => {
    const plain = { ...grid, phrases: undefined };
    expect(releaseBeat(at(9, { grid: plain }), "phrase")).toBe(32);
    expect(releaseBeat(at(16, { grid: plain }), "phrase")).toBe(48);
    expect(releaseBeat(at(-1.5, { grid: plain }), "phrase")).toBe(0);
  });

  test("an untrusted clock waits for the node's next bar; paused, looping or no tempo release now", () => {
    expect(releaseBeat(at(9, { trusted: false }), "phrase")).toBe("bar");
    expect(releaseBeat(at(0, { grid: null, trusted: false }), "phrase")).toBe("bar");
    expect(releaseBeat(at(9, { playing: false }), "phrase")).toBeNull();
    expect(releaseBeat(at(9, { looping: true }), "phrase")).toBeNull();
    expect(releaseBeat(null, "phrase")).toBeNull();
  });

  test("Φ ramps to the phrase line even while paused or looping, or 16 beats untrusted", () => {
    expect(phiBeat(at(9))).toBe(48);
    expect(phiBeat(at(9, { playing: false }))).toBe(48);
    expect(phiBeat(at(9, { looping: true, wrap: 4 }))).toBe(52);
    expect(phiBeat(at(9, { trusted: false }))).toBe(PHI_UNTRUSTED);
    expect(phiBeat(null)).toBeNull();
  });
});

test("camelotRoot resolves key_text, else key_analyzed, without a leading ~", () => {
  expect(camelotRoot("8A")).toEqual({ pc: 9, minor: true });
  expect(camelotRoot("12B")).toEqual({ pc: 4, minor: false });
  expect(camelotRoot("C")).toEqual({ pc: 0, minor: false });
  expect(camelotRoot("1A")).toEqual({ pc: 8, minor: true });
  expect(camelotRoot(null, "~F#m")).toEqual({ pc: 6, minor: true });
  expect(camelotRoot("  ", "Gbm")).toEqual({ pc: 6, minor: true });
  expect(camelotRoot("Am", "C")).toEqual({ pc: 9, minor: true });
  expect(camelotRoot("xyz")).toBeNull();
  expect(camelotRoot(null, null)).toBeNull();
});
