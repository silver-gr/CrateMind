import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ChipTone } from "../../lib/queryChips";
import { TEXT } from "../../lib/tones";

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
}: {
  value: ReactNode;
  label: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  tone?: ChipTone;
  onClick?: () => void;
  footer?: ReactNode;
  className?: string;
}) {
  const Comp: "button" | "div" = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "glass group relative block overflow-hidden rounded-2xl p-4 text-left",
        onClick && "cursor-pointer transition duration-200 hover:-translate-y-0.5 hover:border-cm-cyan/30",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className={cn("text-4xl font-bold tabular-nums leading-none tracking-tight", TEXT[tone])}>
          {value}
        </div>
        {Icon && <Icon className={cn("h-5 w-5 opacity-50 transition group-hover:opacity-90", TEXT[tone])} />}
      </div>
      <div className="mt-2 text-sm font-medium text-cm-text">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-cm-faint">{hint}</div>}
      {footer && <div className="mt-2">{footer}</div>}
    </Comp>
  );
}
