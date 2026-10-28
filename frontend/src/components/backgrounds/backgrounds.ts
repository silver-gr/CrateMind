export const BACKGROUND_OPTIONS = [
  { value: "soft-aurora", label: "Soft Aurora" },
  { value: "scanner", label: "Scanner" },
  { value: "ferrofluid", label: "Ferrofluid · Frost" },
  { value: "grainient", label: "Grainient · Lagoon" },
  { value: "threads", label: "Threads" },
  { value: "particles", label: "Particles" },
  { value: "aurora", label: "Aurora" },
] as const;

export type BackgroundId = (typeof BACKGROUND_OPTIONS)[number]["value"];

export function isBackgroundId(value: unknown): value is BackgroundId {
  return BACKGROUND_OPTIONS.some((option) => option.value === value);
}
