import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIX_MESSAGES, getMixSession, stopMixSession, dispatchMix, subscribeMix } from "../src/lib/mix/mixSession";
import {
  SECOND_PRESS_MS, afterSetMutation, createSecondPress, setMixState, shouldRequireSecondPress, startSetMix, startTransitionPreview,
} from "../src/lib/mix/mixStart";
import type { DeckId, DeckSlots } from "../src/lib/player";
import { PRESETS } from "../src/lib/transitions/presets";
import type { SetTransition } from "../src/lib/transitions/types";
import type { Track } from "../src/lib/types";

const track = (id: number) => ({ id, title: `T${id}`, file_name: `t${id}.wav` }) as Track;
const slotsWith = (a: number | null, b: number | null): DeckSlots => ({
  A: { track: a == null ? null : track(a), token: 1, autoPlay: false },
  B: { track: b == null ? null : track(b), token: 1, autoPlay: false },
});
const playingOnly = (...decks: DeckId[]) => (d: DeckId) => decks.includes(d);
const row: SetTransition = {
  id: null, set_id: 7, from_track_id: 1, to_track_id: 2, persisted: false, preset: "slam", resolved_preset: null, reasons: [],
  updated_at: null, ...PRESETS.slam, out_anchor_s: null, in_anchor_s: null, tempo_match: true,
};

afterEach(() => { stopMixSession("test"); dispatchMix({ type: "stopped" }); });

describe("shouldRequireSecondPress", () => {
  test("only a deck that is playing a track outside the set asks for a second press", () => {
    const set = new Set([1, 2, 3]);
    expect(shouldRequireSecondPress(slotsWith(9, null), playingOnly("A"), set)).toBe(true);
    expect(shouldRequireSecondPress(slotsWith(9, null), playingOnly(), set)).toBe(false);
    expect(shouldRequireSecondPress(slotsWith(3, 9), playingOnly("A"), set)).toBe(false);
    expect(shouldRequireSecondPress(slotsWith(3, 9), playingOnly("A", "B"), set)).toBe(true);
    expect(shouldRequireSecondPress(slotsWith(null, null), playingOnly("A", "B"), set)).toBe(false);
  });

  test("the second press counts only within 5 s of the first, then the gate re-arms", () => {
    const gate = createSecondPress();
    expect(gate.confirm(1000)).toBe(false);
    expect(gate.confirm(1000 + SECOND_PRESS_MS - 1)).toBe(true);
    expect(gate.confirm(9000)).toBe(false);
    expect(gate.confirm(9000 + SECOND_PRESS_MS + 1)).toBe(false);
    gate.reset();
    expect(gate.confirm(20000)).toBe(false);
  });
});

describe("startTransitionPreview", () => {
  test("loads B then A without playing, unlocks the audio inside the gesture and starts a preview session", () => {
    const calls: string[] = [];
    startTransitionPreview({
      load: (deck, t, opts) => { calls.push(`${deck}:${t.id}:${opts?.play}`); return true; },
      unlock: () => { calls.push("unlock"); },
      mixer: () => ({ fx: { A: { keylock: false, range: 0.08 }, B: { keylock: true, range: 0.16 } } }),
    }, { from: track(1), to: track(2), transition: row });
    expect(calls).toEqual(["B:2:false", "A:1:false", "unlock"]);
    const s = getMixSession();
    expect(s).toMatchObject({ mode: "preview", setId: null, status: "loading", currentDeck: "A" });
    expect(s.queue.map(q => q.trackId)).toEqual([1, 2]);
    expect(s.queue[0].transition).toEqual(row);
    expect(s.restore).toEqual({ keylock: { A: false, B: true }, range: { A: 0.08, B: 0.16 } });
  });
});

const mixer = () => ({ fx: { A: { keylock: false, range: 0.08 }, B: { keylock: true, range: 0.16 } } });

describe("startSetMix", () => {
  test("loads B (the second track, paused) then A (the first, playing) inside the gesture and starts a set session", () => {
    const calls: string[] = [];
    startSetMix({ load: (deck, t, opts) => { calls.push(`${deck}:${t.id}:${opts?.play}`); return true; }, mixer },
      { setId: 7, setTitle: "Βραδινό", tracks: [track(1), track(2), track(3)], transitions: [row] });
    expect(calls).toEqual(["B:2:false", "A:1:true"]);
    const s = getMixSession();
    expect(s).toMatchObject({ mode: "set", setId: 7, setTitle: "Βραδινό", status: "loading", currentDeck: "A", index: 0 });
    expect(s.queue.map(q => q.trackId)).toEqual([1, 2, 3]);
    expect(s.queue[0].transition).toEqual(row);
    expect(s.expected.A?.trackId).toBe(1);
    expect(s.expected.B?.trackId).toBe(2);
    expect(s.restore).toEqual({ keylock: { A: false, B: true }, range: { A: 0.08, B: 0.16 } });
  });

  test("fewer than two tracks: nothing is loaded and no session starts", () => {
    const calls: string[] = [];
    startSetMix({ load: (deck, t) => { calls.push(`${deck}:${t.id}`); return true; }, mixer },
      { setId: 7, setTitle: "x", tracks: [track(1)], transitions: [] });
    expect(calls).toEqual([]);
    expect(getMixSession().status).toBe("idle");
  });
});

describe("setMixState", () => {
  test("the button follows only a set session for this set", () => {
    expect(setMixState(getMixSession(), 7)).toBe("idle");
    startSetMix({ load: () => true, mixer }, { setId: 7, setTitle: "x", tracks: [track(1), track(2)], transitions: [] });
    expect(setMixState(getMixSession(), 7)).toBe("active");
    expect(setMixState(getMixSession(), 8)).toBe("idle");
    expect(setMixState(getMixSession(), null)).toBe("idle");
    stopMixSession("user");
    expect(setMixState(getMixSession(), 7)).toBe("stopping");
    dispatchMix({ type: "stopped" });
    expect(setMixState(getMixSession(), 7)).toBe("idle");
  });

  test("a transition preview is not a set mix", () => {
    startTransitionPreview({ load: () => true, unlock: () => {}, mixer }, { from: track(1), to: track(2), transition: row });
    expect(setMixState(getMixSession(), 7)).toBe("idle");
  });
});

describe("afterSetMutation (Review Focus 3 at the Set Builder boundary)", () => {
  const start = () => startSetMix({ load: () => true, mixer },
    { setId: 7, setTitle: "x", tracks: [track(1), track(2), track(3)], transitions: [] });
  const countChanges = () => {
    let n = 0;
    const off = subscribeMix(() => { n++; });
    return { get n() { return n; }, off };
  };

  test("a committed reorder reaches the running mix exactly once, with the new order", () => {
    start();
    const c = countChanges();
    afterSetMutation({ ok: true, setId: 7, tracks: [track(1), track(3), track(2)], transitions: [] });
    c.off();
    expect(c.n).toBe(1);
    expect(getMixSession().queue.map(q => q.trackId)).toEqual([1, 3, 2]);
    expect(getMixSession().expected.B?.trackId).toBe(3);
  });

  test("a failed reorder or removal (409, network error) never reaches the mix", () => {
    start();
    const before = getMixSession();
    const c = countChanges();
    afterSetMutation({ ok: false, error: new Error("409 Conflict") });
    afterSetMutation({ ok: false, error: new TypeError("Failed to fetch") });
    c.off();
    expect(c.n).toBe(0);
    expect(getMixSession()).toBe(before);
  });

  test("an edit to another set leaves the mix alone", () => {
    start();
    const before = getMixSession();
    afterSetMutation({ ok: true, setId: 8, tracks: [track(3)], transitions: [] });
    expect(getMixSession()).toBe(before);
  });

  test("removing the playing track stops the mix cleanly", () => {
    start();
    afterSetMutation({ ok: true, setId: 7, tracks: [track(2), track(3)], transitions: [] });
    expect(getMixSession()).toMatchObject({ status: "stopping", error: MIX_MESSAGES.trackRemoved });
  });
});

describe("Set Builder wiring", () => {
  const src = readFileSync(new URL("../src/pages/SetBuilder.tsx", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    return src.slice(start, src.indexOf("\n  }\n", start));
  };

  test("reorder and removal notify the mix only after the API call succeeded", () => {
    for (const [fn, call] of [["remove", "api.removeSetTrack("], ["commitOrder", "api.reorderSet("]] as const) {
      const b = body(fn);
      const apiAt = b.indexOf(call);
      const notifyAt = b.indexOf("afterSetMutation({ ok: true");
      expect(apiAt).toBeGreaterThan(0);
      expect(notifyAt).toBeGreaterThan(apiAt);
      // Not in the failure branch: the success notification comes before the `catch` of the API call.
      expect(notifyAt).toBeLessThan(b.lastIndexOf("} catch {"));
    }
  });

  test("the set header starts the mix from the gesture and offers a stop while it runs", () => {
    expect(src).toContain("startSetMix(");
    expect(src).toContain("MIX_COPY.playAsMix");
    expect(src).toContain("MIX_COPY.stopMix");
  });
});
