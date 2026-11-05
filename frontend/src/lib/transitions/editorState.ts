// The transition editor's state (pure): the row as loaded or saved, the clean baseline, the draft being edited, and
// Auto's resolved parameters when the row is an Auto row. <TransitionEditorDialog/> drives it with `useReducer`.
import { applyPreset, presetFor } from "./presets";
import { BARS_MAX, BARS_MIN, LOOP_BEATS, type LoopBeats, type Preset, type SetTransition, type TransitionParams } from "./types";

export interface EditorState {
  row: SetTransition;
  /** The baseline the draft is compared with: the row's parameters plus anchors filled in at open. */
  clean: TransitionParams;
  draft: TransitionParams;
  /** What «Αυτόματο» means for this pair (the resolver's choice); null when the row is not an Auto row. */
  auto: TransitionParams | null;
}

export type EditorAction =
  | { type: "load"; row: SetTransition }
  /** «Επαναφορά σε Αυτόματο»: the server's Auto row after the delete; anchors are re-resolved. */
  | { type: "reset"; row: SetTransition }
  | { type: "saved"; row: SetTransition }
  | { type: "preset"; preset: Preset }
  /** A curve or loop change from the parameter rows; the preset follows (`presetFor`). */
  | { type: "params"; patch: Partial<TransitionParams> }
  | { type: "bars"; bars: number }
  | { type: "window"; outStartS: number; bars: number; inStartS?: number }
  | { type: "tempoMatch"; on: boolean }
  /** The anchors `resolveAnchors` picked, for a row that has none yet; part of the baseline, not an edit. */
  | { type: "setAnchors"; outStartS: number; inStartS: number };

const KEYS = ["preset", "bars", "volume_curve", "eq_curve", "filter_curve", "loop_beats", "out_anchor_s", "in_anchor_s", "tempo_match"] as const;

export const paramsOf = (t: TransitionParams): TransitionParams =>
  Object.fromEntries(KEYS.map(k => [k, t[k]])) as unknown as TransitionParams;

const same = (a: TransitionParams, b: TransitionParams) => KEYS.every(k => a[k] === b[k]);
export const isDirty = (s: EditorState) => !same(s.clean, s.draft);

export function initEditor(row: SetTransition): EditorState {
  const p = paramsOf(row);
  return { row, clean: p, draft: p, auto: row.preset === "auto" ? p : null };
}

const clampBars = (bars: number) => Math.min(BARS_MAX, Math.max(BARS_MIN, Math.round(bars)));
/** A loop may not outlast the window (4 beats per bar; the backend rejects it): shrink it to the longest that fits. */
function fitLoop(p: TransitionParams): TransitionParams {
  if (p.loop_beats == null || p.loop_beats <= 4 * p.bars) return p;
  const fits = LOOP_BEATS.filter(b => b <= 4 * p.bars);
  return { ...p, loop_beats: (fits[fits.length - 1] ?? null) as LoopBeats | null };
}
const withDraft = (s: EditorState, draft: TransitionParams): EditorState => (same(draft, s.draft) ? s : { ...s, draft });

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case "load":
    case "saved":
      return initEditor(a.row);
    case "reset":
      return initEditor({ ...a.row, out_anchor_s: null, in_anchor_s: null });
    case "preset": {
      if (a.preset === s.draft.preset || a.preset === "custom") return s;
      if (a.preset === "auto" && s.auto) {
        return withDraft(s, { ...s.auto, out_anchor_s: s.draft.out_anchor_s, in_anchor_s: s.draft.in_anchor_s });
      }
      return withDraft(s, applyPreset(a.preset, s.draft));
    }
    case "params": {
      const next = fitLoop({ ...s.draft, ...a.patch });
      return withDraft(s, { ...next, preset: presetFor(next) });
    }
    case "bars":
      if (s.draft.preset === "none") return s;
      return withDraft(s, fitLoop({ ...s.draft, bars: clampBars(a.bars) }));
    case "window":
      return withDraft(s, fitLoop({
        ...s.draft, bars: s.draft.preset === "none" ? 0 : clampBars(a.bars),
        out_anchor_s: a.outStartS, in_anchor_s: a.inStartS ?? s.draft.in_anchor_s,
      }));
    case "tempoMatch":
      return withDraft(s, { ...s.draft, tempo_match: a.on });
    case "setAnchors": {
      if (s.draft.out_anchor_s != null && s.draft.in_anchor_s != null) return s;
      const fill = (p: TransitionParams): TransitionParams =>
        ({ ...p, out_anchor_s: p.out_anchor_s ?? a.outStartS, in_anchor_s: p.in_anchor_s ?? a.inStartS });
      return { ...s, clean: fill(s.clean), draft: fill(s.draft) };
    }
  }
}

/** The POST body: the draft's parameters for this pair. */
export const savePayload = (s: EditorState): TransitionParams & { from_track_id: number; to_track_id: number } =>
  ({ ...paramsOf(s.draft), from_track_id: s.row.from_track_id, to_track_id: s.row.to_track_id });

/** The row the preview plays: the unsaved draft for the same pair. */
export const draftTransition = (s: EditorState): SetTransition => ({ ...s.row, ...paramsOf(s.draft) });

/** Which Set Builder modal is open: the form dialog (new set, pair note) or the transition editor, never both. */
export function setBuilderModal(dialog: { kind: "new" | "pair" | "transition" } | null): "form" | "transition" | null {
  if (!dialog) return null;
  return dialog.kind === "transition" ? "transition" : "form";
}
