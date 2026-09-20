import { bpmColor } from "../lib/bpmColor";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ChevronDown, ChevronUp, ListFilter, Play, Plus } from "../lib/icons";
import type { SoundCloudListTrack, Track } from "../lib/types";
import type { SortKey } from "../lib/trackSort";
import { Artwork } from "./ui/Artwork";
import { CatalogLoading } from "./ui/CatalogLoading";
import { EmptyState } from "./ui/EmptyState";
import { EnergyMeter } from "./ui/EnergyMeter";
import { StatusBadge } from "./ui/StatusBadge";
import { usePref } from "../lib/prefs";
import { keyColor, formatKey } from "../lib/camelot";
import { valueLabel } from "../lib/labels";

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
  loading?: boolean;
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

function fmtCount(value?: number | null) {
  if (value == null) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const v = +(value / 1000).toFixed(1);
    return `${v}k`;
  }
  const v = +(value / 1_000_000).toFixed(1);
  return `${v}m`;
}

const HEAD_CLASS = "px-3 text-[10px] font-semibold uppercase tracking-wider text-cm-faint";
const CELL_CLASS = "min-w-0 truncate px-3";
const COMPACT_HEAD_CLASS = "px-1 text-[10px] font-semibold uppercase tracking-wider text-cm-faint";
const COMPACT_CELL_CLASS = "min-w-0 truncate px-1";
const GRID_BORDER_L = "border-l border-black/[0.08] dark:border-white/[0.08]";

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
  { tracks, loading = false, selectedId, onSelect, onAdd, onPlay, variant = "full", sortKey, sortDir, onSort },
  ref,
) {
  const [keyFormat] = usePref("keyFormat");
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
    ...(narrow ? [] : [{ id: "darkness", label: "Σκοτεινότητα", size: "5.4rem", sortKey: "darkness", resizable: true } as ColMeta]),
    ...(narrow ? [] : [{ id: "role", label: "Ρόλος", size: "5.4rem", sortKey: "role", resizable: true } as ColMeta]),
    { id: "bpm", label: "BPM", size: "3.2rem", sortKey: "bpm", resizable: true },
    { id: "key", label: "Key", size: "3.6rem", sortKey: "key", resizable: true },
    ...(narrow ? [] : [{ id: "genre", label: "Είδος", size: "minmax(4.5rem,0.7fr)", sortKey: "genre", resizable: true } as ColMeta]),
    ...(narrow ? [] : [{ id: "substyle", label: "Substyle", size: "minmax(4.5rem,0.7fr)", sortKey: "substyle", resizable: true } as ColMeta]),
    { id: "soundcloud-plays", label: "SC Plays", size: "4.7rem", sortKey: "soundcloud_plays", resizable: true },
    { id: "soundcloud-likes", label: "SC Likes", size: "4.7rem", sortKey: "soundcloud_likes", resizable: true },
    { id: "last", label: "Τελευταίο", size: "4.6rem", sortKey: "last", resizable: true },
    ...(narrow ? [] : [{ id: "added", label: "Προστέθηκε", size: "5rem", sortKey: "added", resizable: true } as ColMeta]),
    ...(narrow ? [] : [{ id: "created", label: "Δημιουργήθηκε", size: "5.6rem", sortKey: "created", resizable: true } as ColMeta]),
    ...(onAdd ? [{ id: "add", label: "", size: "4rem" } as ColMeta] : []),
  ];

  // Identical grid template for header + rows so columns line up (macOS overlay scrollbars = no gutter).
  const compactCols = [onPlay ? "1.9rem" : null, colWidths["compact-track"] ? `${colWidths["compact-track"]}px` : "minmax(130px,1fr)", `${colWidths["compact-bpm"] ?? 58}px`, `${colWidths["compact-key"] ?? 58}px`, onAdd ? "72px" : null];
  const compactMinWidth = 31 + (colWidths["compact-track"] ?? 130) + (colWidths["compact-bpm"] ?? 58) + (colWidths["compact-key"] ?? 58) + (onAdd ? 72 : 0);
  const gridTemplateColumns = compact
    ? compactCols.filter(Boolean).join(" ")
    : FULL_COLS.map((c) => (colWidths[c.id] ? `${colWidths[c.id]}px` : c.size)).join(" ");

  // Compact header labels (unchanged from the original frozen compact branch).
  const compactHeaders = [onPlay ? "" : null, "Track", "BPM", "Key", onAdd ? "" : null];

  return (
    <div role="table" aria-rowcount={tracks.length} className="flex h-full flex-col overflow-x-auto">
      {/* header — outside the scroll viewport */}
      <div role="rowgroup" style={{ minWidth: compact ? compactMinWidth : undefined }} className="shrink-0 border-b border-black/10 dark:border-white/10 bg-cm-bg-2/80 backdrop-blur">
        <div role="row" className="grid h-9 items-center" style={{ gridTemplateColumns }}>
          {compact
            ? compactHeaders.map((h, i) => {
                const isDivider = h === "BPM";
                return (
                  <div
                    key={i}
                    role="columnheader"
                    className={cn(
                      COMPACT_HEAD_CLASS,
                      "relative h-full flex items-center",
                      isDivider && GRID_BORDER_L,
                    )}
                  >
                    {h && <button className="cursor-pointer" onClick={() => onSort?.(h === "Track" ? "title" : h.toLowerCase() as SortKey)}>{h}{sortKey === (h === "Track" ? "title" : h.toLowerCase()) ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button>}
                    {h && <div role="separator" aria-label={`Αλλαγή πλάτους ${h}`} onPointerDown={e => startResize(e, `compact-${h.toLowerCase()}`)} onDoubleClick={() => resetWidth(`compact-${h.toLowerCase()}`)} className="absolute right-0 top-0 h-full w-2 cursor-col-resize border-r border-cm-line/20" />}
                  </div>
                );
              })
            : FULL_COLS.map((c) => {
                const active = sortKey === c.sortKey;
                const isDivider = c.id === "status" || c.id === "bpm" || c.id === "last";
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
                    className={cn(
                      HEAD_CLASS,
                      "relative h-full flex items-center",
                      isDivider && GRID_BORDER_L,
                    )}
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
                        <span className="h-4 w-px bg-black/15 dark:bg-white/20 transition-colors group-hover:h-full group-hover:w-0.5 group-hover:bg-cm-cyan" />
                      </div>
                    )}
                  </div>
                );
              })}
        </div>
      </div>

      {/* scroll viewport */}
      <div
        style={{ minWidth: compact ? compactMinWidth : undefined }}
        ref={parentRef}
        role="rowgroup"
        data-at-top="true"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atTop = el.scrollTop <= 2;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          const topVal = atTop ? "true" : "false";
          const btmVal = atBottom ? "true" : "false";
          if (el.dataset.atTop !== topVal) el.dataset.atTop = topVal;
          if (el.dataset.atBottom !== btmVal) el.dataset.atBottom = btmVal;
        }}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scroll-fade-y",
          compact ? "overflow-x-visible" : "overflow-x-auto",
        )}
      >
        {loading ? (
          <CatalogLoading title={compact ? "Φόρτωση tracks…" : "Φόρτωση βιβλιοθήκης…"} />
        ) : tracks.length === 0 ? (
          <EmptyState icon={ListFilter} title="Δεν βρέθηκαν tracks" className="m-4">
            Τρέξε scan από τις Ρυθμίσεις ή χαλάρωσε το φίλτρο.
          </EmptyState>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const t = tracks[vi.index];
              const soundCloudTrack = t as SoundCloudListTrack;
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
                    "grid cursor-pointer items-center border-b border-black/[0.06] dark:border-white/[0.06] text-sm transition-colors",
                    selected
                      ? "bg-cm-cyan/12 text-cm-text shadow-[inset_2px_0_0_var(--color-cm-cyan)]"
                      : vi.index % 2
                        ? "bg-black/[0.02] dark:bg-white/[0.025] hover:bg-black/[0.04] dark:hover:bg-white/5"
                        : "hover:bg-black/[0.04] dark:hover:bg-white/5",
                    t.missing && "opacity-40",
                  )}
                >
                  {onPlay && (
                    <div role="cell" className="flex h-full items-center justify-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlay(t);
                        }}
                        title="Ακρόαση"
                        aria-label="Ακρόαση track"
                        className={cn(
                          "flex items-center justify-center rounded-full bg-cm-line/10 dark:bg-white/8 text-cm-muted transition hover:bg-cm-cyan/20 hover:text-cm-cyan",
                          compact ? "h-5 w-5" : "h-6 w-6",
                        )}
                      >
                        <Play className={cn("ml-0.5", compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
                      </button>
                    </div>
                  )}

                  {compact ? (
                    <div role="cell" className={cn(COMPACT_CELL_CLASS, "min-w-0")}>
                      <div className="truncate text-cm-text">{t.title || t.file_name}</div>
                      <div className="truncate text-[10px] text-cm-faint">{t.artist || "—"}</div>
                    </div>
                  ) : (
                    <>
                      <div role="cell" className="flex min-w-0 items-center gap-2.5 px-3">
                        <Artwork seed={t.id} trackId={t.id} delayMs={150} className="h-8 w-8" glyph={false} />
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
                      <div role="cell" className={cn("min-w-0 px-3 h-full flex items-center", GRID_BORDER_L)}>
                        <StatusBadge status={t.personal_status} />
                      </div>
                      <div role="cell" className="min-w-0 px-3">
                        <EnergyMeter value={t.energy} metric="energy" />
                      </div>
                      {!narrow && (
                        <div role="cell" className="min-w-0 px-3">
                          <EnergyMeter value={t.darkness} metric="darkness" />
                        </div>
                      )}
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] text-cm-muted")}>
                          {valueLabel(t.set_role) || "—"}
                        </div>
                      )}
                    </>
                  )}

                  <div
                    role="cell"
                    style={{color: bpmColor(t.bpm ?? t.bpm_analyzed)}}
                    className={cn(
                      compact ? COMPACT_CELL_CLASS : CELL_CLASS,
                      "h-full flex items-center font-mono tabular-nums text-cm-muted",
                      GRID_BORDER_L,
                    )}
                  >
                    {(t.bpm ?? t.bpm_analyzed)?.toFixed(0) || "—"}
                  </div>
                  <div role="cell" style={{ color: keyColor(t.key_text, t.key_analyzed) }} className={cn(compact ? COMPACT_CELL_CLASS : CELL_CLASS, "font-mono text-cm-muted")}>
                    {formatKey(t.key_text, t.key_analyzed, keyFormat)}
                  </div>

                  {!compact && (
                    <>
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] text-cm-muted")}>
                          {t.genre || "—"}
                        </div>
                      )}
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] text-cm-muted")}>
                          {valueLabel(t.psy_substyle) || "—"}
                        </div>
                      )}
                      <div role="cell" className={cn(CELL_CLASS, "font-mono text-[11px] tabular-nums text-cm-muted")}>
                        {fmtCount(soundCloudTrack.soundcloud_playback_count)}
                      </div>
                      <div role="cell" className={cn(CELL_CLASS, "font-mono text-[11px] tabular-nums text-cm-muted")}>
                        {fmtCount(soundCloudTrack.soundcloud_likes_count)}
                      </div>
                      <div
                        role="cell"
                        className={cn(
                          CELL_CLASS,
                          "h-full flex items-center text-[11px] tabular-nums text-cm-faint",
                          GRID_BORDER_L,
                        )}
                      >
                        {t.last_played_at ? t.last_played_at.slice(5, 10) : "ποτέ"}
                      </div>
                      {!narrow && (
                        <div role="cell" className={cn(CELL_CLASS, "text-[11px] tabular-nums text-cm-faint")}>
                          {t.imported_at ? t.imported_at.slice(0, 10) : "—"}
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
                    <div role="cell" className="flex h-full items-center justify-center px-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onAdd(t.id);
                        }}
                        aria-label="Προσθήκη στο set"
                        className={cn(
                          "flex items-center rounded-md bg-cm-cyan/12 text-cm-cyan transition hover:bg-cm-cyan/25",
                          compact
                            ? "gap-0.5 px-1.5 py-0.5 text-[10px] font-medium"
                            : "gap-1 px-2 py-0.5 text-[11px]",
                        )}
                      >
                        <Plus className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} /> προσθ.
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
