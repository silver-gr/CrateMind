// Transition vocabulary shared with the backend (`backend/app/services/set_transitions.py`): same literals.

export const PRESET_KEYS = ["auto", "custom", "fade", "rise", "blend", "wave", "melt", "slam", "dissolve", "surge", "afterglow", "none"] as const;
export const VOLUME_CURVES = ["smooth", "overlap", "fade_fade", "cut_fade", "fade_cut", "center_cut", "linear", "fade_fast"] as const;
export const EQ_CURVES = ["bass_swap_center", "bass_swap_end", "bass_swap_start", "three_band", "bass_cut_quick", "bass_cut_long", "fade_out_start", "bass_fade_out", "none"] as const;
export const FILTER_CURVES = ["lpf_out", "lpf_in", "lpf_in_lpf_out", "lpf_in_hpf_out", "hpf_out", "hpf_in", "hpf_in_hpf_out", "hpf_in_lpf_out", "hpf_half_out", "none"] as const;
export const LOOP_BEATS = [1, 2, 4, 8, 16] as const;
export const BARS_MIN = 1;
export const BARS_MAX = 32;
/** Backend resolver reasons, then the frontend planner's own (no_grid … grid_estimated). */
export const REASON_CODES = [
  "same_key", "adjacent_key", "relative_key", "key_clash", "key_unknown", "bpm_close", "bpm_far", "bpm_out_of_range", "bpm_unknown",
  "profile_cut", "profile_blend", "no_grid", "no_room", "exit_cue", "entry_cue", "grid_estimated",
] as const;

export type Preset = (typeof PRESET_KEYS)[number];
export type NamedPreset = Exclude<Preset, "auto" | "custom">;
export type VolumeCurve = (typeof VOLUME_CURVES)[number];
export type EqCurve = (typeof EQ_CURVES)[number];
export type FilterCurve = (typeof FILTER_CURVES)[number];
export type LoopBeats = (typeof LOOP_BEATS)[number];
export type ReasonCode = (typeof REASON_CODES)[number];

export interface TransitionParams {
  preset: Preset;
  bars: number;
  volume_curve: VolumeCurve;
  eq_curve: EqCurve;
  filter_curve: FilterCurve;
  loop_beats: LoopBeats | null;
  out_anchor_s: number | null;
  in_anchor_s: number | null;
  tempo_match: boolean;
}

export interface SetTransition extends TransitionParams {
  id: number | null;
  set_id: number;
  from_track_id: number;
  to_track_id: number;
  persisted: boolean;
  resolved_preset: NamedPreset | null;
  reasons: string[];
  updated_at: string | null;
}

export const pairKey = (from: number, to: number) => `${from}-${to}`;
