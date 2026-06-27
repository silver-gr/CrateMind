import { cn } from "../lib/cn";
import { CircleDot, Play, Plus } from "../lib/icons";
import { translateRecommendationReason } from "../lib/labels";
import type { ChipTone } from "../lib/queryChips";
import { TEXT } from "../lib/tones";
import type { Recommendation } from "../lib/types";
import { GlassCard } from "./ui/GlassCard";
import { StatusBadge } from "./ui/StatusBadge";

/** Color a single recommendation reason: positives glow chartreuse, negatives warm to amber. */
function reasonTone(reason: string): ChipTone {
  const r = reason.trim();
  if (r.startsWith("-") || /recently|avoid|overplayed/i.test(r)) return "amber";
  if (r.startsWith("+")) return "chartreuse";
  return "muted";
}

interface Props {
  rec: Recommendation;
  onAdd: (id: number) => void;
  onPlay?: (rec: Recommendation) => void;
}

export default function RecommendationCard({ rec, onAdd, onPlay }: Props) {
  return (
    <GlassCard className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-cm-text">
            {rec.artist || "—"} <span className="text-cm-faint">—</span> {rec.title || "χωρίς τίτλο"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-cm-muted">
            <span className="font-mono tabular-nums">{rec.bpm ? `${rec.bpm.toFixed(0)} BPM` : "— BPM"}</span>
            <span className="font-mono">{rec.key || "—"}</span>
            <StatusBadge status={rec.personal_status} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-xl font-bold leading-none tabular-nums text-cm-cyan">
            {rec.score}
          </div>
          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-cm-faint">
            σκορ
          </div>
        </div>
      </div>

      {rec.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rec.reasons.map((reason, i) => {
            const tone = reasonTone(reason);
            return (
              <li
                key={i}
                className={cn("flex items-start gap-1.5 text-[11px] leading-snug", TEXT[tone])}
              >
                <CircleDot className="mt-[3px] h-2.5 w-2.5 shrink-0" />
                <span>{translateRecommendationReason(reason)}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => onAdd(rec.track_id)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-cm-cyan/12 px-2.5 py-1 text-[11px] font-medium text-cm-cyan transition hover:bg-cm-cyan/25"
        >
          <Plus className="h-3 w-3" /> στο set
        </button>
        {onPlay && (
          <button
            onClick={() => onPlay(rec)}
            title="Ακρόαση"
            aria-label="Ακρόαση πρότασης"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-white/8 text-cm-muted transition hover:bg-cm-cyan/20 hover:text-cm-cyan"
          >
            <Play className="ml-0.5 h-3 w-3" />
          </button>
        )}
      </div>
    </GlassCard>
  );
}
