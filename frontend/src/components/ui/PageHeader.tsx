import type { ComponentType, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";
import { usePref } from "../../lib/prefs";

/**
 * The one page header: icon tile, sheen title, optional count and subtitle, actions on the right, on a glass bar
 * with a hairline under it. Put it above the page's scroll area, or pass `sticky` when the page itself scrolls.
 */
export function PageHeader({
  icon: Icon,
  title,
  count,
  subtitle,
  actions,
  sticky,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  count?: number | string | null;
  subtitle?: ReactNode;
  actions?: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  return (
    <header
      className={cn(
        "z-40 flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-cm-border bg-cm-glass-strong px-6 py-3 backdrop-blur-xl",
        sticky ? "sticky top-0" : "relative",
        className,
      )}
    >
      {Icon && (
        <div aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-cm-cyan/10 text-cm-cyan ring-1 ring-cm-cyan/25 ring-inset">
          <Icon className="size-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1
            data-still={osReduce || prefReduce || undefined}
            className="cm-title-sheen text-lg leading-snug font-semibold tracking-tight text-balance"
          >
            {title}
          </h1>
          {count != null && (
            <span className="shrink-0 rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 font-mono text-xs text-cm-muted tabular-nums">
              {typeof count === "number" ? count.toLocaleString("el-GR") : count}
            </span>
          )}
        </div>
        {subtitle && <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-pretty text-cm-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
