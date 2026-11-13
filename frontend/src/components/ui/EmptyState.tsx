import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Designed empty state: glyph + title + opinionated copy + optional action. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
  celebrate = false,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Rare success moment (e.g. a queue confirmed empty): the glyph pops in and its ring pulses twice. Off by default. */
  celebrate?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-dashed border-cm-border bg-[radial-gradient(120%_70%_at_50%_0%,oklch(from_var(--cm-cyan)_l_c_h/0.07),transparent_70%)] px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "mb-1 grid size-12 place-items-center rounded-2xl ring-1 ring-inset",
            celebrate
              ? "cm-celebrate bg-cm-chartreuse/12 text-cm-chartreuse ring-cm-chartreuse/25"
              : "bg-cm-cyan/10 text-cm-cyan ring-cm-cyan/20 shadow-[0_0_28px_-6px_var(--color-cm-cyan)]",
          )}
        >
          <Icon className="size-5" />
        </div>
      )}
      <div className="text-[15px] font-semibold tracking-tight text-balance text-cm-text">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed text-pretty text-cm-muted">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
