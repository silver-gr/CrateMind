import * as React from "react";
import { cn } from "@/lib/cn";

export interface ScrollFadeProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both";
  size?: number;
}

/**
 * ScrollFade component — adds scroll-aware CSS mask edge fades to a scroll container.
 * Zero JS, pure CSS mask-image based.
 */
export function ScrollFade({
  className,
  orientation = "vertical",
  size = 48,
  style,
  onScroll,
  ...props
}: ScrollFadeProps) {
  const utilityClass =
    orientation === "horizontal"
      ? "scroll-fade-x"
      : orientation === "both"
        ? "scroll-fade-x scroll-fade-y"
        : "scroll-fade-y";

  return (
    <div
      data-slot="scroll-fade"
      data-at-top="true"
      onScroll={(e) => {
        const el = e.currentTarget;
        const atTop = el.scrollTop <= 2;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        const topVal = atTop ? "true" : "false";
        const btmVal = atBottom ? "true" : "false";
        if (el.dataset.atTop !== topVal) el.dataset.atTop = topVal;
        if (el.dataset.atBottom !== btmVal) el.dataset.atBottom = btmVal;
        onScroll?.(e);
      }}
      style={{
        ...style,
        ...(size !== 48 ? ({ "--scroll-fade-size": `${size}px` } as React.CSSProperties) : {}),
      }}
      className={cn(utilityClass, className)}
      {...props}
    />
  );
}
