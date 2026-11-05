import { afterEach, describe, expect, test } from "bun:test";
import { getMixSession, stopMixSession, dispatchMix } from "../src/lib/mix/mixSession";
import { SECOND_PRESS_MS, createSecondPress, shouldRequireSecondPress, startTransitionPreview } from "../src/lib/mix/mixStart";
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
