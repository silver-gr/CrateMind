import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Base translucent surface. `strong` for the more opaque variant. */
export function GlassPanel({
  className,
  strong,
  ...props
}: HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return <div className={cn(strong ? "glass-strong" : "glass", "rounded-2xl", className)} {...props} />;
}
