import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ChipTone } from "../../lib/queryChips";
import { TEXT } from "../../lib/tones";
import { Skeleton } from "./skeleton";
import { AnimatedNumber } from "./AnimatedNumber";

/** Big-number stat card. Becomes a button when `onClick` is provided. */
export function MetricCard({
  value,
  label,
  hint,
  icon: Icon,
  tone = "cyan",
  onClick,
  footer,
  className,
  animate = true,
  loading = false,
}: {
  value: ReactNode;
  loading?: boolean;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  tone?: ChipTone;
  onClick?: () => void;
  footer?: ReactNode;
  className?: string;
  /** Count-up the value when it is a number (default true). Strings render as-is. */
  animate?: boolean;
}) {
  const Comp: "button" | "div" = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      aria-busy={loading}
      className={cn(
        "glass group relative block overflow-hidden rounded-2xl p-4 text-left",
        onClick && "lift cursor-pointer",
        className,
      )}
    >
      {/* Tone halo: a soft blurred disc of the card's accent in the top-right corner. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-10 -right-10 size-28 rounded-full bg-current opacity-10 blur-2xl transition-opacity duration-300 ease-out group-hover:opacity-20",
          TEXT[tone],
        )}
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className={cn("text-4xl font-bold tabular-nums leading-none tracking-[-0.03em]", TEXT[tone])}>
          {loading ? <Skeleton aria-label="Φόρτωση αριθμού" className="h-9 w-24 bg-cm-line/15" /> : animate && typeof value === "number" ? <AnimatedNumber value={value} /> : value}
        </div>
        {Icon && (
          <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-current/10 ring-1 ring-current/25 ring-inset", TEXT[tone])}>
            <Icon className="size-3.5" />
          </span>
        )}
      </div>
      <div className="relative mt-2 text-[13px] font-medium text-cm-muted">{label}</div>
      {hint && <div className="relative mt-0.5 text-xs text-cm-faint">{hint}</div>}
      {footer && <div className="relative mt-2">{footer}</div>}
    </Comp>
  );
}
