import { describe, expect, test } from "bun:test";
import {
  HEARTBEAT_MS, MAX_TICK_MS, dayLabel, emptyOpenPlays, groupSessions, isTaggingScreen, markPlayDead,
  retryPlayCreate,
  playSourceLabel, stepPlayHistory, type DeckSample, type OpenPlays, type PlayAction,
} from "../src/lib/playHistory";
import type { PlayHistoryEntry, Track } from "../src/lib/types";

const T0 = Date.UTC(2026, 10, 17, 20, 0, 0);
const sample = (patch: Partial<DeckSample> = {}): DeckSample =>
  ({ deck: "A", trackId: 7, token: 1, regTrackId: 7, playing: true, currentTime: 0, audible: true, ...patch });

/** Drives deck A one tick (default 1 s) at a time; `patch` gives each tick's sample changes. */
function run(ticks: number, patch: (i: number) => Partial<DeckSample> = i => ({ currentTime: i }), opts: { open?: OpenPlays; start?: number; dt?: number; counting?: (i: number) => boolean } = {}) {
  let open = opts.open ?? emptyOpenPlays();
  const actions: PlayAction[] = [];
  const dt = opts.dt ?? 1000;
  for (let i = 0; i < ticks; i++) {
    const now = (opts.start ?? T0) + i * dt;
    const step = stepPlayHistory(open, [sample(patch(i))], now, dt, opts.counting?.(i) ?? true);
    open = step.open;
    actions.push(...step.actions);
  }
  return { open, actions };
}

describe("stepPlayHistory", () => {
  test("30 s heard → one create, with the first heard tick as the baseline", () => {
    const { open, actions } = run(40);
    expect(actions).toHaveLength(1);
    const create = actions[0];
    expect(create).toMatchObject({ kind: "create", key: "A:1", deck: "A", trackId: 7, playedSeconds: 30 });
    if (create.kind !== "create") throw new Error();
    expect(create.startedAt).toBe(T0); // the first counted second ends at T0 + 1 s
    expect(create.endedAt).toBe(T0 + 30_000);
    expect(open.A?.logged).toBe(true);
    expect(open.A?.heardMs).toBe(39_000);
  });

  test("31 ticks are needed: the first heard tick only sets the baseline", () => {
    expect(run(30).actions).toHaveLength(0);
    expect(run(31).actions).toHaveLength(1);
  });

  test("pause → seek → play adds nothing for the jump", () => {
    const patch = (i: number) => (i === 10 ? { playing: false, currentTime: 9 } : i === 11 ? { currentTime: 200 } : { currentTime: i < 10 ? i : 200 + i });
    const { open } = run(13, patch);
    // ticks 1-9 count (9 s); tick 10 paused; tick 11 is a new baseline; tick 12 counts (1 s)
    expect(open.A?.heardMs).toBe(10_000);
  });

  test("frozen media time adds nothing (decode wait, suspended context)", () => {
    expect(run(60, () => ({ currentTime: 5 })).open.A?.heardMs).toBe(0);
  });

  test("a beat loop that wraps the media time still counts", () => {
    expect(run(41, i => ({ currentTime: 10 + (i % 4) })).actions.filter(a => a.kind === "create")).toHaveLength(1);
  });

  test("dt is capped at 5 s per tick (sleep/wake)", () => {
    const { open } = run(3, i => ({ currentTime: i }), { dt: 60_000 });
    expect(open.A?.heardMs).toBe(2 * MAX_TICK_MS);
  });

  test("a registry track other than the slot's counts nothing", () => {
    expect(run(60, i => ({ currentTime: i, regTrackId: 8 })).open.A?.heardMs).toBe(0);
  });

  test("gain below the floor counts nothing", () => {
    expect(run(60, i => ({ currentTime: i, audible: false })).open.A?.heardMs).toBe(0);
  });

  test("time on /tag is not counted", () => {
    const { open } = run(60, i => ({ currentTime: i }), { counting: i => i >= 50 });
    expect(open.A?.heardMs).toBe(9_000);
  });

  test("a token change closes the play: final update when logged, dropped below 30 s", () => {
    const logged = run(40);
    const close = stepPlayHistory(logged.open, [sample({ token: 2, currentTime: 0 })], T0 + 40_000, 1000, true);
    expect(close.actions).toEqual([{ kind: "update", key: "A:1", reason: "close", trackId: 7, endedAt: T0 + 39_000, playedSeconds: 39 }]);
    expect(close.open.A).toMatchObject({ token: 2, heardMs: 0, logged: false });

    const short = run(20);
    const dropped = stepPlayHistory(short.open, [sample({ trackId: 8, regTrackId: 8 })], T0 + 20_000, 1000, true);
    expect(dropped.actions).toEqual([]);
    expect(dropped.open.A?.trackId).toBe(8);
  });

  test("eject closes the play", () => {
    const { open } = run(40);
    const step = stepPlayHistory(open, [sample({ trackId: null, regTrackId: null, playing: false })], T0 + 40_000, 1000, true);
    expect(step.actions.map(a => a.kind === "update" && a.reason)).toEqual(["close"]);
    expect(step.open.A).toBeNull();
  });

  test("a dead play is never re-created or updated for the same token", () => {
    const first = run(31);
    const dead = markPlayDead(first.open, "A:1");
    expect(dead.A?.dead).toBe(true);
    const after = run(100, i => ({ currentTime: 100 + i }), { open: dead, start: T0 + 31_000 });
    expect(after.actions).toEqual([]);
    // closing it sends nothing either; a new token opens a fresh play
    const next = stepPlayHistory(after.open, [sample({ token: 2 })], T0 + 200_000, 1000, true);
    expect(next.actions).toEqual([]);
    expect(next.open.A?.dead).toBe(false);
  });

  test("a create the server refused unwritten (dataset_busy) is sent again on the next tick", () => {
    const first = run(31);
    expect(first.actions.filter(a => a.kind === "create")).toHaveLength(1);
    const retried = retryPlayCreate(first.open, "A:1");
    const next = stepPlayHistory(retried, [sample({ currentTime: 100 })], T0 + 32_000, 1000, true);
    expect(next.actions.map(a => a.kind)).toEqual(["create"]);
    expect(next.open.A?.logged).toBe(true);
  });

  test("heartbeat every 30 s of heard time, and an update on the heard → not-heard edge", () => {
    const { actions } = run(100);
    const beats = actions.filter(a => a.kind === "update");
    expect(beats.map(a => a.kind === "update" && a.reason)).toEqual(["heartbeat", "heartbeat"]);
    expect(beats.map(a => a.playedSeconds)).toEqual([30 + HEARTBEAT_MS / 1000, 30 + 2 * HEARTBEAT_MS / 1000]);

    const paused = run(46, i => (i >= 45 ? { playing: false, currentTime: 44 } : { currentTime: i }));
    const edge = paused.actions.filter(a => a.kind === "update");
    expect(edge).toEqual([{ kind: "update", key: "A:1", reason: "edge", trackId: 7, endedAt: T0 + 44_000, playedSeconds: 44 }]);
    // staying paused sends nothing more
    expect(stepPlayHistory(paused.open, [sample({ playing: false, currentTime: 44 })], T0 + 46_000, 1000, true).actions).toEqual([]);
  });

  test("no edge update when nothing was heard since the create", () => {
    const { actions } = run(32, i => (i === 31 ? { playing: false, currentTime: 30 } : { currentTime: i }));
    expect(actions.map(a => a.kind)).toEqual(["create"]);
  });

  test("decks are independent", () => {
    let open = emptyOpenPlays();
    const actions: PlayAction[] = [];
    for (let i = 0; i < 31; i++) {
      const step = stepPlayHistory(open, [sample({ currentTime: i }), sample({ deck: "B", trackId: 9, regTrackId: 9, token: 4, currentTime: i, audible: false })], T0 + i * 1000, 1000, true);
      open = step.open;
      actions.push(...step.actions);
    }
    expect(actions.map(a => a.key)).toEqual(["A:1"]);
    expect(open.B?.heardMs).toBe(0);
  });
});

test("isTaggingScreen", () => {
  expect(isTaggingScreen("/tag")).toBe(true);
  expect(isTaggingScreen("/tag/12")).toBe(true);
  expect(isTaggingScreen("/tag-cloud")).toBe(false);
  expect(isTaggingScreen("/library")).toBe(false);
});

const entry = (id: number, startMin: number, patch: Partial<PlayHistoryEntry> = {}): PlayHistoryEntry => ({
  id, track_id: id, set_id: null, deck: "A", context: null, track: { id } as Track,
  played_at: new Date(T0 + startMin * 60_000).toISOString(), ended_at: new Date(T0 + (startMin + 5) * 60_000).toISOString(), played_seconds: 300,
  ...patch,
});

describe("groupSessions", () => {
  test("overlapping decks keep one session; a > 30 min gap after the running max end starts another", () => {
    const plays = [
      entry(1, 0, { ended_at: new Date(T0 + 60 * 60_000).toISOString() }),  // long play on A to 60′
      entry(2, 10, { deck: "B" }),                                           // ends 15′, but A runs on
      entry(3, 85),                                                          // 25′ after A's end → same session
      entry(4, 200),                                                         // gap → new session
      entry(5, 201, { ended_at: null, played_seconds: null, deck: null }),    // manual row: start only
    ];
    const sessions = groupSessions([...plays].reverse());
    expect(sessions.map(s => s.plays.map(p => p.id))).toEqual([[4, 5], [1, 2, 3]]);
    expect(sessions[1].endMs).toBe(T0 + 90 * 60_000);
    expect(sessions[0].startMs).toBe(T0 + 200 * 60_000);
  });

  test("equal start times order by id", () => {
    const sessions = groupSessions([entry(9, 0, { deck: null, set_id: 3 }), entry(8, 0, { deck: null, set_id: 3 })]);
    expect(sessions[0].plays.map(p => p.id)).toEqual([8, 9]);
  });

  test("a row without an end uses its seconds, else its start", () => {
    const sessions = groupSessions([entry(1, 0, { ended_at: null, played_seconds: 600 }), entry(2, 39, { ended_at: null, played_seconds: null })]);
    expect(sessions).toHaveLength(1);
    expect(groupSessions([entry(1, 0, { ended_at: null, played_seconds: null }), entry(2, 31)])).toHaveLength(2);
  });
});

test("rows without a deck read «Set» or «Χειροκίνητα»", () => {
  expect(playSourceLabel({ deck: "B", set_id: null })).toBe("Deck B");
  expect(playSourceLabel({ deck: null, set_id: 4 })).toBe("Set");
  expect(playSourceLabel({ deck: null, set_id: null })).toBe("Χειροκίνητα");
});

test("dayLabel", () => {
  const now = new Date(2026, 10, 17, 1, 30).getTime();
  expect(dayLabel(new Date(2026, 10, 17, 0, 5).getTime(), now)).toBe("Σήμερα");
  expect(dayLabel(new Date(2026, 10, 16, 23, 55).getTime(), now)).toBe("Χθες");
  expect(dayLabel(new Date(2026, 10, 10, 22, 0).getTime(), now)).not.toMatch(/Σήμερα|Χθες/);
});
