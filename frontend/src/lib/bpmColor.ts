/** Psytrance tempo bands; shared boundaries belong to the higher band. */
export function bpmColor(value?: number | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const bands = [
    { min: 135, max: 145, hue: 180, end: 200 },
    { min: 145, max: 155, hue: 225, end: 245 },
    { min: 155, max: 180, hue: 275, end: 305 },
    { min: 180, max: 200, hue: 85, end: 55 },
    { min: 200, max: 250, hue: 30, end: 0 },
  ];
  const bpm = Math.max(135, Math.min(250, value));
  const band = bands.find(b => bpm < b.max) ?? bands[4];
  const fraction = (bpm - band.min) / (band.max - band.min);
  return `oklch(var(--cm-key-lightness, 0.76) 0.17 ${band.hue + (band.end - band.hue) * fraction})`;
}
