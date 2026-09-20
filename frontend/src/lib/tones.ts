import type { ChipTone } from "./queryChips";

/** Pill classes: tinted bg + readable light text + hairline border (all on the dark void). */
export const CHIP: Record<ChipTone, string> = {
  cyan: "border-cm-cyan/25 bg-cm-cyan/12 text-cm-cyan",
  blue: "border-cm-blue/25 bg-cm-blue/12 text-cm-blue",
  violet: "border-cm-violet/25 bg-cm-violet/14 text-cm-violet",
  chartreuse: "border-cm-chartreuse/25 bg-cm-chartreuse/12 text-cm-chartreuse",
  magenta: "border-cm-magenta/25 bg-cm-magenta/14 text-cm-magenta",
  amber: "border-cm-amber/25 bg-cm-amber/12 text-cm-amber",
  rose: "border-cm-rose/25 bg-cm-rose/14 text-cm-rose",
  muted: "border-cm-line/15 bg-cm-line/5 text-cm-muted",
};

export const TEXT: Record<ChipTone, string> = {
  cyan: "text-cm-cyan",
  blue: "text-cm-blue",
  violet: "text-cm-violet",
  chartreuse: "text-cm-chartreuse",
  magenta: "text-cm-magenta",
  amber: "text-cm-amber",
  rose: "text-cm-rose",
  muted: "text-cm-muted",
};
