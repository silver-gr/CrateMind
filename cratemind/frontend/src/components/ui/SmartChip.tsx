import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ChipTone } from "../../lib/queryChips";
import { CHIP } from "../../lib/tones";

/** Tinted pill. Clickable (button) when `onClick` is set, else a static span. */
export function SmartChip({
  children,
  tone = "muted",
  icon: Icon,
  active,
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const Comp: "button" | "span" = onClick ? "button" : "span";
  return (
    <Comp
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
        CHIP[tone],
        onClick && "cursor-pointer transition hover:brightness-125",
        active && "ring-1 ring-cm-cyan/50",
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </Comp>
  );
}
