import { cn } from "../lib/cn";
import { effectiveBpm } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reorder, useDragControls, useReducedMotion, type DragControls } from "motion/react";
import { ChevronDown, ChevronUp, Link2, ListMusic, Play, Split, X } from "../lib/icons";
import type { ChipTone } from "../lib/queryChips";
import type { PairNote, SetTrackRow, Track } from "../lib/types";
import { Artwork } from "./ui/Artwork";
import { KeyBadge } from "./ui/KeyBadge";
import { EmptyState } from "./ui/EmptyState";
import { Segmented } from "./ui/Segmented";
import { SmartChip } from "./ui/SmartChip";
import { StatusBadge } from "./ui/StatusBadge";

interface Props {
  rows: SetTrackRow[];
  pairNotes: Record<string, PairNote>;
  /** Commit the full ordered id list once, on drag end. */
  onReorder: (orderedTrackIds: number[], orderedPositions?: number[]) => void;
  /** Single-step move for the chevron keyboard/a11y fallback. */
  onMove: (from: number, to: number) => void;
  onRemove: (id: number, position: number) => void;
  onPlay: (track: Track) => void;
  onBridge: (i: number) => void;
  onAddPairNote: (i: number) => void;
  disabled?: boolean;
  /** Audible track identity; a paused selection should not keep the playing treatment. */
  playingTrackId?: number | null;
  selectedTrackId?: number | null;
  onSelect?: (trackId: number) => void;
}

function TimelineItem({ row, reduce, disabled, onDragStart, onDragEnd, children }: {
  row: SetTrackRow;
  reduce: boolean | null;
  disabled: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  children: (controls: DragControls) => ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={row}
      as="div"
      tabIndex={-1}
      dragListener={false}
      dragControls={controls}
      drag={disabled ? false : "y"}
      transition={reduce ? { duration: 0 } : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="relative select-none"
    >
      {children(controls)}
    </Reorder.Item>
  );
}

function bpmDeltaTone(delta: number): ChipTone {
  const abs = Math.abs(delta);
  if (abs <= 3) return "chartreuse";
  if (abs <= 8) return "cyan";
  return "amber";
}

function fmtDur(s?: number | null) {
  if (s == null) return "—";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
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
  disabled = false,
  playingTrackId = null,
  selectedTrackId = null,
  onSelect,
}: Props) {
  const reduce = useReducedMotion();
  const [localOrder, setLocalOrder] = useState<SetTrackRow[]>(rows);
  const orderRef = useRef(rows);
  const dragStartOrder = useRef<number[] | null>(null);

  // Keep the local ordered copy synced with the committed server order.
  useEffect(() => {
    if (dragStartOrder.current) return;
    orderRef.current = rows;
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

  const commit = () => {
    const before = dragStartOrder.current;
    dragStartOrder.current = null;
    const order = orderRef.current;
    const positions = order.map((r) => r.position);
    if (before && positions.some((position, i) => position !== before[i])) {
      onReorder(order.map((r) => r.track.id), positions);
    }
  };

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={localOrder}
      onReorder={(order) => {
        if (disabled) return;
        orderRef.current = order;
        setLocalOrder(order);
      }}
      className="space-y-1.5 p-2"
    >
      {localOrder.map((row, i) => {
        const next = localOrder[i + 1];
        const playing = row.track.id === playingTrackId;
        const selected = row.track.id === selectedTrackId;
        const note = next ? pairNotes[`${row.track.id}-${next.track.id}`] : undefined;
        const curBpm = effectiveBpm(row.track);
        const nextBpm = effectiveBpm(next?.track);
        const delta =
          curBpm != null && nextBpm != null ? Math.round(nextBpm - curBpm) : null;

        return (
          <TimelineItem
            key={row.position}
            row={row}
            reduce={reduce}
            disabled={disabled}
            onDragStart={() => { dragStartOrder.current = orderRef.current.map((r) => r.position); }}
            onDragEnd={commit}
          >
            {(controls) => <>
            {/* track card */}
            <div data-set-position={row.position} data-playing={playing || undefined} data-selected={selected || undefined} className={cn("glass focus-within:ring-1 focus-within:ring-cm-cyan/50 flex items-center gap-2.5 rounded-xl border px-2.5 py-2 transition-colors hover:border-cm-cyan/25 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] data-[playing=true]:border-cm-cyan/25 data-[playing=true]:bg-black/[0.02] dark:data-[playing=true]:bg-white/[0.03] data-[selected=true]:border-cm-cyan/50", !playing && "border-black/10 dark:border-white/5")}>
              {/* drag handle + position */}
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Αλλαγή θέσης: ${row.track.title || row.track.file_name}`}
                  title="Σύρε για αλλαγή θέσης ή χρησιμοποίησε τα βέλη"
                  style={{ touchAction: "none" }}
                  onPointerDown={(event) => {
                    if (!disabled && event.isPrimary && event.button === 0) controls.start(event);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    onMove(i, i + (event.key === "ArrowUp" ? -1 : 1));
                  }}
                  className="grid h-8 w-6 cursor-grab content-center justify-center grid-cols-[repeat(2,3px)] gap-[2px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan active:cursor-grabbing disabled:cursor-wait disabled:opacity-40"
                >
                  {Array.from({ length: 6 }).map((_, k) => (
                    <span aria-hidden key={k} className="h-[3px] w-[3px] rounded-full bg-cm-faint/50" />
                  ))}
                </button>
                <span className="grid h-5 w-5 place-items-center rounded-md bg-cm-cyan/10 font-mono text-[11px] tabular-nums text-cm-cyan/80">
                  {i + 1}
                </span>
              </div>

              {/* decorative gradient tile — CrateMind stores no artwork */}
              <Artwork seed={row.track.id} className="h-9 w-9" />

              <button
                onClick={() => onPlay(row.track)}
                title="Ακρόαση"
                aria-label="Ακρόαση track"
                        data-playback-toggle
                className={cn("flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition hover:bg-cm-cyan/20 hover:text-cm-cyan hover:shadow-[0_0_12px_var(--color-cm-cyan)]", playing ? "bg-cm-cyan/20 text-cm-cyan shadow-[0_0_12px_var(--color-cm-cyan)]" : "bg-white/8 text-cm-muted")}
              >
                <Play className="ml-0.5 h-3 w-3" />
              </button>

              <div className="min-w-0 flex-1">
                {onSelect ? (
                  <button type="button" onClick={() => onSelect(row.track.id)} aria-pressed={selected}
                    aria-label={`Επιλογή track: ${row.track.title || row.track.file_name}`}
                    className="block w-full min-w-0 cursor-pointer rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan">
                    <span className="block truncate text-sm text-cm-text">{row.track.title || row.track.file_name}</span>
                    <span className="block truncate text-[11px] text-cm-faint">{row.track.artist || "—"}</span>
                  </button>
                ) : <>
                  <div className="truncate text-sm text-cm-text">{row.track.title || row.track.file_name}</div>
                  <div className="truncate text-[11px] text-cm-faint">{row.track.artist || "—"}</div>
                </>}
              </div>

              <div className="shrink-0">
                <StatusBadge status={row.profile?.personal_status} />
              </div>

              {/* Fixed metadata columns stay aligned across every track. */}
              <div className="hidden w-20 shrink-0 text-center md:block" data-set-column="energy">
                <Segmented value={row.profile?.energy} max={10} ramp="energy" className="w-full" ariaLabel="ενέργεια" />
              </div>
              <div className="hidden w-14 shrink-0 flex-col items-start font-mono text-[11px] leading-tight text-cm-muted sm:flex" data-set-column="tempo-duration">
                <span style={{color: bpmColor(curBpm)}} className="tabular-nums">{curBpm?.toFixed(0) ?? "—"}</span>
                <span className="text-cm-faint tabular-nums">{fmtDur(row.track.duration)}</span>
              </div>
              <div className="hidden w-12 shrink-0 justify-start sm:flex" data-set-column="key">
                <KeyBadge keyText={row.track.key_text} analyzed={row.track.key_analyzed} className="max-w-full" />
              </div>

              <div className="flex w-4 shrink-0 flex-col">
                <button
                  onClick={() => onMove(i, i - 1)}
                  disabled={disabled || i === 0}
                  aria-label="Μετακίνηση πάνω"
                  className="cursor-pointer text-cm-faint transition hover:text-cm-text disabled:cursor-default disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onMove(i, i + 1)}
                  disabled={disabled || i === localOrder.length - 1}
                  aria-label="Μετακίνηση κάτω"
                  className="cursor-pointer text-cm-faint transition hover:text-cm-text disabled:cursor-default disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <button
                onClick={() => onRemove(row.track.id, row.position)}
                disabled={disabled}
                aria-label="Αφαίρεση από set"
                className="flex w-4 shrink-0 cursor-pointer justify-center text-cm-faint transition hover:text-cm-rose"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* transition connector to the next track */}
            {next && (
              <div onPointerDown={e => e.stopPropagation()} className="flex flex-wrap items-center gap-1.5 py-1 pl-7">
                <span className="h-5 w-px shrink-0 bg-gradient-to-b from-cm-violet/50 via-cm-cyan/30 to-transparent" />
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
                    title="Επεξεργασία σημείωσης μετάβασης"
                    className="max-w-full whitespace-normal break-words text-left px-2 py-0.5"
                  >
                    {note.transition_type || "σημείωση"}
                    {note.rating ? ` · ${note.rating}/5` : ""}
                    {note.notes ? ` · ${note.notes}` : ""}
                  </SmartChip>
                ) : (
                  <SmartChip tone="muted" icon={Link2} onClick={() => onAddPairNote(i)} title="Προσθήκη σημείωσης μετάβασης" className="px-2 py-0.5">
                    σημείωση
                  </SmartChip>
                )}
              </div>
            )}
            </>}
          </TimelineItem>
        );
      })}
    </Reorder.Group>
  );
}
