import { Fragment } from "react";
import { bpmColor } from "../lib/bpmColor";
import { keyColor, camelotCode, toCamelot } from "../lib/camelot";
import { Play, Plus } from "../lib/icons";
import { axisLabel, translateRecommendationReason } from "../lib/labels";
import type { ChipTone } from "../lib/queryChips";
import { TEXT } from "../lib/tones";
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

const RUN_ORDER: ChipTone[] = ["chartreuse", "muted", "amber"];
const RUN_SIGN: Partial<Record<ChipTone, string>> = { chartreuse: "+", muted: "·", amber: "−" };

/** Positives, then neutral, then negatives, each as one run without its per-reason sign; the server order is kept inside a run. */
function reasonRuns(reasons: string[]): { tone: ChipTone; texts: string[] }[] {
  return RUN_ORDER
    .map(tone => ({ tone, texts: reasons.filter(reason => reasonTone(reason) === tone).map(reason => translateRecommendationReason(reason).replace(/^[+-]\s*/, "")) }))
    .filter(run => run.texts.length > 0);
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
      {/* Title over artist beside the tile, each on its own line; the facts below run the card's full width. */}
      <div className="flex items-start gap-3">
        {/* decorative gradient tile — CrateMind stores no artwork */}
        <Artwork seed={rec.track_id} className="h-10 w-10" />

        <div className="min-w-0 flex-1" title={`${rec.artist || "—"} — ${rec.title || "χωρίς τίτλο"}`}>
          <div className="line-clamp-2 text-sm font-medium leading-5 text-cm-text">{rec.title || "χωρίς τίτλο"}</div>
          <div className="truncate text-xs text-cm-muted">{rec.artist || "—"}</div>
        </div>

        <div className="shrink-0 text-right" title={MATCH_HINT}>
          <div className="font-mono text-xl font-bold leading-none tabular-nums text-cm-cyan">
            {rec.match != null ? `${Math.round(rec.match)}%` : "—"}
          </div>
          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-cm-faint">ταίριασμα</div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-cm-muted">
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

      {/* The reasons, one run per kind (for, neutral, against) led by its sign, wrapping like text instead of a chip per line. */}
      {rec.reasons.length > 0 && (
        <div className="mt-2 space-y-1 text-[11px] leading-4">
          {reasonRuns(rec.reasons).map(run => (
            <p key={run.tone} className={TEXT[run.tone]}>
              <span className="mr-1 font-mono font-semibold">{RUN_SIGN[run.tone]}</span>
              {run.texts.map((text, i) => <Fragment key={i}>{i > 0 && <span aria-hidden className="text-cm-faint"> · </span>}{text}</Fragment>)}
            </p>
          ))}
        </div>
      )}

      {/* The energy meter, when the track has one, and the actions at the line's end. */}
      <div className="mt-2 flex items-center gap-2">
        {rec.energy != null && (
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-cm-faint">{axisLabel("energy")}</span>
            <Segmented value={rec.energy} max={10} ramp="energy" className="w-28" ariaLabel={axisLabel("energy")} />
          </div>
        )}
        <button
          onClick={() => onAdd(rec.track_id)}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md bg-cm-cyan/12 px-2.5 py-1 text-[11px] font-medium text-cm-cyan transition hover:bg-cm-cyan/25"
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
