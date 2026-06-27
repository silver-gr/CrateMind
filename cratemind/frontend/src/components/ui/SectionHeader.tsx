import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Uppercase micro-label section divider with an optional right-aligned slot. */
export function SectionHeader({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cm-faint">{children}</h2>
      {right}
    </div>
  );
}
