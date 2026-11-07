import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Designed empty state: glyph + title + opinionated copy + optional action. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-cm-line/20 dark:border-white/10 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-cm-contrast/5">
          <Icon className="h-5 w-5 text-cm-faint" />
        </div>
      )}
      <div className="text-sm font-medium text-cm-text">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed text-cm-muted">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
