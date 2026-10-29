import { useTheme } from "../../lib/theme";
import { Sun, Moon } from "../../lib/icons";
import { cn } from "../../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface ThemeToggleProps {
  compact?: boolean;
  className?: string;
}

/**
 * ThemeToggle (Night Void ⇄ Solar Void)
 *
 * Implements CrateMind's daylight inversion switch.
 * Supports compact (icon-only for collapsed sidebar / header) and full variant.
 */
export function ThemeToggle({ compact = false, className }: ThemeToggleProps) {
  const [theme, , toggleTheme] = useTheme();
  const isDark = theme === "dark";

  const label = isDark ? "Ηλιακό Φως (Solar Void)" : "Νυχτερινό Κενό (Night Void)";
  const currentLabel = isDark ? "Νυχτερινό Κενό" : "Ηλιακό Φως";

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Εναλλαγή σε ${label}`}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-xl border surface-field text-cm-muted transition-all duration-200 hover:border-cm-cyan/40 hover:bg-cm-cyan/10 hover:text-cm-cyan active:scale-95",
              className,
            )}
          >
            {isDark ? (
              <Sun className="h-4 w-4 transition-transform duration-300 hover:rotate-45 text-cm-amber" />
            ) : (
              <Moon className="h-4 w-4 transition-transform duration-300 hover:-rotate-12 text-cm-violet" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p className="text-xs">Εναλλαγή σε {label}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Εναλλαγή σε ${label}`}
      className={cn(
        "group flex w-full items-center justify-between gap-2.5 rounded-xl border surface-field px-3 py-2 text-sm text-cm-muted transition-all duration-200 hover:border-cm-cyan/30 hover:bg-cm-cyan/10 hover:text-cm-text active:scale-[0.99]",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {isDark ? (
          <Moon className="h-4 w-4 text-cm-cyan transition-transform group-hover:-rotate-12" />
        ) : (
          <Sun className="h-4 w-4 text-cm-amber transition-transform group-hover:rotate-45" />
        )}
        <span className="text-xs font-medium text-cm-text">{currentLabel}</span>
      </div>
      <span className="rounded-md border border-cm-line/15 bg-cm-line/5 px-1.5 py-0.5 font-mono text-[10px] text-cm-faint group-hover:text-cm-muted">
        {isDark ? "Daylight ☀" : "Night ☾"}
      </span>
    </button>
  );
}

export default ThemeToggle;
