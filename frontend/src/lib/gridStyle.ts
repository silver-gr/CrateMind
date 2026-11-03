/** Deck beatgrid look. Widths and sizes are CSS pixels (scaled by the DPR when drawn); alphas multiply the estimated-grid dimming. */
export interface GridLine { width: number; alpha: number; halo: number }
export interface GridStyle {
  bar: GridLine;
  beat: GridLine;
  label: { size: number; weight: number; alpha: number; box: number };
}

const SOFT: GridStyle = {
  bar: { width: 1, alpha: 0.55, halo: 0.3 },
  beat: { width: 1, alpha: 0.28, halo: 0.18 },
  label: { size: 9, weight: 500, alpha: 0.55, box: 0.35 },
};

const STRONG: GridStyle = {
  bar: { width: 2, alpha: 1, halo: 0.75 },
  beat: { width: 1, alpha: 0.75, halo: 0.5 },
  label: { size: 10, weight: 500, alpha: 0.8, box: 0.5 },
};

/** The subtle default, or the «Έντονο beatgrid» toggle's stronger lines. */
export function gridStyle(strong: boolean): GridStyle {
  return strong ? STRONG : SOFT;
}
