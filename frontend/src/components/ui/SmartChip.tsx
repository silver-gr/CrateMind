import type { ComponentType, ReactNode } from "react";
import { Badge } from "./badge";
import { cn } from "../../lib/cn";
import type { ChipTone } from "../../lib/queryChips";
import { CHIP } from "../../lib/tones";

/** Tinted pill (shadcn Badge base). Clickable (button) when `onClick` is set, else a static span. */
export function SmartChip({
  children,
  tone = "muted",
  icon: Icon,
  active,
  pressed,
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  /** Toggle state for assistive tech (`aria-pressed`) when the chip is a button. */
  pressed?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const cls = cn(
    "px-2.5 py-1",
    CHIP[tone],
    active && "ring-1 ring-cm-cyan/50",
    onClick && "cursor-pointer transition hover:brightness-125",
    className,
  );
  const content = (
    <>
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </>
  );

  if (onClick) {
    return (
      <Badge asChild variant="outline" className={cls}>
        <button type="button" onClick={onClick} title={title} aria-pressed={pressed}>
          {content}
        </button>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cls} title={title}>
      {content}
    </Badge>
  );
}
