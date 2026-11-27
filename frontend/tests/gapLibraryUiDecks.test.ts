// Test gaps (2026-11-27) for the play log and deck rescue: clock jumps, dead plays, both decks on one track,
// session boundaries, long sets, and snapshot edge cases.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  dayLabel, emptyOpenPlays, groupSessionDays, groupSessions, markPlayDead, mergePlays, playEndMs, retryPlayCreate,
  stepPlayHistory, type DeckSample, type OpenPlays, type PlayAction,
} from "../src/lib/playHistory";
import {
  buildSnapshot, newRescueWriter, rescuePromptText, restorableDecks, writeDecision, type RescueTransport,
} from "../src/lib/deckRescue";
import { getMixer, resetMixer } from "../src/lib/mixer";
import type { DeckSlots } from "../src/lib/player";
import type { DeckRescueBody, DeckRescueDeck, PlayHistoryEntry, Track } from "../src/lib/types";

const T0 = Date.UTC(2026, 10, 27, 22, 0, 0);
const sample = (patch: Partial<DeckSample> = {}): DeckSample =>
  ({ deck: "A", trackId: 7, token: 1, regTrackId: 7, playing: true, currentTime: 0, audible: true, ...patch });

/** Drives the given decks one tick at a time; `patch(i)` returns each tick's samples. */
function drive(ticks: number, patch: (i: number) => DeckSample[], opts: { open?: OpenPlays; dt?: (i: number) => number } = {}) {
  let open = opts.open ?? emptyOpenPlays();
  let now = T0;
  const actions: PlayAction[] = [];
  for (let i = 0; i < ticks; i++) {
    const dt = opts.dt?.(i) ?? 1000;
    now += dt;
    const step = stepPlayHistory(open, patch(i), now, dt, true);
    open = step.open;
    actions.push(...step.actions);
  }
  return { open, actions, now };
}

describe("play log: clock and deck edge cases", () => {
  test("a clock that jumps back (negative dt) adds no heard time", () => {
    const { open } = drive(20, i => [sample({ currentTime: i })], { dt: i => (i === 0 ? 1000 : -1000) });
    expect(open.A?.heardMs).toBe(0);
  });

  test("the same track on both decks gives two plays with their own keys", () => {
    const { actions } = drive(32, i => [sample({ currentTime: i }), sample({ deck: "B", currentTime: i })]);
    expect(actions.filter(a => a.kind === "create").map(a => a.key)).toEqual(["A:1", "B:1"]);
  });

  test("re-loading the same track (new token) starts a fresh count with a new key", () => {
    const first = drive(32, i => [sample({ currentTime: i })]);
    const second = drive(32, i => [sample({ token: 2, currentTime: i })], { open: first.open });
    const keys = second.actions.map(a => `${a.kind}:${a.key}`);
    expect(keys).toEqual(["update:A:1", "create:A:2"]);
    expect(second.open.A?.token).toBe(2);
  });

  test("a play that went dead is not closed with an update on eject", () => {
    const logged = drive(32, i => [sample({ currentTime: i })]);
    const dead = markPlayDead(logged.open, "A:1");
    const eject = stepPlayHistory(dead, [sample({ trackId: null, regTrackId: null })], logged.now + 1000, 1000, true);
    expect(eject.actions).toEqual([]);
    expect(eject.open.A).toBeNull();
  });

  test("markPlayDead and retryPlayCreate leave other keys alone", () => {
    const { open } = drive(32, i => [sample({ currentTime: i }), sample({ deck: "B", trackId: 9, regTrackId: 9, currentTime: i })]);
    const dead = markPlayDead(open, "B:9");
    expect(dead.A?.dead).toBe(false);
    expect(dead.B?.dead).toBe(false);
    const retried = retryPlayCreate(open, "A:2");
    expect(retried.A?.logged).toBe(true);
    expect(retried.B?.logged).toBe(true);
  });

  test("a retried create sends the full heard time under the same key", () => {
    const logged = drive(35, i => [sample({ currentTime: i })]);
    const retried = retryPlayCreate(logged.open, "A:1");
    const next = stepPlayHistory(retried, [sample({ currentTime: 35 })], logged.now + 1000, 1000, true);
    const create = next.actions.find(a => a.kind === "create");
    expect(create).toMatchObject({ key: "A:1", playedSeconds: 35 });
  });

  test("an empty deck with no open play stays empty and logs nothing", () => {
    const step = stepPlayHistory(emptyOpenPlays(), [sample({ trackId: null, regTrackId: null, playing: false })], T0, 1000, true);
    expect(step).toEqual({ open: { A: null, B: null }, actions: [] });
  });

  test("a long set: one create, then one heartbeat per 30 s of heard time", () => {
    const { actions } = drive(30 * 60 + 1, i => [sample({ currentTime: i })]);
    expect(actions.filter(a => a.kind === "create")).toHaveLength(1);
    // 30 min heard: the create at 30 s, then a heartbeat at 60 s, 90 s, … 1800 s.
    expect(actions.filter(a => a.kind === "update" && a.reason === "heartbeat")).toHaveLength(59);
  });
});

const entry = (id: number, startMin: number, patch: Partial<PlayHistoryEntry> = {}): PlayHistoryEntry => ({
  id, track_id: id, set_id: null, deck: "A", context: null, track: { id } as Track,
  played_at: new Date(T0 + startMin * 60_000).toISOString(), ended_at: new Date(T0 + (startMin + 5) * 60_000).toISOString(), played_seconds: 300,
  ...patch,
});

describe("play sessions: boundaries", () => {
  test("no plays, no sessions", () => {
    expect(groupSessions([])).toEqual([]);
  });

  test.each([
    // [second play's start minute, sessions] — the first play ends at minute 5, the gap is 30 min
    [35, 1],
    [35.0001, 2],
    [36, 2],
  ])("a play starting at minute %p gives %p session(s)", (start, count) => {
    expect(groupSessions([entry(1, 0), entry(2, start)])).toHaveLength(count);
  });

  test("a custom gap of 0 splits at the first silence", () => {
    expect(groupSessions([entry(1, 0), entry(2, 5), entry(3, 11)], 0).map(s => s.plays.map(p => p.id))).toEqual([[3], [1, 2]]);
  });

  test("an ended_at wins over played_seconds", () => {
    const play = entry(1, 0, { played_seconds: 9999 });
    expect(playEndMs(play)).toBe(T0 + 5 * 60_000);
  });

  test("a set across midnight stays one session, listed under the day it started", () => {
    const start = new Date(2026, 10, 27, 23, 0).getTime();
    const at = (min: number) => new Date(start + min * 60_000).toISOString();
    const plays = Array.from({ length: 40 }, (_, i) => entry(i + 1, 0, {
      played_at: at(i * 6), ended_at: at(i * 6 + 6), played_seconds: 360,
    }));
    const sessions = groupSessions(plays);
    expect(sessions).toHaveLength(1);
    const now = new Date(2026, 10, 28, 3, 30).getTime();
    expect(groupSessionDays(sessions, now).map(d => d.label)).toEqual(["Χθες"]);
  });

  test("5,000 back-to-back plays form one ordered session", () => {
    const plays = Array.from({ length: 5000 }, (_, i) => entry(5000 - i, 5000 - i - 1));
    const [session, ...rest] = groupSessions(plays);
    expect(rest).toHaveLength(0);
    expect(session.plays).toHaveLength(5000);
    expect(session.plays[0].id).toBe(1);
    expect(session.plays[4999].id).toBe(5000);
  });

  test("merging the same fresh page twice adds no duplicates", () => {
    const fresh = [entry(2, 10), entry(3, 20)];
    const once = mergePlays([entry(1, 0)], fresh);
    expect(mergePlays(once, fresh).map(p => p.id)).toEqual([1, 2, 3]);
  });

  test("a date in another year names the year; this year's does not", () => {
    const now = new Date(2027, 0, 5, 12, 0).getTime();
    expect(dayLabel(new Date(2026, 11, 30, 22, 0).getTime(), now)).toContain("2026");
    expect(dayLabel(new Date(2027, 0, 2, 22, 0).getTime(), now)).not.toContain("2027");
  });

  test("the day after the clocks go back is still «Χθες»", () => {
    // EU summer time ends on 25 Oct 2026; a 25-hour day must not count as two.
    expect(dayLabel(new Date(2026, 9, 25, 12, 0).getTime(), new Date(2026, 9, 26, 0, 30).getTime())).toBe("Χθες");
    expect(dayLabel(new Date(2026, 2, 28, 23, 0).getTime(), new Date(2026, 2, 29, 23, 30).getTime())).toBe("Χθες");
  });
});

const rtrack = (id: number, patch: Partial<Track> = {}) => ({ id, title: `Τίτλος ${id}`, artist: `Καλλιτέχνης ${id}`, file_name: `${id}.flac`, missing: false, ...patch }) as Track;
const slots = (a: Track | null, b: Track | null): DeckSlots =>
  ({ A: { track: a, token: 1, autoPlay: false }, B: { track: b, token: 1, autoPlay: false } });
const transport = (patch: Partial<RescueTransport> = {}): RescueTransport =>
  ({ trackId: 1, ready: true, onEngine: true, position: () => 0, engine: { loop: null }, ...patch });
const saved = (trackId: number): DeckRescueDeck => ({
  track_id: trackId, position_s: 30, pitch: 0, range: 0.08, keylock: false, eq: { hi: 0, mid: 0, lo: 0 }, filter: 0, trim: 0, loop: null,
});
const snapshot = (a: DeckRescueDeck | null, b: DeckRescueDeck | null): DeckRescueBody =>
  ({ v: 1, decks: { A: a, B: b }, mixer: { volume: { A: 1, B: 1 }, crossfader: 0, master: 1 } });

beforeEach(resetMixer);

describe("deck rescue: snapshot edge cases", () => {
  test.each([
    [-0.2, 0],
    [12.34567, 12.346],
    [12.3454, 12.345],
    [7200.0004, 7200],
  ])("a position of %p s is saved as %p", (position, savedAt) => {
    const snap = buildSnapshot(slots(rtrack(1), null), getMixer(), { A: transport({ position: () => position }), B: null });
    expect(snap?.decks.A?.position_s).toBe(savedAt);
  });

  test("an engine deck whose engine is gone has no loop", () => {
    const snap = buildSnapshot(slots(rtrack(1), null), getMixer(), { A: transport({ engine: null }), B: null });
    expect(snap?.decks.A?.loop).toBeNull();
  });

  test("a position under half a millisecond apart writes nothing new", () => {
    const writer = newRescueWriter();
    const json = (pos: number) => JSON.stringify(buildSnapshot(slots(rtrack(1), null), getMixer(), { A: transport({ position: () => pos }), B: null }));
    writer.sent = json(61.2341);
    expect(writeDecision(writer, json(61.2344))).toBe("none");
    expect(writeDecision(writer, json(61.2346))).toBe("write");
  });

  test("restored decks come back A then B, whatever the lookup order", () => {
    const decks = restorableDecks(snapshot(saved(1), saved(2)), new Map([[2, rtrack(2)], [1, rtrack(1)]]));
    expect(decks.map(d => d.deck)).toEqual(["A", "B"]);
  });

  test("a snapshot with no decks restores nothing", () => {
    expect(restorableDecks(snapshot(null, null), new Map([[1, rtrack(1)]]))).toEqual([]);
  });

  test("the same track on both decks restores on both", () => {
    const decks = restorableDecks(snapshot(saved(5), saved(5)), new Map([[5, rtrack(5)]]));
    expect(decks.map(d => `${d.deck}:${d.track.id}`)).toEqual(["A:5", "B:5"]);
  });

  test.each([
    [59, "μόλις τώρα"],
    [60, "πριν 1 λ."],
    [3600, "πριν 1 ώ."],
    [23 * 3600 + 3599, "πριν 23 ώ."],
  ])("a snapshot %p s old reads «%s»", (ageS, age) => {
    const decks = restorableDecks(snapshot(saved(1), null), new Map([[1, rtrack(1, { artist: "Σταύρος Ξαρχάκος", title: "Ρεμπέτικο ♪" })]]));
    expect(rescuePromptText(decks, ageS)).toBe(`A: Σταύρος Ξαρχάκος – Ρεμπέτικο ♪ · ${age}`);
  });
});
