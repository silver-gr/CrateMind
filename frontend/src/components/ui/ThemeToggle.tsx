import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { setThemeAnimated, useTheme } from "../../lib/theme";
import { Sun, Moon } from "../../lib/icons";
import { cn } from "../../lib/cn";
import { footerIconButtonClass } from "../../lib/footerControlStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface ThemeToggleProps {
  className?: string;
  /** Tooltip side: "top" in the footer and island, "right" on the rail. */
  tooltipSide?: "top" | "right";
}

/**
 * ThemeToggle (Night Void ⇄ Solar Void)
 *
 * Implements CrateMind's daylight inversion switch as an icon-only button.
 */
export function ThemeToggle({ className, tooltipSide = "top" }: ThemeToggleProps) {
  const [theme] = useTheme();
  const isDark = theme === "dark";
  // The new theme opens as a circle from the button centre (keyboard activation included).
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setThemeAnimated(isDark ? "light" : "dark", r.left + r.width / 2, r.top + r.height / 2, flushSync);
  };

  const label = isDark ? "Ηλιακό Φως (Solar Void)" : "Νυχτερινό Κενό (Night Void)";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          aria-label={`Εναλλαγή σε ${label}`}
          className={cn(
            footerIconButtonClass,
            className,
          )}
        >
          {isDark ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        <p className="text-xs">Εναλλαγή σε {label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
