export const BACKGROUND_OPTIONS = [
  { value: "soft-aurora", label: "Soft Aurora" },
  { value: "scanner", label: "Scanner" },
  { value: "grainient", label: "Grainient · Lagoon" },
  { value: "grainient-aurora", label: "Grainient · Aurora" },
  { value: "threads", label: "Threads" },
  { value: "particles", label: "Particles" },
  { value: "aurora", label: "Aurora" },
  { value: "prismatic-burst", label: "Prismatic Burst" },
  { value: "faulty-terminal", label: "Faulty Terminal" },
  { value: "iridescence", label: "Iridescence · Pearl" },
  { value: "iridescence-violet", label: "Iridescence · Violet" },
  { value: "gradient-ascii", label: "Gradient ASCII" },
  { value: "prism", label: "Prism" },
  { value: "particles-warp", label: "Particles · Warp" },
  { value: "balatro", label: "Balatro" },
] as const;

export type BackgroundId = (typeof BACKGROUND_OPTIONS)[number]["value"];

export function isBackgroundId(value: unknown): value is BackgroundId {
  return BACKGROUND_OPTIONS.some((option) => option.value === value);
}
