import { useEffect, useState } from "react";
import { Reorder, useReducedMotion } from "motion/react";
import { cn } from "../lib/cn";
import { ChevronDown, ChevronUp, Link2, ListMusic, Play, Split, X } from "../lib/icons";
import type { ChipTone } from "../lib/queryChips";
import type { PairNote, SetTrackRow, Track } from "../lib/types";
import { EmptyState } from "./ui/EmptyState";
import { EnergyMeter } from "./ui/EnergyMeter";
import { SmartChip } from "./ui/SmartChip";
import { StatusBadge } from "./ui/StatusBadge";

interface Props {
  rows: SetTrackRow[];
  pairNotes: Record<string, PairNote>;
  /** Commit the full ordered id list once, on drag end. */
  onReorder: (orderedTrackIds: number[]) => void;
  /** Single-step move for the chevron keyboard/a11y fallback. */
  onMove: (from: number, to: number) => void;
  onRemove: (id: number) => void;
  onPlay: (track: Track) => void;
  onBridge: (i: number) => void;
  onAddPairNote: (i: number) => void;
}

function bpmDeltaTone(delta: number): ChipTone {
  const abs = Math.abs(delta);
  if (abs <= 3) return "chartreuse";
  if (abs <= 8) return "cyan";
  return "amber";
}

export default function SetTimeline({
  rows,
  pairNotes,
  onReorder,
  onMove,
  onRemove,
  onPlay,
  onBridge,
  onAddPairNote,
}: Props) {
  const reduce = useReducedMotion();
  const [localOrder, setLocalOrder] = useState<SetTrackRow[]>(rows);

  // Keep the local ordered copy synced with the committed server order.
  useEffect(() => {
    setLocalOrder(rows);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="p-3">
        <EmptyState icon={ListMusic} title="Άδειο set">
          Πρόσθεσε υποψήφια tracks από αριστερά.
        </EmptyState>
      </div>
    );
  }

  const commit = () => onReorder(localOrder.map((r) => r.track.id));

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={localOrder}
      onReorder={setLocalOrder}
      className="space-y-1.5 p-2"
    >
      {localOrder.map((row, i) => {
        const next = localOrder[i + 1];
        const note = next ? pairNotes[`${row.track.id}-${next.track.id}`] : undefined;
        const curBpm = row.track.bpm;
        const nextBpm = next?.track.bpm;
        const delta =
          curBpm != null && nextBpm != null ? Math.round(nextBpm - curBpm) : null;

        return (
          <Reorder.Item
            key={row.track.id}
            value={row}
            as="div"
            transition={reduce ? { duration: 0 } : undefined}
            onDragEnd={commit}
            className="select-none"
          >
            {/* track card */}
            <div className="glass flex cursor-grab items-center gap-2 rounded-xl px-2.5 py-2 active:cursor-grabbing">
              <span className="w-5 shrink-0 text-center font-mono text-xs text-cm-faint">
                {i + 1}
              </span>

              <button
                onClick={() => onPlay(row.track)}
                title="Ακρόαση"
                aria-label="Ακρόαση track"
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/8 text-cm-muted transition hover:bg-cm-cyan/20 hover:text-cm-cyan"
              >
                <Play className="ml-0.5 h-3 w-3" />
              </button>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-cm-text">
                  {row.track.title || row.track.file_name}
                </div>
                <div className="truncate text-[11px] text-cm-faint">{row.track.artist || "—"}</div>
              </div>

              <div className="hidden shrink-0 flex-col items-end font-mono text-[11px] leading-tight text-cm-muted sm:flex">
                <span className="tabular-nums">{row.track.bpm ? row.track.bpm.toFixed(0) : "—"}</span>
                <span className="text-cm-faint">{row.track.key_text || "—"}</span>
              </div>

              <div className="hidden shrink-0 md:block">
                <EnergyMeter value={row.profile?.energy} metric="energy" />
              </div>

              <div className="shrink-0">
                <StatusBadge status={row.profile?.personal_status} />
              </div>

              <div className="flex shrink-0 flex-col">
                <button
                  onClick={() => onMove(i, i - 1)}
                  disabled={i === 0}
                  aria-label="Μετακίνηση πάνω"
                  className="cursor-pointer text-cm-faint transition hover:text-cm-text disabled:cursor-default disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onMove(i, i + 1)}
                  disabled={i === localOrder.length - 1}
                  aria-label="Μετακίνηση κάτω"
                  className="cursor-pointer text-cm-faint transition hover:text-cm-text disabled:cursor-default disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <button
                onClick={() => onRemove(row.track.id)}
                aria-label="Αφαίρεση από set"
                className="shrink-0 cursor-pointer text-cm-faint transition hover:text-cm-rose"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* transition connector to the next track */}
            {next && (
              <div className="flex items-center gap-1.5 py-1 pl-7">
                <span className="h-4 w-px shrink-0 bg-gradient-to-b from-cm-violet/40 to-transparent" />
                {delta != null && (
                  <SmartChip tone={bpmDeltaTone(delta)} className="px-2 py-0.5">
                    {delta >= 0 ? "+" : ""}
                    {delta} BPM
                  </SmartChip>
                )}
                {row.track.key_text && next.track.key_text && (
                  <SmartChip tone="violet" className="px-2 py-0.5">
                    {row.track.key_text} → {next.track.key_text}
                  </SmartChip>
                )}
                <SmartChip tone="muted" icon={Split} onClick={() => onBridge(i)} title="Βρες track-γέφυρα" className="px-2 py-0.5">
                  γέφυρα
                </SmartChip>
                {note ? (
                  <SmartChip
                    tone="magenta"
                    icon={Link2}
                    onClick={() => onAddPairNote(i)}
                    title={note.notes ?? "Επεξεργασία σημείωσης μετάβασης"}
                    className="px-2 py-0.5"
                  >
                    {note.transition_type || "σημείωση"}
                    {note.rating ? ` · ${note.rating}/5` : ""}
                  </SmartChip>
                ) : (
                  <SmartChip tone="muted" icon={Link2} onClick={() => onAddPairNote(i)} title="Προσθήκη σημείωσης μετάβασης" className="px-2 py-0.5">
                    σημείωση
                  </SmartChip>
                )}
              </div>
            )}
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}
