import { type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { ChipTone } from "@/lib/queryChips";

/**
 * Segmented 0..max meter. Read-only (spans) by default; pass `onChange` to make
 * each segment a clickable setter (TaggingQueue energy/darkness/confidence).
 * `ramp` colours filled segments along a hue scale (energy = cyan→chartreuse,
 * darkness = blue→violet); otherwise a flat tone colour is used.
 */
export function Segmented({
  value,
  max = 10,
  tone = "cyan",
  ramp,
  onChange,
  className,
  ariaLabel,
}: {
  value?: number | null;
  max?: number;
  tone?: ChipTone;
  ramp?: "energy" | "darkness";
  onChange?: (v: number) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const filled = value == null ? 0 : Math.max(0, Math.min(max, Math.round(value)));

  function fillColor(i: number): string {
    const t = max > 1 ? i / (max - 1) : 0;
    if (ramp === "energy") return `oklch(0.85 0.17 ${205 - 77 * t})`; // cyan→chartreuse
    if (ramp === "darkness") return `oklch(0.70 0.19 ${252 + 48 * t})`; // blue→violet
    return `var(--color-cm-${tone})`;
  }

  const segs = Array.from({ length: max }, (_, i) => {
    const on = i < filled;
    const style: CSSProperties = on
      ? { background: fillColor(i) }
      : { background: "oklch(0.82 0.07 250 / 0.14)" };
    const base = "h-2 flex-1 rounded-full transition-colors";
    return onChange ? (
      <button
        key={i}
        type="button"
        aria-label={`${ariaLabel ?? "τιμή"} ${i + 1}`}
        onClick={() => onChange(i + 1)}
        className={cn(base, "cursor-pointer hover:brightness-125")}
        style={style}
      />
    ) : (
      <span key={i} className={base} style={style} />
    );
  });

  return (
    <div role="meter" aria-valuenow={filled} aria-valuemax={max} aria-label={ariaLabel} className={cn("flex items-center gap-1", className)}>
      {segs}
    </div>
  );
}

export default Segmented;
