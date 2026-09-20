import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface ResizeHandleProps extends HTMLAttributes<HTMLDivElement> {
  orientation: "vertical" | "horizontal";
  isDragging?: boolean;
  onDoubleClick?: () => void;
  ariaLabel?: string;
}

/**
 * Visual drag handle for resizing sidebars and panels.
 * Features an expanded touch/pointer hitbox and high-visibility
 * neon cyan glow during hover/active dragging.
 * Stays transparent at rest to avoid duplicate borders.
 */
export function ResizeHandle({
  orientation,
  isDragging = false,
  className,
  ariaLabel = "Αλλαγή μεγέθους",
  ...props
}: ResizeHandleProps) {
  const isVertical = orientation === "vertical";

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={ariaLabel}
      title="Σύρετε για αλλαγή μεγέθους · διπλό κλικ για επαναφορά"
      className={cn(
        "group flex touch-none select-none items-center justify-center transition-colors focus-visible:outline-none",
        isVertical ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize",
        className,
      )}
      {...props}
    >
      {/* Hairline indicator: transparent when idle, glows neon cyan on hover/drag */}
      <div
        className={cn(
          "transition-all duration-150 rounded-full",
          isVertical ? "w-[2px] h-full group-hover:w-[3px]" : "h-[2px] w-full group-hover:h-[3px]",
          isDragging
            ? "bg-cm-cyan shadow-[0_0_12px_var(--color-cm-cyan)] opacity-100"
            : "bg-transparent group-hover:bg-cm-cyan/70 group-hover:shadow-[0_0_8px_var(--color-cm-cyan)] opacity-0 group-hover:opacity-100",
        )}
      />

      {/* Centered micro grip pip for visual affordance on hover/drag */}
      <div
        className={cn(
          "pointer-events-none absolute rounded-full bg-cm-cyan transition-all duration-150",
          isVertical ? "h-6 w-1" : "h-1 w-6",
          isDragging
            ? "scale-110 opacity-100 shadow-[0_0_10px_var(--color-cm-cyan)]"
            : "opacity-0 group-hover:opacity-100 group-hover:scale-100 scale-75",
        )}
      />
    </div>
  );
}

export default ResizeHandle;
