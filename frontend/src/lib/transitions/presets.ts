import table from "./presets.json";
import type { EqCurve, FilterCurve, LoopBeats, NamedPreset, Preset, TransitionParams, VolumeCurve } from "./types";

export interface PresetSpec { volume_curve: VolumeCurve; eq_curve: EqCurve; filter_curve: FilterCurve; bars: number; loop_beats: LoopBeats | null }

/** Appendix B table; mirrored by the backend's `PRESETS`. `none` has bars 0 (a cut); its curves are placeholders. */
export const PRESETS = table as Record<NamedPreset, PresetSpec>;

const NAMED = Object.keys(PRESETS) as NamedPreset[];

/** The named preset whose curves + loop match (bars are free), `none` for zero bars, else `custom`. Never `auto`. */
export function presetFor(params: TransitionParams): Preset {
  if (params.bars === 0) return "none";
  return NAMED.find(name => {
    if (name === "none") return false;
    const spec = PRESETS[name];
    return spec.volume_curve === params.volume_curve && spec.eq_curve === params.eq_curve
      && spec.filter_curve === params.filter_curve && spec.loop_beats === params.loop_beats;
  }) ?? "custom";
}

/** A named preset sets its curves, bars and loop and keeps anchors + tempo match. `auto`/`custom` only relabel
 *  (Auto's resolved parameters come from the server row). */
export function applyPreset(preset: Preset, current: TransitionParams): TransitionParams {
  if (preset === "auto" || preset === "custom") return { ...current, preset };
  return { ...current, ...PRESETS[preset], preset };
}
