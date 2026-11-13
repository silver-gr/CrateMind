import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 whitespace-nowrap min-w-[1.4rem] items-center justify-center rounded-[5px] border border-cm-contrast/15 bg-cm-contrast/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-muted shadow-[inset_0_-1px_0_var(--color-cm-border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A keyboard shortcut row: one or more keys + a description. */
export function KeyboardHint({ keys, label }: { keys: string | string[]; label: string }) {
  const arr = Array.isArray(keys) ? keys : [keys];
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-baseline gap-3 py-1 text-xs">
      <span className="flex flex-wrap gap-1">
        {arr.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
      <span className="text-pretty text-cm-muted">{label}</span>
    </div>
  );
}
