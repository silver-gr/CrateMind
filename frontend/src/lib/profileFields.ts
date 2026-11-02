import { axisLabel } from "./labels";
import { getPref, type LibraryProfile } from "./prefs";
import type { Profile } from "./types";

export type NumField = { key: keyof Profile; label: string; max: number };

/** The numeric sliders of the profile editors. Therapy: arousal and valence first, no darkness. */
export function numFields(profile: LibraryProfile = getPref("libraryProfile")): NumField[] {
  const rest: NumField[] = [
    { key: "melody", label: "Μελωδία", max: 10 },
    { key: "weirdness", label: "Ιδιορρυθμία", max: 10 },
    { key: "chaos_level", label: "Χάος", max: 10 },
    { key: "mixability", label: "Mixability", max: 5 },
    { key: "confidence", label: "Σιγουριά", max: 5 },
  ];
  const energy: NumField = { key: "energy", label: axisLabel("energy", profile), max: 10 };
  const intensity: NumField = { key: "intensity", label: "Ένταση", max: 10 };
  return profile === "therapy"
    ? [energy, { key: "valence", label: axisLabel("valence", profile), max: 10 }, intensity, ...rest]
    : [energy, intensity, { key: "darkness", label: axisLabel("darkness", profile), max: 10 }, ...rest];
}
