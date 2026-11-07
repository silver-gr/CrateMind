import { describe, expect, test } from "bun:test";
import {
  draftTransition, editorReducer, initEditor, isDirty, savePayload, setBuilderModal, type EditorState,
} from "../src/lib/transitions/editorState";
import { resolveAnchors, type LaneInput } from "../src/lib/transitions/planner";
import { PRESETS } from "../src/lib/transitions/presets";
import type { SetTransition } from "../src/lib/transitions/types";

/** An unsaved Auto row the resolver turned into «Ανάμειξη». */
const autoRow = (over: Partial<SetTransition> = {}): SetTransition => ({
  id: null, set_id: 7, from_track_id: 11, to_track_id: 12, persisted: false,
  preset: "auto", resolved_preset: "blend", reasons: ["same_key", "bpm_close"], updated_at: null,
  ...PRESETS.blend, out_anchor_s: null, in_anchor_s: null, tempo_match: true,
  ...over,
});

const savedRow = (over: Partial<SetTransition> = {}): SetTransition => autoRow({
  id: 3, persisted: true, preset: "melt", resolved_preset: null, reasons: [], updated_at: "2026-11-05T20:00:00",
  ...PRESETS.melt, out_anchor_s: 180, in_anchor_s: 8, ...over,
});

const run = (s: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) => actions.reduce(editorReducer, s);

describe("editorReducer: dirty tracking", () => {
  test("a freshly loaded row is clean; any parameter change makes it dirty; reverting makes it clean again", () => {
    const s = initEditor(savedRow());
    expect(isDirty(s)).toBe(false);
    const changed = run(s, { type: "tempoMatch", on: false });
    expect(isDirty(changed)).toBe(true);
    expect(isDirty(run(changed, { type: "tempoMatch", on: true }))).toBe(false);
  });

  test("choosing the preset that is already active changes nothing", () => {
    const s = initEditor(savedRow());
    expect(run(s, { type: "preset", preset: "melt" })).toBe(s);
  });

  test("a save makes the saved row the new clean baseline", () => {
    const s = run(initEditor(savedRow()), { type: "preset", preset: "blend" });
    const saved = run(s, { type: "saved", row: savedRow({ preset: "blend", ...PRESETS.blend }) });
    expect(isDirty(saved)).toBe(false);
    expect(saved.draft.preset).toBe("blend");
    expect(saved.row.preset).toBe("blend");
  });
});

describe("editorReducer: presets and parameters", () => {
  test("a named preset sets its curves, bars and loop and keeps the anchors and tempo match", () => {
    const s = run(initEditor(savedRow({ tempo_match: false })), { type: "preset", preset: "surge" });
    expect(s.draft).toEqual({ ...PRESETS.surge, preset: "surge", out_anchor_s: 180, in_anchor_s: 8, tempo_match: false });
  });

  test("«Χωρίς μετάβαση» is a cut: 0 bars", () => {
    const s = run(initEditor(savedRow()), { type: "preset", preset: "none" });
    expect(s.draft.preset).toBe("none");
    expect(s.draft.bars).toBe(0);
  });

  test("Auto restores the resolved parameters of an Auto row and keeps the anchors", () => {
    const s = run(initEditor(autoRow()), { type: "setAnchors", outStartS: 200, inStartS: 4 },
      { type: "preset", preset: "slam" }, { type: "preset", preset: "auto" });
    expect(s.draft).toEqual({ ...PRESETS.blend, preset: "auto", out_anchor_s: 200, in_anchor_s: 4, tempo_match: true });
    expect(isDirty(s)).toBe(false);
  });

  test("Auto on a saved non-Auto row changes nothing (its parameters are known only after «Επαναφορά σε Αυτόματο»)", () => {
    const s = initEditor(savedRow());
    expect(run(s, { type: "preset", preset: "auto" })).toBe(s);
  });

  test("a curve change that matches no named preset becomes «Προσαρμογή»", () => {
    const s = run(initEditor(autoRow()), { type: "params", patch: { volume_curve: "linear" } });
    expect(s.draft.preset).toBe("custom");
    expect(s.draft.volume_curve).toBe("linear");
    expect(isDirty(s)).toBe(true);
  });

  test("a curve change that lands on a named preset takes that preset's name", () => {
    const s = run(initEditor(autoRow()), { type: "params", patch: { eq_curve: "bass_swap_center", filter_curve: "lpf_in_lpf_out" } });
    expect(s.draft.preset).toBe("wave");
  });

  test("a loop change counts as a parameter change", () => {
    const s = run(initEditor(savedRow({ preset: "blend", ...PRESETS.blend })), { type: "params", patch: { loop_beats: 2 } });
    expect(s.draft.preset).toBe("custom");
    expect(s.draft.loop_beats).toBe(2);
  });
});

describe("editorReducer: length and window", () => {
  test("a bars change keeps the preset and the anchors", () => {
    const s = run(initEditor(savedRow()), { type: "bars", bars: 16 });
    expect(s.draft).toMatchObject({ preset: "melt", bars: 16, out_anchor_s: 180, in_anchor_s: 8 });
    expect(isDirty(s)).toBe(true);
  });

  test("bars are clamped to 1..32 and a loop longer than the window shrinks to fit (4 beats per bar)", () => {
    const surge = run(initEditor(savedRow()), { type: "preset", preset: "surge" }, { type: "params", patch: { loop_beats: 16 } });
    expect(run(surge, { type: "bars", bars: 99 }).draft.bars).toBe(32);
    const one = run(surge, { type: "bars", bars: 0 });
    expect(one.draft.bars).toBe(1);
    expect(one.draft.loop_beats).toBe(4);
  });

  test("a cut has no length: bars changes are ignored for «Χωρίς μετάβαση»", () => {
    const s = run(initEditor(savedRow()), { type: "preset", preset: "none" });
    expect(run(s, { type: "bars", bars: 4 })).toBe(s);
  });

  test("on an Auto row a length or tempo-match edit leaves Auto for the resolved preset, so the save keeps it", () => {
    const auto = run(initEditor(autoRow()), { type: "setAnchors", outStartS: 200, inStartS: 4 });
    expect(run(auto, { type: "bars", bars: 4 }).draft).toMatchObject({ preset: "blend", bars: 4 });
    expect(run(auto, { type: "window", outStartS: 196, bars: 16, inStartS: 4 }).draft).toMatchObject({ preset: "blend", bars: 16, out_anchor_s: 196 });
    expect(run(auto, { type: "tempoMatch", on: false }).draft).toMatchObject({ preset: "blend", tempo_match: false });
  });

  test("on an Auto row a window move that keeps the length stays Auto (only the anchors are the user's)", () => {
    const auto = run(initEditor(autoRow()), { type: "setAnchors", outStartS: 200, inStartS: 4 });
    expect(run(auto, { type: "window", outStartS: 196, bars: 8, inStartS: 6 }).draft)
      .toMatchObject({ preset: "auto", bars: 8, out_anchor_s: 196, in_anchor_s: 6 });
  });

  test("a window change moves both anchors and sets the bars, keeping the preset", () => {
    const s = run(initEditor(savedRow()), { type: "window", outStartS: 170.5, bars: 4, inStartS: 12 });
    expect(s.draft).toMatchObject({ preset: "melt", bars: 4, out_anchor_s: 170.5, in_anchor_s: 12 });
    const outOnly = run(initEditor(savedRow()), { type: "window", outStartS: 160, bars: 8 });
    expect(outOnly.draft).toMatchObject({ out_anchor_s: 160, in_anchor_s: 8 });
  });
});

describe("editorReducer: anchors and reset", () => {
  const grid = { kind: "straight" as const, anchor: 0, period: 0.5, estimated: false, overridden: false };
  const lane = (over: Partial<LaneInput>): LaneInput => ({ trackId: 1, grid, duration: 300, cues: [], rate: 1, onEngine: true, ...over });

  test("setAnchors fills null anchors from resolveAnchors without making the editor dirty", () => {
    const s = initEditor(autoRow());
    const r = resolveAnchors(lane({}), lane({ trackId: 2 }), s.draft);
    const next = run(s, { type: "setAnchors", outStartS: r.outStartS, inStartS: r.inStartS });
    expect(next.draft.out_anchor_s).toBe(r.outStartS);
    expect(next.draft.in_anchor_s).toBe(r.inStartS);
    expect(isDirty(next)).toBe(false);
  });

  test("setAnchors never overrides anchors that are already set", () => {
    const s = initEditor(savedRow());
    expect(run(s, { type: "setAnchors", outStartS: 1, inStartS: 2 })).toBe(s);
  });

  test("reset loads the Auto row with null anchors and a clean state", () => {
    const dirty = run(initEditor(savedRow()), { type: "bars", bars: 2 });
    const s = run(dirty, { type: "reset", row: autoRow({ out_anchor_s: 99, in_anchor_s: 1 }) });
    expect(s.draft).toEqual({ ...PRESETS.blend, preset: "auto", out_anchor_s: null, in_anchor_s: null, tempo_match: true });
    expect(s.row.persisted).toBe(false);
    expect(isDirty(s)).toBe(false);
    expect(s.auto).toEqual(s.draft);
  });
});

describe("save payload and preview row", () => {
  test("the payload is the draft's parameters plus the pair, nothing else", () => {
    const s = run(initEditor(autoRow()), { type: "setAnchors", outStartS: 200, inStartS: 4 }, { type: "window", outStartS: 196, bars: 8 });
    const body = savePayload(s);
    expect(Object.keys(body).sort()).toEqual([
      "bars", "eq_curve", "filter_curve", "from_track_id", "in_anchor_s", "loop_beats", "out_anchor_s", "preset",
      "tempo_match", "to_track_id", "volume_curve",
    ]);
    expect(body).toEqual({ ...PRESETS.blend, preset: "auto", bars: 8, out_anchor_s: 196, in_anchor_s: 4, tempo_match: true, from_track_id: 11, to_track_id: 12 });
  });

  test("the payload never sends preset auto with bars or tempo match other than the Auto row's (the server re-resolves them)", () => {
    const base = run(initEditor(autoRow()), { type: "setAnchors", outStartS: 200, inStartS: 4 });
    const edits: Parameters<typeof editorReducer>[1][] = [
      { type: "bars", bars: 4 }, { type: "bars", bars: 32 }, { type: "tempoMatch", on: false },
      { type: "window", outStartS: 190, bars: 12, inStartS: 4 }, { type: "window", outStartS: 190, bars: 8, inStartS: 8 },
      { type: "params", patch: { loop_beats: 2 } }, { type: "preset", preset: "slam" }, { type: "preset", preset: "auto" },
    ];
    for (const first of edits) {
      for (const second of edits) {
        const body = savePayload(run(base, first, second));
        if (body.preset === "auto") expect({ bars: body.bars, tempo_match: body.tempo_match }).toEqual({ bars: 8, tempo_match: true });
      }
    }
  });

  test("the preview plays the unsaved draft for the same pair", () => {
    const s = run(initEditor(savedRow()), { type: "preset", preset: "slam" });
    expect(draftTransition(s)).toMatchObject({ from_track_id: 11, to_track_id: 12, set_id: 7, preset: "slam", bars: 1 });
  });
});

describe("Set Builder modal", () => {
  test("exactly one modal: the form dialog for a new set or a pair note, the editor for a transition", () => {
    expect(setBuilderModal(null)).toBe(null);
    expect(setBuilderModal({ kind: "new" })).toBe("form");
    expect(setBuilderModal({ kind: "pair" })).toBe("form");
    expect(setBuilderModal({ kind: "transition" })).toBe("transition");
  });
});
