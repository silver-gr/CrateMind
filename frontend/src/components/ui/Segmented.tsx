import { type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { ChipTone } from "@/lib/queryChips";

/**
 * The value a press at `x` px across a meter `width` px wide gives: the meter is cut into `max` equal parts, so the gaps
 * between the dots count too. Null for a meter with no width.
 */
export function segmentedValueAt(x: number, width: number, max: number): number | null {
  if (!(width > 0) || max < 1) return null;
  return Math.max(1, Math.min(max, Math.floor((x / width) * max) + 1));
}

/**
 * Segmented 0..max meter. Read-only (spans) by default; pass `onChange` to make it a setter (TaggingQueue
 * energy/darkness/confidence, the decks' fast rating, the Set Builder's energy column). A pointer press anywhere on the
 * meter's row, dots, gaps and the space above and below them, gives the value under the pointer's x
 * (`segmentedValueAt`), so a caller can make the row taller than the dots (`className`) to widen the target; keyboard
 * users still tab to each dot. `ramp` colours filled segments along a hue scale (energy = cyan→chartreuse,
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
  title,
}: {
  value?: number | null;
  max?: number;
  tone?: ChipTone;
  ramp?: "energy" | "darkness";
  onChange?: (v: number) => void;
  className?: string;
  ariaLabel?: string;
  title?: string;
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
      : { background: "var(--cm-track)" };
    const base = "h-2 flex-1 rounded-full transition-colors";
    return onChange ? (
      <button
        key={i}
        type="button"
        aria-label={`${ariaLabel ?? "τιμή"} ${i + 1}`}
        // A pointer click is read by the row from its x; a keyboard press (detail 0) sets this dot's value.
        onClick={event => { if (event.detail === 0) onChange(i + 1); }}
        className={cn(base, "cursor-pointer hover:brightness-125")}
        style={style}
      />
    ) : (
      <span key={i} className={base} style={style} />
    );
  });

  return (
    <div role="meter" aria-valuenow={filled} aria-valuemax={max} aria-label={ariaLabel} title={title}
      onClick={onChange ? event => {
        if (event.detail === 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const next = segmentedValueAt(event.clientX - rect.left, rect.width, max);
        if (next != null) onChange(next);
      } : undefined}
      className={cn("flex items-center gap-1", onChange && "cursor-pointer", className)}>
      {segs}
    </div>
  );
}

export default Segmented;
