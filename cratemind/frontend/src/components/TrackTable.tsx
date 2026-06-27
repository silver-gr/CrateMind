import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ChevronDown, ChevronUp, ListFilter, Play, Plus } from "../lib/icons";
import type { Track } from "../lib/types";
import type { SortKey } from "../lib/trackSort";
import { Artwork } from "./ui/Artwork";
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
  /** Full-only: active sort column + direction (controlled by the Library page). */
  sortKey?: SortKey;
  sortDir?: "asc" | "desc";
  /** Full-only: called when a sortable header is clicked. Absent ⇒ static headers. */
  onSort?: (key: SortKey) => void;
}

function fmtDur(s?: number | null) {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Unix-seconds epoch → YYYY-MM-DD (local). Used for filesystem created/modified. */
function fmtEpoch(s?: number | null) {
  if (!s) return "—";
  const d = new Date(s * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

const HEAD_CLASS = "px-3 text-[10px] font-semibold uppercase tracking-wider text-cm-faint";
const CELL_CLASS = "min-w-0 truncate px-3";

/** Full-variant column descriptor — drives the grid template + header row in lockstep. */
interface ColMeta {
  id: string;
  label: string;
  size: string; // default grid track sizing when not user-resized
  sortKey?: SortKey;
  resizable?: boolean;
}

// Persisted per-column pixel widths (full variant only). Local-first, no backend.
const COLW_KEY = "cratemind:colw:v1";
const MIN_COL_W = 48;
const MAX_COL_W = 640;

function readColWidths(): Record<string, number> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(COLW_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function persistColWidths(w: Record<string, number>) {
  try {
    localStorage.setItem(COLW_KEY, JSON.stringify(w));
  } catch {
    /* ignore quota / private-mode */
  }
}

const TrackTable = forwardRef<TrackTableHandle, Props>(function TrackTable(
  { tracks, selectedId, onSelect, onAdd, onPlay, variant = "full", sortKey, sortDir, onSort },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const compact = variant === "compact";
  const rowHeight = compact ? 40 : 46;
  // Full variant only: user-resized per-column pixel widths (persisted, local-first).
  const [colWidths, setColWidths] = useState<Record<string, number>>(readColWidths);
  // Full variant only: drop low-priority columns (darkness / genre / added) at narrow widths.
  // The shared gridTemplateColumns is one string, so a dropped column must leave cols+headers+cells
  // in lockstep — removed entirely, never CSS-hidden (which would leave an empty grid track).
  const narrow = useMediaQuery("(max-width: 1280px)");

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

  // Drag a header divider to resize that column; double-click to reset to default.
  function startResize(e: ReactPointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).closest('[role="columnheader"]') as HTMLElement | null;
    const startW = cell ? cell.getBoundingClientRect().width : MIN_COL_W;
    const startX = e.clientX;
    function move(ev: globalThis.PointerEvent) {
      const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [id]: w }));
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setColWidths((prev) => {
        persistColWidths(prev);
        return prev;
      });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function resetWidth(id: string) {
    setColWidths((prev) => {
      const next = { ...prev };
      delete next[id];
      persistColWidths(next);
      return next;
    });
  }

  // Full-variant columns — header ↔ row cells share this order by construction.
  // Dropped (narrow) columns are removed entirely so the grid never leaves an empty track.
  const FULL_COLS: ColMeta[] = [
    ...(onPlay ? [{ id: "play", label: "", size: "2.4rem" } as ColMeta] : []),
    { id: "track", label: "Κομμάτι", size: "minmax(9rem,1.7fr)", sortKey: "title", resizable: true },
    { id: "status", label: "Κατάσταση", size: "6.5rem", sortKey: "status", resizable: true },
    { id: "energy", label: "Ενέργεια", size: "5.4rem", sortKey: "energy", resizable: true },
    ...(narrow ? [] : [{ id: "darkness", label: "Σκοτάδι", size: "5.4rem", sortKey: "darkness", resizable: true } as ColMeta]),
    { id: "bpm", label: "BPM", size: "3.2rem", sortKey: "bpm", resizable: true },
    { id: "key", label: "Key", size: "3rem", sortKey: "key", resizable: true },
    ...(narrow ? [] : [{ id: "genre", label: "Είδος", size: "minmax(4.5rem,0.7fr)", sortKey: "genre", resizable: true } as ColMeta]),
    { id: "last", label: "Τελευταίο", size: "4.6rem", sortKey: "last", resizable: true },
    ...(narrow ? [] : [{ id: "added", label: "Προστέθηκε", size: "5rem", sortKey: "added", resizable: true } as ColMeta]),
    ...(narrow ? [] : [{ id: "modified", label: "Τροποποιήθηκε", size: "5.6rem", sortKey: "modified", resizable: true } as ColMeta]),
    ...(narrow ? [] : [{ id: "created", label: "Δημιουργήθηκε", size: "5.6rem", sortKey: "created", resizable: true } as ColMeta]),
    ...(onAdd ? [{ id: "add", label: "", size: "4rem" } as ColMeta] : []),
  ];

  // Identical grid template for header + rows so columns line up (macOS overlay scrollbars = no gutter).
  const compactCols = [onPlay ? "2.4rem" : null, "minmax(0,1fr)", "3.2rem", "3rem", onAdd ? "4rem" : null];
  const gridTemplateColumns = compact
    ? compactCols.filter(Boolean).join(" ")
    : FULL_COLS.map((c) => (colWidths[c.id] ? `${colWidths[c.id]}px` : c.size)).join(" ");

  // Compact header labels (unchanged from the original frozen compact branch).
  const compactHeaders = [onPlay ? "" : null, "Track", "BPM", "Key", onAdd ? "" : null];

  return (
    <div role="table" aria-rowcount={tracks.length} className="flex h-full flex-col">
      {/* header — outside the scroll viewport */}
      <div role="rowgroup" className="shrink-0 border-b border-white/8 bg-cm-bg-2/50 backdrop-blur">
        <div role="row" className="grid h-9 items-center" style={{ gridTemplateColumns }}>
          {compact
            ? compactHeaders.map((h, i) => (
                <div key={i} role="columnheader" className={cn(HEAD_CLASS, "truncate")}>
                  {h}
                </div>
              ))
            : FULL_COLS.map((c) => {
                const active = sortKey === c.sortKey;
                return (
                  <div
                    key={c.id}
                    role="columnheader"
                    aria-sort={
                      onSort && c.sortKey
                        ? active
                          ? sortDir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                        : undefined
                    }
                    className={cn(HEAD_CLASS, "relative flex items-center")}
                  >
                    {c.sortKey && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(c.sortKey!)}
                        className="flex min-w-0 cursor-pointer items-center gap-1 truncate transition-colors hover:text-cm-text"
                      >
                        <span className="truncate">{c.label}</span>
                        {active &&
                          (sortDir === "asc" ? (
                            <ChevronUp className="h-3 w-3 shrink-0 text-cm-cyan" />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0 text-cm-cyan" />
                          ))}
                      </button>
                    ) : (
                      <span className="truncate">{c.label}</span>
                    )}
                    {c.resizable && (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Αλλαγή πλάτους στήλης ${c.label}`}
                        onPointerDown={(e) => startResize(e, c.id)}
                        onDoubleClick={() => resetWidth(c.id)}
                        title="Σύρε για αλλαγή πλάτους · διπλό κλικ για επαναφορά"
                        className="group absolute right-0 top-0 z-10 flex h-full w-3 translate-x-1/2 cursor-col-resize touch-none select-none items-center justify-center"
                      >
                        <span className="h-4 w-px bg-white/20 transition-colors group-hover:h-full group-hover:w-0.5 group-hover:bg-cm-cyan" />
                      </div>
                    )}
                  </div>
                );
              })}
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
                      <div role="cell" className="flex min-w-0 items-center gap-2.5 px-3">
                        <Artwork seed={t.id} className="h-8 w-8" glyph={false} />
                        <div className="min-w-0">
                          <div className="truncate text-cm-text">
                            {t.title || t.file_name}
                            {t.missing && (
                              <span className="ml-2 text-[10px] text-cm-rose">(λείπει)</span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-cm-faint">{t.artist || "—"}</div>
                        </div>
                      </div>
                      <div role="cell" className="min-w-0 px-3">
                        <StatusBadge status={t.personal_status} />
                      </div>
                      <div role="cell" className="px-3">
                        <EnergyMeter value={t.energy} metric="energy" />
                      </div>
                      {!narrow && (
                        <div role="cell" className="px-3">
                          <EnergyMeter value={t.darkness} metric="darkness" />
                        </div>
                      )}
                    </>
                  )}

                  <div role="cell" className={cn(CELL_CLASS, "font-mono tabular-nums text-cm-muted")}>
                    {t.bpm ? t.bpm.toFixed(0) : t.bpm_analyzed ? `~${t.bpm_analyzed.toFixed(0)}` : "—"}
                  </div>
                  <div role="cell" className={cn(CELL_CLASS, "font-mono text-cm-muted")}>
                    {t.key_text || (t.key_analyzed ? `~${t.key_analyzed}` : "—")}
                  </div>

                  {!compact && (
                    <>
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] text-cm-muted")}>
                          {t.genre || "—"}
                        </div>
                      )}
                      <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                        {t.last_played_at ? t.last_played_at.slice(5, 10) : "ποτέ"}
                      </div>
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                          {t.imported_at ? t.imported_at.slice(0, 10) : "—"}
                        </div>
                      )}
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                          {fmtEpoch(t.modified_time)}
                        </div>
                      )}
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                          {fmtEpoch(t.created_time)}
                        </div>
                      )}
                    </>
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
