import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { beatPhase, buildBeatGrid, gridBpm, shiftByBeats, barSeconds } from "../src/lib/beatGrid";
import { phaseShift } from "../src/lib/deckSync";
import { translateJobMessage } from "../src/lib/labels";
import { installLocation, setup, teardown } from "./stretchDeckFakes";

const straight = (bpm: number, anchor: number, deckBpm: number | null = bpm, source = "cratemind") =>
  buildBeatGrid({ bpm, straight: true, anchor_s: anchor, first_downbeat_index: 0, beats: null, source }, deckBpm, null)!;
const uneven = buildBeatGrid({ bpm: 120, straight: false, anchor_s: 0, first_downbeat_index: 0, beats: [0, 0.5, 1.1, 1.6, 2.1], source: "djay" }, null, null)!;

describe("grid tempo and octave", () => {
  test("a stored grid follows the deck's octave and keeps its downbeat", () => {
    const doubled = straight(100, 0.3, 200);
    expect(doubled).toMatchObject({ kind: "straight", period: 0.3, anchor: 0.3, source: "cratemind" });
    expect(barSeconds(doubled)).toBeCloseTo(1.2);
    expect(straight(200.02, 0.3, 100).kind === "straight" && straight(200.02, 0.3, 100).period).toBeCloseTo(60 / 100.01);
  });
  test("a tempo that is not an octave away is left alone", () => {
    expect(straight(140, 0, 120)).toMatchObject({ period: 60 / 140 });
  });
  test("a marked downbeat lands on the folded grid", () => {
    const grid = buildBeatGrid({ bpm: 100, straight: true, anchor_s: 0.3, first_downbeat_index: 0, beats: null }, 200, null, 0.9)!;
    expect(grid).toMatchObject({ period: 0.3, overridden: true });
    expect(grid.kind === "straight" && grid.anchor).toBeCloseTo(0.9);
  });
  test("gridBpm: the measured tempo when it agrees with the deck's, else null", () => {
    expect(gridBpm(straight(126.994, 0, 127), 127)).toBeCloseTo(126.994);
    expect(gridBpm(straight(140, 0, 120), 120)).toBeNull();          // a manual BPM that contradicts the grid wins
    expect(gridBpm(uneven, 120)).toBeNull();                          // flexible grids have no single tempo
    expect(gridBpm(buildBeatGrid(null, 128, 0), 128)).toBeNull();     // a plain estimate
  });
});

describe("beat phase and shift", () => {
  test("beatPhase on steady and uneven grids", () => {
    expect(beatPhase(straight(120, 1), 1.125)).toBeCloseTo(0.25);
    expect(beatPhase(straight(120, 1), 0.75)).toBeCloseTo(0.5);
    expect(beatPhase(uneven, 0.8)).toBeCloseTo(0.5);                   // halfway through the long 0.5 -> 1.1 beat
    expect(beatPhase(uneven, 9)).toBe(-1);
    expect(beatPhase(buildBeatGrid(null, 128, 0), 1)).toBe(-1);        // an estimate cannot be trusted for phase
    expect(beatPhase(buildBeatGrid(null, 128, 0, 0.2), 0.2)).toBeCloseTo(0);   // unless the user marked its downbeat
  });
  test("shiftByBeats goes through uneven beats", () => {
    // From 0.45 (phase 0.9 of beat 0) forward 0.2 beats lands at phase 0.1 of the 0.6 s beat: 0.5 + 0.06.
    expect(shiftByBeats(uneven, 0.45, 0.2)).toBeCloseTo(0.11);
    expect(shiftByBeats(straight(120, 0), 3, -0.25)).toBeCloseTo(-0.125);
  });
  test("phaseShift takes the short way round, at most half a beat", () => {
    const own = straight(120, 0), ref = straight(150, 0.1);
    // own at phase 0.9, ref at phase 0.1: forward 0.2 beats = 0.1 s of own track
    expect(phaseShift({ grid: own, position: 10.45 }, { grid: ref, position: 0.1 + 0.4 * 20 + 0.04 })).toBeCloseTo(0.1);
    // own at 0.1, ref at 0.9: back 0.2 beats
    expect(phaseShift({ grid: own, position: 10.05 }, { grid: ref, position: 0.1 + 0.4 * 20 + 0.36 })).toBeCloseTo(-0.1);
    expect(Math.abs(phaseShift({ grid: own, position: 10 }, { grid: ref, position: 0.3 })!)).toBeCloseTo(0.25);
    expect(phaseShift({ grid: own, position: 10 }, { grid: buildBeatGrid(null, 128, 0), position: 3 })).toBeNull();
    expect(phaseShift({ grid: null, position: 10 }, { grid: ref, position: 3 })).toBeNull();
  });
});

describe("engine nudge", () => {
  beforeAll(installLocation);
  afterEach(teardown);
  // Fake ctx: currentTime 10, node latency 0.12 -> lead 0.16.
  test("shifts a running deck at the landing time, keeps time, fires no seek", async () => {
    const { deck, ctx, node, log, load } = setup();
    await load();
    expect(deck.nudge(0.1)).toBe(false);                       // paused: nothing to shift
    await deck.play();                                         // anchor: input 0 at 10.16
    ctx.currentTime = 14.16;                                   // 4 s played
    log.length = 0;
    expect(deck.landsAt()).toBeCloseTo(14.32);
    expect(deck.positionAt(14.32)).toBeCloseTo(4.16);
    expect(deck.nudge(0.1)).toBe(true);
    expect(node.last()).toMatchObject({ active: true, outputTime: 14.32, rate: 1 });
    expect(node.last().input).toBeCloseTo(4.26);
    expect(log.filter((e: string) => e === "seeking" || e === "seeked")).toEqual([]);
    // Still pending: a tempo change keeps the nudged point, and a second nudge lands at the same time.
    deck.playbackRate = 1.05;
    expect(node.last()).toMatchObject({ outputTime: 14.32, rate: 1.05 });
    expect(node.last().input).toBeCloseTo(4.26);
    expect(deck.landsAt()).toBeCloseTo(14.32);
    expect(deck.nudge(-0.06)).toBe(true);
    expect(node.last().input).toBeCloseTo(4.2);
    ctx.currentTime = 15.32;
    expect(deck.currentTime).toBeCloseTo(4.2 + 1.05);
  });
  test("refuses in a loop or outside the track", async () => {
    const { deck, ctx, node, load } = setup();
    await load();
    await deck.play();
    ctx.currentTime = 14.16;
    const sent = node.scheduled.length;
    expect(deck.nudge(-50)).toBe(false);
    expect(deck.nudge(1000)).toBe(false);
    expect(deck.nudge(Number.NaN)).toBe(false);
    ctx.currentTime = 10.16 + 100.01;                          // past the 100 s track, before the end ticker ran
    expect(deck.nudge(-0.1)).toBe(false);
    ctx.currentTime = 14.16;
    expect(deck.setLoop(4, 6)).toBe(true);
    const withLoop = node.scheduled.length;
    expect(deck.nudge(0.1)).toBe(false);
    expect(node.scheduled.length).toBe(withLoop);
    expect(withLoop).toBeGreaterThanOrEqual(sent);
  });
});

test("job message keeps its Greek summary with the beatgrid count", () => {
  expect(translateJobMessage("analyzed 0, failed 0, beatgrids 5149")).toBe("αναλύθηκαν 0, απέτυχαν 0, beatgrids 5149");
  expect(translateJobMessage("analyzed 2, failed 1")).toBe("αναλύθηκαν 2, απέτυχαν 1");
});
