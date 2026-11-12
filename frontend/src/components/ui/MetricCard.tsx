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
        onClick && "lift cursor-pointer hover:-translate-y-0.5 hover:border-cm-border-hi",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className={cn("text-4xl font-bold tabular-nums leading-none tracking-tight", TEXT[tone])}>
          {loading ? <Skeleton aria-label="Φόρτωση αριθμού" className="h-9 w-24 bg-cm-line/15" /> : animate && typeof value === "number" ? <AnimatedNumber value={value} /> : value}
        </div>
        {Icon && <Icon className={cn("h-5 w-5 opacity-50 transition group-hover:opacity-90", TEXT[tone])} />}
      </div>
      <div className="mt-2 text-sm font-medium text-cm-text">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-cm-faint">{hint}</div>}
      {footer && <div className="mt-2">{footer}</div>}
    </Comp>
  );
}
