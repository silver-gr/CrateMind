import { bpmColor } from "../lib/bpmColor";
import { keyColor, camelotCode, toCamelot } from "../lib/camelot";
import { Play, Plus } from "../lib/icons";
import { axisLabel, translateRecommendationReason } from "../lib/labels";
import { cn } from "../lib/cn";
import type { ChipTone } from "../lib/queryChips";
import { CHIP } from "../lib/tones";
import type { DeckId } from "../lib/player";
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

const KIND_ORDER: ChipTone[] = ["chartreuse", "muted", "amber"];
const KIND_SIGN: Partial<Record<ChipTone, string>> = { chartreuse: "+", amber: "−" };

/** One chip per reason: reasons for first, then neutral, then against (the server order is kept inside a kind). The chip's
 *  colour and one leading sign say which kind it is, so the text drops its own sign; what follows a colon is the value. */
function reasonChips(reasons: string[]): { tone: ChipTone; label: string; value: string | null }[] {
  return KIND_ORDER.flatMap(tone => reasons.filter(reason => reasonTone(reason) === tone).map(reason => {
    const text = translateRecommendationReason(reason).replace(/^[+-]\s*/, "");
    const cut = text.indexOf(": ");
    return cut < 0 ? { tone, label: text, value: null } : { tone, label: text.slice(0, cut), value: text.slice(cut + 2) };
  }));
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
  /** Load the track on a deck (paused); the «A» and «B» buttons show only when it is given. */
  onDeck?: (deck: DeckId, rec: Recommendation) => void;
}

const DECK_BUTTON: Record<DeckId, string> = {
  A: "bg-cm-deck-a/12 text-cm-deck-a hover:bg-cm-deck-a/25",
  B: "bg-cm-deck-b/12 text-cm-deck-b hover:bg-cm-deck-b/25",
};

export default function RecommendationCard({ rec, onAdd, onPlay, onDeck }: Props) {
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

      {/* The reasons as small chips, for before against. A chip wraps inside the card rather than stretch it. */}
      {rec.reasons.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {reasonChips(rec.reasons).map((chip, i) => (
            <li key={i} className={cn("inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] leading-4", CHIP[chip.tone])}>
              {KIND_SIGN[chip.tone] && <span aria-hidden className="font-mono font-bold opacity-70">{KIND_SIGN[chip.tone]}</span>}
              <span className="min-w-0 break-words">
                <span className={chip.value != null ? "opacity-80" : undefined}>{chip.label}</span>
                {chip.value != null && <> <span className="font-semibold tabular-nums">{chip.value}</span></>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The energy meter, when the track has one, and the actions at the line's end (on their own line in a narrow card). */}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
        {rec.energy != null && (
          <div className="mr-auto flex items-center gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-cm-faint">{axisLabel("energy")}</span>
            <Segmented value={rec.energy} max={10} ramp="energy" className="w-28" ariaLabel={axisLabel("energy")} />
          </div>
        )}
        <div data-rec-actions className="flex items-center gap-1">
          <button
            onClick={() => onAdd(rec.track_id)}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-cm-cyan/12 px-2.5 text-[11px] font-medium text-cm-cyan transition hover:bg-cm-cyan/25"
          >
            <Plus className="h-3 w-3" /> στο set
          </button>
          {onDeck && (["A", "B"] as const).map(deck => (
            <button key={deck} type="button" onClick={() => onDeck(deck, rec)} title={`Φόρτωση στο Deck ${deck}`} aria-label={`Φόρτωση στο Deck ${deck}`}
              className={cn("inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md font-mono text-[11px] font-bold transition motion-safe:active:scale-95", DECK_BUTTON[deck])}>
              {deck}
            </button>
          ))}
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
      </div>
    </GlassCard>
  );
}
