import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Interactive glass surface with a subtle hover lift. */
export function GlassCard({
  className,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "glass rounded-2xl",
        interactive &&
          "cursor-pointer transition duration-200 hover:-translate-y-0.5 hover:border-cm-cyan/30",
        className,
      )}
      {...props}
    />
  );
}
