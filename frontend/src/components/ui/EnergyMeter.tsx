import { cn } from "../../lib/cn";

/** Tiny horizontal meter for a 1–10 metric. Energy = cyan→chartreuse, darkness = blue→violet. */
export function EnergyMeter({
  value,
  max = 10,
  metric = "energy",
  showValue = true,
  className,
}: {
  value?: number | null;
  max?: number;
  metric?: "energy" | "darkness";
  showValue?: boolean;
  className?: string;
}) {
  if (value == null) return <span className="text-xs text-cm-faint">—</span>;
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  const grad =
    metric === "darkness"
      ? "linear-gradient(90deg, var(--color-cm-blue), var(--color-cm-violet))"
      : "linear-gradient(90deg, var(--color-cm-cyan), var(--color-cm-chartreuse))";
  return (
    <div className={cn("flex items-center gap-1.5 w-full min-w-0", className)}>
      <div className="h-1.5 flex-1 min-w-8 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: grad }} />
      </div>
      {showValue && (
        <span className="w-4 shrink-0 text-right text-[11px] font-mono tabular-nums text-cm-muted">{value}</span>
      )}
    </div>
  );
}
