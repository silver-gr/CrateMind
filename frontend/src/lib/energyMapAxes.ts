import { axisLabel, type Axis } from "./labels";
import type { LibraryProfile } from "./prefs";

export type Band = [number, number];

/** One axis of the 5×5 map. `bands` are in display order: cols low→high, rows high→low (high on top). */
export type MapAxis = { field: Axis; label: string; legend: string; bands: Band[] };

export type EnergyMapAxes = { cols: MapAxis; rows: MapAxis; cellQuery(col: Band, row: Band): string };

// Coarse 5×5 bands for the 2D grid (25 exact-count calls).
const BANDS: Band[] = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
const HIGH_TO_LOW: Band[] = [...BANDS].reverse();

/** DJ: energy × darkness. Therapy: the circumplex, valence (cols) × arousal (rows). */
export function energyMapAxes(profile: LibraryProfile): EnergyMapAxes {
  if (profile === "therapy") {
    const valence = axisLabel("valence", profile);
    const arousal = axisLabel("energy", profile);
    return {
      cols: { field: "valence", label: valence, legend: `${valence} →`, bands: BANDS },
      rows: { field: "energy", label: arousal, legend: `${arousal} ↑`, bands: HIGH_TO_LOW },
      cellQuery: (c, r) => `valence:${c[0]}-${c[1]} energy:${r[0]}-${r[1]}`,
    };
  }
  return {
    cols: { field: "energy", label: "Ένταση", legend: "← χαμηλή ένταση · υψηλή ένταση →", bands: BANDS },
    rows: { field: "darkness", label: "Σκοτάδι", legend: "↑ βαθύ σκοτάδι", bands: HIGH_TO_LOW },
    cellQuery: (c, r) => `energy:${c[0]}-${c[1]} darkness:${r[0]}-${r[1]}`,
  };
}

export function energyMapTitle(profile: LibraryProfile): string {
  return profile === "therapy" ? "Χάρτης συναισθήματος" : "Energy Maps";
}
