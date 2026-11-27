import { describe, expect, test } from "bun:test";
import { applyCarry, carryChip, carryOffers, type CarriedTransition } from "../src/lib/transitions/carry";
import { pairKey, type SetTransition, type TransitionParams } from "../src/lib/transitions/types";

const params: TransitionParams = {
  preset: "blend", bars: 16, volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none",
  loop_beats: null, out_anchor_s: 200, in_anchor_s: 1.5, tempo_match: true,
};
const offer = (from: number, to: number, title = "Παρασκευή"): CarriedTransition => ({
  from_track_id: from, to_track_id: to, source_set_id: 9, source_set_title: title,
  updated_at: "2026-11-27T10:00:00+00:00", transition: params,
});
const row = (from: number, to: number, persisted: boolean): SetTransition => ({
  ...params, preset: persisted ? "slam" : "auto", id: persisted ? 1 : null, set_id: 3,
  from_track_id: from, to_track_id: to, persisted, resolved_preset: persisted ? null : "blend", reasons: [],
  updated_at: persisted ? "2026-11-27T09:00:00+00:00" : null,
});

describe("carry offers", () => {
  test("only an unsaved pair of this set shows the offer", () => {
    const transitions = { [pairKey(1, 2)]: row(1, 2, false), [pairKey(2, 3)]: row(2, 3, true) };
    const shown = carryOffers(transitions, [offer(1, 2), offer(2, 3), offer(3, 4)]);
    expect(Object.keys(shown)).toEqual([pairKey(1, 2)]);
    expect(shown[pairKey(1, 2)].source_set_id).toBe(9);
  });
  test("the pair is ordered: B→A never takes A→B's offer", () => {
    expect(carryOffers({ [pairKey(2, 1)]: row(2, 1, false) }, [offer(1, 2)])).toEqual({});
  });
  test("no transitions or no offers: nothing", () => {
    expect(carryOffers({}, [offer(1, 2)])).toEqual({});
    expect(carryOffers({ [pairKey(1, 2)]: row(1, 2, false) }, [])).toEqual({});
  });
});

describe("carry chip", () => {
  test("names the source set in Greek, with the action", () => {
    const chip = carryChip(offer(1, 2));
    expect(chip.label).toBe("Ρυθμισμένη στο set «Παρασκευή»");
    expect(chip.action).toBe("Χρήση");
    expect(chip.title).toContain("αντίγραφο");
    expect(chip.title).not.toMatch(/[A-Za-z]{4,}/); // no English or internal keys
  });
  test("a long set name is shortened in the label but kept whole in the title", () => {
    const name = "Ένα πολύ μεγάλο όνομα set για το βράδυ της Παρασκευής";
    const chip = carryChip(offer(1, 2, name));
    expect(chip.label.length).toBeLessThan(50);
    expect(chip.label.endsWith("…»")).toBe(true);
    expect(chip.title).toContain(name);
  });
});

describe("applyCarry", () => {
  test("saves the source's values as this set's own row and announces it", async () => {
    const calls: unknown[] = [];
    let announced = 0;
    const saved = { ...row(1, 2, true), ...params };
    const result = await applyCarry(3, offer(1, 2), {
      save: async (setId, body) => { calls.push([setId, body]); return saved; },
      announce: () => { announced++; },
    });
    expect(result).toBe(saved);
    expect(calls).toEqual([[3, { ...params, from_track_id: 1, to_track_id: 2 }]]);
    expect(announced).toBe(1);
  });
  test("the body is a copy: changing it later never reaches the offer", async () => {
    const source = offer(1, 2);
    let body: (TransitionParams & { from_track_id: number }) | null = null;
    await applyCarry(3, source, { save: async (_id, b) => { body = b; return row(1, 2, true); }, announce: () => {} });
    body!.bars = 1;
    expect(source.transition.bars).toBe(16);
  });
  test("a failed save announces nothing", async () => {
    let announced = 0;
    await expect(applyCarry(3, offer(1, 2), { save: async () => { throw new Error("x"); }, announce: () => { announced++; } }))
      .rejects.toThrow();
    expect(announced).toBe(0);
  });
});
