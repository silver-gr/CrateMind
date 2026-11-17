import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { usePref } from "../../lib/prefs";
import { GlassPanel } from "../ui/GlassPanel";

/** A glass card of setting rows, with an optional micro-label title and a right-aligned action. */
export function SettingsCard({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <GlassPanel className={cn("min-w-0 overflow-hidden", className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-1 pt-4">
          {title && <h3 className="micro-label text-cm-faint">{title}</h3>}
          {action}
        </div>
      )}
      <div className="divide-y divide-cm-line/10">{children}</div>
    </GlassPanel>
  );
}

/** One setting: label and help text on the left, its control on the right (stacks when narrow). */
export function SettingRow({
  label,
  help,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const [density] = usePref("density");
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4", density === "compact" ? "py-2.5" : "py-3.5", className)}>
      <div className="min-w-0 flex-[1_1_16rem]">
        <p className="text-sm font-medium text-cm-text">{label}</p>
        {help && <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-cm-muted">{help}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Segmented choice for a setting with two or three options; the pressed option is lit in cyan. */
export function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border surface-field p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="h-7 cursor-pointer rounded-md px-3 text-xs font-medium text-cm-muted transition-[background-color,color,box-shadow] duration-150 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-cm-cyan/14 aria-pressed:text-cm-cyan aria-pressed:shadow-[inset_0_0_0_1px_oklch(from_var(--cm-cyan)_l_c_h/0.3)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
