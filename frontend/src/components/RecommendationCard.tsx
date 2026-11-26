import { bpmColor } from "../lib/bpmColor";
import { keyColor, camelotCode, toCamelot } from "../lib/camelot";
import { Play, Plus } from "../lib/icons";
import { axisLabel, translateRecommendationReason } from "../lib/labels";
import type { ChipTone } from "../lib/queryChips";
import type { Recommendation } from "../lib/types";
import { Artwork } from "./ui/Artwork";
import { GlassCard } from "./ui/GlassCard";
import { Segmented } from "./ui/Segmented";
import { SmartChip } from "./ui/SmartChip";
import { StatusBadge } from "./ui/StatusBadge";

/** Color a single recommendation reason: positives glow chartreuse, negatives warm to amber. */
function reasonTone(reason: string): ChipTone {
  const r = reason.trim();
  if (r.startsWith("-") || /recently|avoid|overplayed/i.test(r)) return "amber";
  if (r.startsWith("+")) return "chartreuse";
  return "muted";
}

const reasonRank = (tone: ChipTone) => (tone === "chartreuse" ? 0 : tone === "amber" ? 2 : 1);

/** Positives first, then neutral, then negatives; the server order is kept inside each group. */
function orderedReasons(reasons: string[]): { reason: string; tone: ChipTone }[] {
  return reasons
    .map(reason => ({ reason, tone: reasonTone(reason) }))
    .sort((a, b) => reasonRank(a.tone) - reasonRank(b.tone));
}

const DELTA_FORMAT = new Intl.NumberFormat("el-GR", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });

function deltaTone(pct: number): ChipTone {
  const d = Math.abs(pct);
  return d <= 1 ? "chartreuse" : d <= 2.5 ? "cyan" : d <= 4 ? "amber" : "rose";
}

const MATCH_HINT = "Μουσικό ταίριασμα: tempo, key και είδος. Η σειρά υπολογίζει και την κατάσταση και τις σημειώσεις μεταβάσεων.";

interface Props {
  rec: Recommendation;
  onAdd: (id: number) => void;
  onPlay?: (rec: Recommendation) => void;
}

export default function RecommendationCard({ rec, onAdd, onPlay }: Props) {
  const cam = toCamelot(rec.key);
  const keyCode = cam ? camelotCode(cam) : rec.key || null;

  return (
    <GlassCard spotlight className="p-3" data-track-id={rec.track_id}>
      <div className="flex items-start gap-3">
        {/* decorative gradient tile — CrateMind stores no artwork */}
        <Artwork seed={rec.track_id} className="h-10 w-10" />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-cm-text">
            {rec.artist || "—"} <span className="text-cm-faint">—</span> {rec.title || "χωρίς τίτλο"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-cm-muted">
            <span style={{color: bpmColor(rec.bpm)}} className="font-mono tabular-nums">{rec.bpm ? `${rec.bpm.toFixed(0)} BPM` : "— BPM"}</span>
            {rec.bpm_delta_pct != null && (
              <SmartChip tone={deltaTone(rec.bpm_delta_pct)} title="Διαφορά BPM από το Track A" className="px-1.5 py-0 font-mono text-[10px] tabular-nums">
                {DELTA_FORMAT.format(rec.bpm_delta_pct)}%
              </SmartChip>
            )}
            {keyCode && (
              <SmartChip tone="violet" className="px-1.5 py-0 font-mono text-[10px]">
                <span style={{color: keyColor(rec.key)}}>{keyCode}</span>
              </SmartChip>
            )}
            {rec.style && (
              <SmartChip tone="blue" className="px-1.5 py-0 text-[10px]">{rec.style}</SmartChip>
            )}
            <StatusBadge status={rec.personal_status} />
          </div>
          {rec.energy != null && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-cm-faint">{axisLabel("energy")}</span>
              <Segmented value={rec.energy} max={10} ramp="energy" className="w-28" ariaLabel={axisLabel("energy")} />
            </div>
          )}
        </div>

        <div className="shrink-0 text-right" title={MATCH_HINT}>
          <div className="font-mono text-xl font-bold leading-none tabular-nums text-cm-cyan">
            {rec.match != null ? `${Math.round(rec.match)}%` : "—"}
          </div>
          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-cm-faint">ταίριασμα</div>
        </div>
      </div>

      {rec.reasons.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {orderedReasons(rec.reasons).map(({ reason, tone }, i) => (
            <li key={i}>
              <SmartChip tone={tone} className="max-w-full justify-start whitespace-normal rounded-md px-1.5 py-0 text-left text-[10px] font-normal leading-snug">
                {translateRecommendationReason(reason)}
              </SmartChip>
            </li>
          ))}
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
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-cm-contrast/8 text-cm-muted transition motion-safe:active:scale-95 duration-100 ease-out hover:bg-cm-cyan/20 hover:text-cm-cyan"
          >
            <Play className="ml-0.5 h-3 w-3" />
          </button>
        )}
      </div>
    </GlassCard>
  );
}
