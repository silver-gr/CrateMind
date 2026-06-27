import { forwardRef, useImperativeHandle, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { ListFilter, Play, Plus } from "../lib/icons";
import type { Track } from "../lib/types";
import { EmptyState } from "./ui/EmptyState";
import { EnergyMeter } from "./ui/EnergyMeter";
import { StatusBadge } from "./ui/StatusBadge";

/**
 * FROZEN INTERFACE (dual-consumed: Library `variant="full"` + SetBuilder
 * `variant="compact"`). Do NOT change Props / TrackTableHandle / the `compact`
 * branch. The Library redesign may extend ONLY the `!compact` (full) branch —
 * updating `cols` + `headers` + row cells in LOCKSTEP (tsc won't catch a grid
 * column-count mismatch). SetBuilder consumes the compact variant read-only.
 */
export interface TrackTableHandle {
  scrollToIndex: (index: number) => void;
}

interface Props {
  tracks: Track[];
  selectedId?: number;
  onSelect: (id: number) => void;
  onAdd?: (id: number) => void;
  onPlay?: (track: Track) => void;
  /** "full" = Library (status/energy/darkness/last). "compact" = narrow candidate panels. */
  variant?: "full" | "compact";
}

function fmtDur(s?: number | null) {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const HEAD_CLASS = "px-3 text-[10px] font-semibold uppercase tracking-wider text-cm-faint";
const CELL_CLASS = "min-w-0 truncate px-3";

const TrackTable = forwardRef<TrackTableHandle, Props>(function TrackTable(
  { tracks, selectedId, onSelect, onAdd, onPlay, variant = "full" },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const compact = variant === "compact";
  const rowHeight = compact ? 40 : 46;

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
  });

  useImperativeHandle(
    ref,
    () => ({ scrollToIndex: (i: number) => virtualizer.scrollToIndex(i, { align: "auto" }) }),
    [virtualizer],
  );

  // Identical grid template for header + rows so columns line up (macOS overlay scrollbars = no gutter).
  const cols = compact
    ? [onPlay ? "2.4rem" : null, "minmax(0,1fr)", "3.2rem", "3rem", onAdd ? "4rem" : null]
    : [
        onPlay ? "2.4rem" : null,
        "minmax(6rem,1.1fr)", // artist
        "minmax(7rem,1.4fr)", // title
        "6.5rem", // status
        "5.4rem", // energy
        "5.4rem", // darkness
        "3.2rem", // bpm
        "3rem", // key
        "4.6rem", // last played
        onAdd ? "4rem" : null,
      ];
  const gridTemplateColumns = cols.filter(Boolean).join(" ");

  const headers = compact
    ? [onPlay ? "" : null, "Track", "BPM", "Key", onAdd ? "" : null]
    : [
        onPlay ? "" : null,
        "Καλλιτέχνης",
        "Τίτλος",
        "Κατάσταση",
        "Ενέργεια",
        "Σκοτάδι",
        "BPM",
        "Key",
        "Τελευταίο",
        onAdd ? "" : null,
      ];

  return (
    <div role="table" aria-rowcount={tracks.length} className="flex h-full flex-col">
      {/* header — outside the scroll viewport */}
      <div role="rowgroup" className="shrink-0 border-b border-white/8 bg-cm-bg-2/50 backdrop-blur">
        <div role="row" className="grid h-9 items-center" style={{ gridTemplateColumns }}>
          {headers.map((h, i) => (
            <div key={i} role="columnheader" className={cn(HEAD_CLASS, "truncate")}>
              {h}
            </div>
          ))}
        </div>
      </div>

      {/* scroll viewport */}
      <div ref={parentRef} role="rowgroup" className="min-h-0 flex-1 overflow-auto">
        {tracks.length === 0 ? (
          <EmptyState icon={ListFilter} title="Δεν βρέθηκαν tracks" className="m-4">
            Τρέξε scan από τις Ρυθμίσεις ή χαλάρωσε το φίλτρο.
          </EmptyState>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const t = tracks[vi.index];
              const selected = t.id === selectedId;
              return (
                <div
                  role="row"
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                    gridTemplateColumns,
                  }}
                  className={cn(
                    "grid cursor-pointer items-center border-b border-white/5 text-sm transition-colors",
                    selected
                      ? "bg-cm-cyan/10 text-cm-text shadow-[inset_2px_0_0_var(--color-cm-cyan)]"
                      : vi.index % 2
                        ? "bg-white/[0.015] hover:bg-white/5"
                        : "hover:bg-white/5",
                    t.missing && "opacity-40",
                  )}
                >
                  {onPlay && (
                    <div role="cell" className="flex items-center justify-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlay(t);
                        }}
                        title="Ακρόαση"
                        aria-label="Ακρόαση track"
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-cm-muted transition hover:bg-cm-cyan/20 hover:text-cm-cyan"
                      >
                        <Play className="ml-0.5 h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {compact ? (
                    <div role="cell" className={cn(CELL_CLASS, "min-w-0")}>
                      <div className="truncate text-cm-text">{t.title || t.file_name}</div>
                      <div className="truncate text-[11px] text-cm-faint">{t.artist || "—"}</div>
                    </div>
                  ) : (
                    <>
                      <div role="cell" className={cn(CELL_CLASS, "text-cm-muted")}>
                        {t.artist || "—"}
                      </div>
                      <div role="cell" className={cn(CELL_CLASS, "text-cm-text")}>
                        {t.title || t.file_name}
                        {t.missing && <span className="ml-2 text-[10px] text-cm-rose">(λείπει)</span>}
                      </div>
                      <div role="cell" className="min-w-0 px-3">
                        <StatusBadge status={t.personal_status} />
                      </div>
                      <div role="cell" className="px-3">
                        <EnergyMeter value={t.energy} metric="energy" />
                      </div>
                      <div role="cell" className="px-3">
                        <EnergyMeter value={t.darkness} metric="darkness" />
                      </div>
                    </>
                  )}

                  <div role="cell" className={cn(CELL_CLASS, "font-mono tabular-nums text-cm-muted")}>
                    {t.bpm ? t.bpm.toFixed(0) : "—"}
                  </div>
                  <div role="cell" className={cn(CELL_CLASS, "font-mono text-cm-muted")}>
                    {t.key_text || "—"}
                  </div>

                  {!compact && (
                    <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                      {t.last_played_at ? t.last_played_at.slice(5, 10) : "ποτέ"}
                    </div>
                  )}

                  {onAdd && (
                    <div role="cell" className="flex items-center justify-center px-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onAdd(t.id);
                        }}
                        aria-label="Προσθήκη στο set"
                        className="flex items-center gap-1 rounded-md bg-cm-cyan/12 px-2 py-0.5 text-[11px] text-cm-cyan transition hover:bg-cm-cyan/25"
                      >
                        <Plus className="h-3 w-3" /> προσθ.
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

export default TrackTable;
