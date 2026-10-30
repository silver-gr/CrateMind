import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 whitespace-nowrap min-w-[1.4rem] items-center justify-center rounded border border-cm-line/20 dark:border-white/15 bg-cm-line/5 dark:bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-muted shadow-[0_1px_0_rgba(0,0,0,0.4)]",
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
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      <span className="flex shrink-0 flex-wrap gap-1">
        {arr.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
      <span className="text-right text-cm-muted">{label}</span>
    </div>
  );
}
