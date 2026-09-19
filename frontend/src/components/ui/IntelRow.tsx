import { cn } from "@/lib/cn";
import type { ChipTone } from "@/lib/queryChips";

const DOT: Record<ChipTone, string> = {
  cyan: "bg-cm-cyan",
  blue: "bg-cm-blue",
  violet: "bg-cm-violet",
  chartreuse: "bg-cm-chartreuse",
  magenta: "bg-cm-magenta",
  amber: "bg-cm-amber",
  rose: "bg-cm-rose",
  muted: "bg-cm-faint",
};

/** A labelled status/coverage row for the Dashboard "Intelligence Status" panel. */
export function IntelRow({
  label,
  value,
  tone = "cyan",
  pct,
  className,
}: {
  label: string;
  value?: string;
  tone?: ChipTone;
  pct?: number; // 0..1 → thin progress bar under the row
  className?: string;
}) {
  return (
    <div className={cn("py-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-cm-muted">{label}</span>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-cm-text">
          {value}
          <span className={cn("h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor]", DOT[tone])} />
        </span>
      </div>
      {pct != null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/8">
          <div className={cn("h-full rounded-full", DOT[tone])} style={{ width: `${Math.max(0, Math.min(1, pct)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export default IntelRow;
