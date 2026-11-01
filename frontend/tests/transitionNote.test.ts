import { describe, expect, test } from "bun:test";
import { NOTE_RATINGS, loadInfoOf, newestPairNotes, planTransitionNote, rateTransition, registerLoadInfo, type NoteIo } from "../src/lib/transitionNote";

const load = (trackId: number, startedAt: number | null) => ({ trackId, startedAt });

describe("planTransitionNote", () => {
  test("from is the deck whose current load started earlier, whichever deck that is", () => {
    expect(planTransitionNote(load(1, 100), load(2, 500))).toEqual({ ok: true, from: { deck: "A", trackId: 1 }, to: { deck: "B", trackId: 2 } });
    expect(planTransitionNote(load(1, 900), load(2, 500))).toEqual({ ok: true, from: { deck: "B", trackId: 2 }, to: { deck: "A", trackId: 1 } });
  });

  test("refuses a deck that was only cued, an empty deck, the same track on both and a dead heat", () => {
    expect(planTransitionNote(load(1, 100), load(2, null))).toEqual({ ok: false, reason: "not-started" });
    expect(planTransitionNote(load(1, null), load(2, 100))).toEqual({ ok: false, reason: "not-started" });
    expect(planTransitionNote(null, load(2, 100))).toEqual({ ok: false, reason: "missing" });
    expect(planTransitionNote(load(1, 100), null)).toEqual({ ok: false, reason: "missing" });
    expect(planTransitionNote(load(5, 100), load(5, 200))).toEqual({ ok: false, reason: "same-track" });
    expect(planTransitionNote(load(1, 100), load(2, 100))).toEqual({ ok: false, reason: "simultaneous" });
  });

  test("a resume doesn't change the direction but a reload of a deck does (the registry reports each load's own start)", () => {
    // Deck A plays at t=100, B at t=500; A pauses and resumes: its startedAt stays 100, so A -> B holds.
    let a = load(1, 100);
    const b = load(2, 500);
    expect(planTransitionNote(a, b)).toMatchObject({ from: { deck: "A" } });
    a = load(1, 100); // resume: unchanged
    expect(planTransitionNote(a, b)).toMatchObject({ from: { deck: "A" } });
    // A is reloaded with a new track and played at t=900: now B -> A.
    a = load(3, 900);
    expect(planTransitionNote(a, b)).toEqual({ ok: true, from: { deck: "B", trackId: 2 }, to: { deck: "A", trackId: 3 } });
    // ... or ejected: refused.
    expect(planTransitionNote(null, b)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("rateTransition", () => {
  function io(over: Partial<NoteIo> = {}) {
    const log: unknown[][] = [];
    const out: NoteIo = {
      create: async body => { log.push(["create", body]); },
      toast: { success: m => log.push(["ok", m]), error: m => log.push(["err", m]), info: m => log.push(["info", m]) },
      flash: i => log.push(["flash", i]),
      emit: () => log.push(["emit"]),
      ...over,
    };
    return { out, log };
  }

  test("FX 1/2/3 send rating 5/3/1 for the ordered pair and nothing else, then flash and announce", async () => {
    expect(NOTE_RATINGS).toEqual([5, 3, 1]);
    for (const [index, rating] of [[0, 5], [1, 3], [2, 1]] as const) {
      const { out, log } = io();
      expect(await rateTransition(index, load(1, 900), load(2, 500), out)).toBe(true);
      expect(log[0]).toEqual(["create", { from_track_id: 2, to_track_id: 1, rating }]); // rating only: text and type stay on the server
      expect(log.slice(1).map(l => l[0])).toEqual(["flash", "ok", "emit"]);
      expect(log[1]).toEqual(["flash", index]);
    }
  });

  test("refusals explain themselves and write nothing", async () => {
    const { out, log } = io();
    expect(await rateTransition(2, load(1, 100), load(2, null), out)).toBe(false);
    expect(await rateTransition(0, load(4, 100), load(4, 300), out)).toBe(false);
    expect(log.map(l => l[0])).toEqual(["info", "info"]);
    expect(await rateTransition(3, load(1, 100), load(2, 200), out)).toBe(false); // no such button
  });

  test("a failed save reports the error without flashing or announcing", async () => {
    const { out, log } = io({ create: async () => { throw new Error("offline"); } });
    expect(await rateTransition(0, load(1, 100), load(2, 200), out)).toBe(false);
    expect(log).toEqual([["err", "offline"]]);
  });
});

describe("registry and readers", () => {
  test("loadInfoOf reads the registered getter and survives a throwing one", () => {
    const off = registerLoadInfo("A", () => load(9, 1));
    expect(loadInfoOf("A")).toEqual(load(9, 1));
    expect(loadInfoOf("B")).toBeNull();
    off();
    expect(loadInfoOf("A")).toBeNull();
    const offThrow = registerLoadInfo("B", () => { throw new Error("x"); });
    expect(loadInfoOf("B")).toBeNull();
    offThrow();
  });

  test("newestPairNotes keeps the highest id per ordered pair in any list order (Set Builder used the oldest)", () => {
    const n = (id: number, from: number, to: number, rating: number) => ({ id, from_track_id: from, to_track_id: to, rating });
    for (const list of [[n(3, 1, 2, 1), n(1, 1, 2, 5), n(2, 2, 1, 4)], [n(1, 1, 2, 5), n(2, 2, 1, 4), n(3, 1, 2, 1)]]) {
      const map = newestPairNotes(list);
      expect(map["1-2"].rating).toBe(1);
      expect(map["2-1"].rating).toBe(4);
      expect(Object.keys(map).sort()).toEqual(["1-2", "2-1"]);
    }
  });
});
