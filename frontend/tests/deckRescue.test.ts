import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyMixer, buildSnapshot, newRescueWriter, rescuePromptText, restorableDecks, writeDecision,
  type RescueTransport, type RestoreDeck,
} from "../src/lib/deckRescue";
import {
  getMixer, resetMixer, setCrossfader, setDeckEq, setDeckFilter, setDeckKeylock, setDeckPitchFromController, setDeckRangePitch,
  setCueGain, setCueMix, setDeckTrim, setMasterGain, setMidiConnected, setMixerVolume,
} from "../src/lib/mixer";
import type { DeckSlots } from "../src/lib/player";
import type { DeckRescueBody, DeckRescueDeck, Track } from "../src/lib/types";

const track = (id: number, patch: Partial<Track> = {}) => ({ id, title: `Τίτλος ${id}`, artist: `Καλλιτέχνης ${id}`, file_name: `${id}.flac`, missing: false, ...patch }) as Track;
const slots = (a: Track | null, b: Track | null): DeckSlots =>
  ({ A: { track: a, token: 1, autoPlay: false }, B: { track: b, token: 1, autoPlay: false } });
const transport = (patch: Partial<RescueTransport> = {}): RescueTransport =>
  ({ trackId: 1, ready: true, onEngine: true, position: () => 61.23456, engine: { loop: null }, ...patch });
const saved = (trackId: number, patch: Partial<DeckRescueDeck> = {}): DeckRescueDeck => ({
  track_id: trackId, position_s: 30, pitch: 0.25, range: 0.16, keylock: true, eq: { hi: 0.1, mid: -0.5, lo: -1 }, filter: 0.4, trim: -0.2, loop: null, ...patch,
});
const snapshot = (a: DeckRescueDeck | null, b: DeckRescueDeck | null): DeckRescueBody =>
  ({ v: 1, decks: { A: a, B: b }, mixer: { volume: { A: 0.8, B: 0.3 }, crossfader: -0.5, master: 0.7 } });

beforeEach(resetMixer);

describe("buildSnapshot", () => {
  test("two decks: positions to the millisecond, the mixer's own values, the loop of an engine deck; never the headphone knobs", () => {
    setDeckRangePitch("A", 0.16, 0.25);
    setDeckKeylock("A", true);
    setDeckEq("A", "lo", -1);
    setDeckFilter("B", 0.4);
    setDeckTrim("B", -0.2);
    setMixerVolume("B", 0.3);
    setCrossfader(-0.5);
    setMasterGain(0.7);
    setCueGain(0.2); // the backend model forbids unknown fields
    setCueMix(0.9);
    const got = buildSnapshot(slots(track(1), track(2)), getMixer(), {
      A: transport({ engine: { loop: { start: 60, end: 62 } } }),
      B: transport({ trackId: 2, position: () => 5 }),
    });
    expect(got).toEqual({
      v: 1,
      decks: {
        A: { track_id: 1, position_s: 61.235, pitch: 0.25, range: 0.16, keylock: true, eq: { hi: 0, mid: 0, lo: -1 }, filter: 0, trim: 0, loop: { start_s: 60, end_s: 62 } },
        B: { track_id: 2, position_s: 5, pitch: 0, range: 0.08, keylock: false, eq: { hi: 0, mid: 0, lo: 0 }, filter: 0.4, trim: -0.2, loop: null },
      },
      mixer: { volume: { A: 1, B: 0.3 }, crossfader: -0.5, master: 0.7 },
    });
  });

  test("one deck leaves the other null; no deck gives no snapshot", () => {
    const got = buildSnapshot(slots(null, track(2)), getMixer(), { A: null, B: transport({ trackId: 2 }) });
    expect(got?.decks.A).toBeNull();
    expect(got?.decks.B?.track_id).toBe(2);
    expect(buildSnapshot(slots(null, null), getMixer(), { A: transport(), B: null })).toBeNull();
  });

  test("a deck whose source is not loaded for the slot's track is saved at 0, without a loop", () => {
    const loop = { engine: { loop: { start: 60, end: 62 } } };
    for (const t of [null, transport({ ready: false, ...loop }), transport({ trackId: 9, ...loop })]) {
      const got = buildSnapshot(slots(track(1), null), getMixer(), { A: t, B: null });
      expect(got?.decks.A).toMatchObject({ track_id: 1, position_s: 0, loop: null });
    }
  });

  test("a deck on the plain audio element has no loop", () => {
    const got = buildSnapshot(slots(track(1), null), getMixer(), { A: transport({ onEngine: false, engine: { loop: { start: 60, end: 62 } } }), B: null });
    expect(got?.decks.A?.loop).toBeNull();
  });

  test("a paused, untouched state gives the same JSON twice", () => {
    const build = () => JSON.stringify(buildSnapshot(slots(track(1), track(2)), getMixer(), { A: transport(), B: transport({ trackId: 2 }) }));
    expect(build()).toBe(build());
  });
});

describe("writeDecision", () => {
  const writer = (patch = {}) => ({ ...newRescueWriter(), ...patch });

  test("writes the first snapshot and every changed one, never an unchanged one", () => {
    expect(writeDecision(writer(), "a")).toBe("write");
    expect(writeDecision(writer({ sent: "a", owns: true }), "a")).toBe("none");
    expect(writeDecision(writer({ sent: "a", owns: true }), "b")).toBe("write");
  });

  test("waits for a request in flight and for a running restore", () => {
    expect(writeDecision(writer({ busy: true }), "a")).toBe("none");
    expect(writeDecision(writer({ restoring: true }), "a")).toBe("none");
    expect(writeDecision(writer({ owns: true, restoring: true }), null)).toBe("none");
  });

  test("both decks empty: one clear after a write or a restore in this session, nothing before", () => {
    expect(writeDecision(writer(), null)).toBe("none");
    const w = writer({ sent: "a", owns: true });
    expect(writeDecision(w, null)).toBe("clear");
    // What the hook records once the clear has gone through.
    w.sent = null;
    w.owns = false;
    expect(writeDecision(w, null)).toBe("none");
  });
});

describe("restorableDecks", () => {
  test("keeps the decks whose track is still there", () => {
    const got = restorableDecks(snapshot(saved(1), saved(2)), new Map([[1, track(1)], [2, track(2)]]));
    expect(got.map(d => [d.deck, d.track.id, d.saved.track_id])).toEqual([["A", 1, 1], ["B", 2, 2]]);
  });

  test("drops a deleted track and one whose file is missing; none left gives an empty list", () => {
    const one = restorableDecks(snapshot(saved(1), saved(2)), new Map([[2, track(2)]]));
    expect(one.map(d => d.deck)).toEqual(["B"]);
    expect(restorableDecks(snapshot(saved(1), saved(2)), new Map([[1, track(1, { missing: true })]]))).toEqual([]);
    expect(restorableDecks(snapshot(null, saved(2)), new Map())).toEqual([]);
  });
});

describe("applyMixer", () => {
  const decks = (snap: DeckRescueBody): RestoreDeck[] => restorableDecks(snap, new Map([[1, track(1)], [2, track(2)]]));

  test("without a controller every saved control comes back", () => {
    const snap = snapshot(saved(1), saved(2, { pitch: -1, range: 0.5, keylock: false }));
    applyMixer(snap, decks(snap), false);
    const m = getMixer();
    expect(m.fx.A).toMatchObject({ pitch: 0.25, range: 0.16, keylock: true, eq: { hi: 0.1, mid: -0.5, lo: -1 }, filter: 0.4, trim: -0.2 });
    expect(m.fx.B).toMatchObject({ pitch: -1, range: 0.5, keylock: false });
    expect([m.volume, m.crossfader, m.master]).toEqual([{ A: 0.8, B: 0.3 }, -0.5, 0.7]);
  });

  test("with a controller only tempo, range and key lock are set, and the fader must reach the tempo first", () => {
    setMidiConnected(true);
    const snap = snapshot(saved(1), null);
    applyMixer(snap, decks(snap), true);
    const m = getMixer();
    expect(m.fx.A).toMatchObject({ pitch: 0.25, range: 0.16, keylock: true, eq: { hi: 0, mid: 0, lo: 0 }, filter: 0, trim: 0 });
    expect([m.volume, m.crossfader, m.master]).toEqual([{ A: 1, B: 1 }, 0, 1]);
    setDeckPitchFromController("A", -0.6); // the fader's resting place: ignored until it crosses the saved tempo
    expect(getMixer().fx.A.pitch).toBe(0.25);
    setDeckPitchFromController("A", 0.3);
    expect(getMixer().fx.A.pitch).toBe(0.3);
  });

  test("a deck that does not come back keeps its neutral controls", () => {
    const snap = snapshot(saved(1), saved(3));
    applyMixer(snap, decks(snap), false);
    expect(getMixer().fx.B).toMatchObject({ pitch: 0, range: 0.08, filter: 0 });
    expect(getMixer().volume).toEqual({ A: 0.8, B: 1 });
  });
});

describe("rescuePromptText", () => {
  test("names each deck's track and how long ago it was saved", () => {
    const snap = snapshot(saved(1), saved(2));
    const both = restorableDecks(snap, new Map([[1, track(1)], [2, track(2, { artist: null, title: "" })]]));
    expect(rescuePromptText(both, 12 * 60 + 5)).toBe("A: Καλλιτέχνης 1 – Τίτλος 1 · B: 2.flac · πριν 12 λ.");
    expect(rescuePromptText(both.slice(0, 1), 3)).toBe("A: Καλλιτέχνης 1 – Τίτλος 1 · μόλις τώρα");
  });
});
