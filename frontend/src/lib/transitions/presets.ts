import table from "./presets.json";
import type { EqCurve, FilterCurve, HandPreset, LoopBeats, NamedPreset, Preset, TransitionParams, VolumeCurve } from "./types";

export interface PresetSpec { volume_curve: VolumeCurve; eq_curve: EqCurve; filter_curve: FilterCurve; bars: number; loop_beats: LoopBeats | null }

/** Appendix B table; mirrored by the backend's `PRESETS`. `none` has bars 0 (a cut); its curves are placeholders. */
export const PRESETS = table as Record<NamedPreset, PresetSpec>;

/**
 * The presets a DJ picks by hand (Auto never does, so the mirrored table above does not hold them).
 * «Έξοδος με echo»: the outgoing deck plays alone for the first half with its Echo rising at the end, the cut is at the
 * middle and the tail rings over the second half. «Μακριά ανάμειξη»: 32 bars with the staged EQ swap.
 * «Ηρεμία και drop»: the outgoing deck thins out under a rising high-pass and falls to a one-bar lull; the incoming deck
 * comes in at full weight on the window's end. «Μία ζώνη τη φορά»: highs, then mids, then the lows on the window's end.
 */
export const HAND_PRESETS: Record<HandPreset, PresetSpec> = {
  echo_out: { volume_curve: "echo_out", eq_curve: "none", filter_curve: "none", bars: 16, loop_beats: null },
  long_blend: { volume_curve: "fade_cut", eq_curve: "bass_swap_staged", filter_curve: "none", bars: 32, loop_beats: null },
  lull_drop: { volume_curve: "lull_drop", eq_curve: "none", filter_curve: "hpf_out", bars: 16, loop_beats: null },
  band_by_band: { volume_curve: "overlap", eq_curve: "band_by_band", filter_curve: "none", bars: 16, loop_beats: null },
};

const SPECS: Record<NamedPreset | HandPreset, PresetSpec> = { ...PRESETS, ...HAND_PRESETS };
const NAMED = Object.keys(SPECS) as (NamedPreset | HandPreset)[];

/** The named preset whose curves + loop match (bars are free), `none` for zero bars, else `custom`. Never `auto`. */
export function presetFor(params: TransitionParams): Preset {
  if (params.bars === 0) return "none";
  return NAMED.find(name => {
    if (name === "none") return false;
    const spec = SPECS[name];
    return spec.volume_curve === params.volume_curve && spec.eq_curve === params.eq_curve
      && spec.filter_curve === params.filter_curve && spec.loop_beats === params.loop_beats;
  }) ?? "custom";
}

/** A named preset sets its curves, bars and loop and keeps anchors + tempo match. `auto`/`custom` only relabel
 *  (Auto's resolved parameters come from the server row). */
export function applyPreset(preset: Preset, current: TransitionParams): TransitionParams {
  if (preset === "auto" || preset === "custom") return { ...current, preset };
  return { ...current, ...SPECS[preset], preset };
}
