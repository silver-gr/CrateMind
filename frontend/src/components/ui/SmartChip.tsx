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
  ariaDisabled,
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
  /** Unavailable but still focusable, so its `title` explains why (`aria-disabled`; the click still reaches `onClick`). */
  ariaDisabled?: boolean;
  className?: string;
}) {
  const cls = cn(
    "px-2.5 py-1",
    CHIP[tone],
    active && "ring-1 ring-current/45 shadow-[0_0_12px_-4px_currentColor]",
    onClick && !ariaDisabled && "cursor-pointer transition-[border-color,background-color,box-shadow,scale] duration-150 hover:border-current/50 motion-safe:active:scale-[0.96]",
    ariaDisabled && "cursor-not-allowed opacity-50",
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
        <button type="button" onClick={onClick} title={title} aria-pressed={pressed} aria-disabled={ariaDisabled || undefined}>
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
