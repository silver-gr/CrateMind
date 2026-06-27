import { cn } from "../../lib/cn";
import { statusLabel } from "../../lib/labels";
import type { ChipTone } from "../../lib/queryChips";
import { CHIP } from "../../lib/tones";

const STATUS: Record<string, { tone: ChipTone }> = {
  unknown: { tone: "muted" },
  needs_review: { tone: "amber" },
  testing: { tone: "blue" },
  approved: { tone: "cyan" },
  weapon: { tone: "chartreuse" },
  overplayed: { tone: "amber" },
  retired: { tone: "muted" },
  avoid: { tone: "rose" },
};

/** Compact DJ-status pill. Returns null for unknown/empty so untagged rows stay quiet. */
export function StatusBadge({
  status,
  className,
  quietUnknown = true,
}: {
  status?: string | null;
  className?: string;
  quietUnknown?: boolean;
}) {
  if (!status || (quietUnknown && status === "unknown")) return null;
  const s = STATUS[status] ?? { tone: "muted" as ChipTone };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        CHIP[s.tone],
        s.tone === "chartreuse" && "glow-chartreuse",
        className,
      )}
    >
      {statusLabel(status)}
    </span>
  );
}
