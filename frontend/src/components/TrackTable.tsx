import { effectiveBpm, bpmDescription } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { ChevronDown, ChevronUp, ListFilter, Play, Plus, ThumbsUp } from "../lib/icons";
import type { SoundCloudListTrack, Track } from "../lib/types";
import { isKeyGroupEnd, type SortKey } from "../lib/trackSort";
import { Artwork } from "./ui/Artwork";
import { CatalogLoading } from "./ui/CatalogLoading";
import { EmptyState } from "./ui/EmptyState";
import { StatusBadge } from "./ui/StatusBadge";
import { usePref } from "../lib/prefs";
import { keyColor, formatKey } from "../lib/camelot";
import { valueLabel } from "../lib/labels";
import { LIBRARY_COLUMNS, MAX_COLUMN_WIDTH, clampColumnWidth, columnLabel, columnMinWidth, type LibraryColumnId } from "../lib/tablePreferences";
import { tablePreferenceStore, useTablePreferences } from "../lib/useTablePreferences";
import { rangeSelect } from "../lib/selection";

/**
 * Shared by Library `variant="full"` and SetBuilder `variant="compact"`.
 * Keep column descriptors, headers, and row cells in lockstep: tsc cannot
 * detect a grid column-count mismatch. Compact columns fit their panel;
 * the full Library variant retains user-resizable columns.
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
  addDisabled?: boolean;
  onPlay?: (track: Track) => void;
  /** "full" = Library (configurable metadata and musical metrics). "compact" = narrow candidate panels. */
  variant?: "full" | "compact";
  /** Active sort column + direction, controlled by the consuming page. */
  sortKey?: SortKey;
  sortDir?: "asc" | "desc";
  /** Called when a sortable header is clicked. Absent ⇒ static headers. */
  onSort?: (key: SortKey) => void;
  /** Bulk selection (full variant): with `onSelectionChange` a leading checkbox column appears. */
  selectedIds?: ReadonlySet<number>;
  onSelectionChange?: (ids: Set<number>) => void;
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
/** Compact headers: "SC" plus an icon; the full label stays in the title and aria-label. */
const HEAD_ICON: Record<string, typeof Play> = { "soundcloud-plays": Play, "soundcloud-likes": ThumbsUp };
function headLabel(id: string, label: string) {
  const Icon = HEAD_ICON[id];
  return Icon
    ? <span className="inline-flex items-center gap-0.5">SC<Icon aria-hidden="true" className="h-3 w-3 shrink-0" /></span>
    : <span className="truncate">{label}</span>;
}
const CELL_CLASS = "min-w-0 truncate px-3 text-center";
const COMPACT_HEAD_CLASS = "px-1 text-[10px] font-semibold uppercase tracking-wider text-cm-faint";
const COMPACT_CELL_CLASS = "min-w-0 truncate px-1";
const HEADER_HEIGHT = 36;
const GRID_BORDER_L = "border-l border-black/[0.08] dark:border-white/[0.08]";

/** Full-variant column descriptor — drives the grid template + header row in lockstep. */
interface ColMeta {
  id: LibraryColumnId | "select" | "play" | "add";
  label: string;
  size: number;
  sortKey?: SortKey;
  resizable?: boolean;
}

function MetricValue({ value, metric }: { value?: number | null; metric: "energy" | "darkness" | "valence" | "melody" | "weirdness" }) {
  if (value == null) return <span className="text-xs text-cm-faint">—</span>;
  const color = { energy: "linear-gradient(90deg, var(--color-cm-cyan), var(--color-cm-chartreuse))", darkness: "linear-gradient(90deg, var(--color-cm-blue), var(--color-cm-violet))", valence: "linear-gradient(90deg, var(--color-cm-blue), var(--color-cm-chartreuse))", melody: "var(--color-cm-chartreuse)", weirdness: "var(--color-cm-amber)" }[metric];
  return (
    <div className="flex min-w-0 items-center gap-1" title={`${value}/10`}>
      <div aria-hidden="true" className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-cm-line/10 dark:bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(10, value)) * 10}%`, background: color }} />
      </div>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-cm-muted">{value}</span>
    </div>
  );
}

const TrackTable = forwardRef<TrackTableHandle, Props>(function TrackTable(
  { tracks, loading = false, selectedId, onSelect, onAdd, addDisabled = false, onPlay, variant = "full", sortKey, sortDir, onSort, selectedIds, onSelectionChange },
  ref,
) {
  const selectionAnchor = useRef<number | null>(null);
  const [keyFormat] = usePref("keyFormat");
  const parentRef = useRef<HTMLDivElement>(null);
  const compact = variant === "compact";
  const rowHeight = compact ? 40 : 46;
  const preferences = useTablePreferences();
  const [resizePreview, setResizePreview] = useState<{ id: LibraryColumnId; width: number } | null>(null);
  const resizeCleanup = useRef<((unmount?: boolean) => void) | null>(null);
  useEffect(() => () => { resizeCleanup.current?.(true); }, []);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
    scrollPaddingStart: HEADER_HEIGHT,
    scrollMargin: HEADER_HEIGHT,
  });

  useImperativeHandle(
    ref,
    () => ({ scrollToIndex: (i: number) => virtualizer.scrollToIndex(i, { align: "auto" }) }),
    [virtualizer],
  );

  // Commit once on completion; the ref also finishes a drag during unmount/cancel.
  function startResize(e: ReactPointerEvent, id: LibraryColumnId) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeCleanup.current?.();
    const startW = tablePreferenceStore.getSnapshot().widths[id];
    const startX = e.clientX;
    const pointerId = e.pointerId;
    let width = startW;
    function move(ev: globalThis.PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      width = clampColumnWidth(id, startW + ev.clientX - startX);
      setResizePreview({ id, width });
    }
    function finish(unmount = false) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      resizeCleanup.current = null;
      tablePreferenceStore.setWidth(id, width);
      if (!unmount) setResizePreview(null);
    }
    function up(ev: globalThis.PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      width = clampColumnWidth(id, startW + ev.clientX - startX);
      finish();
    }
    function cancel(ev: Event) {
      if ("pointerId" in ev && ev.pointerId !== pointerId) return;
      finish();
    }
    resizeCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }

  const FULL_COLS: ColMeta[] = [
    ...(onSelectionChange ? [{ id: "select", label: "", size: 32 } as ColMeta] : []),
    ...(onPlay ? [{ id: "play", label: "", size: 40 } as ColMeta] : []),
    ...LIBRARY_COLUMNS.filter(column => preferences.visibility[column.id]).map(column => ({
      ...column,
      label: columnLabel(column),
      size: resizePreview?.id === column.id ? resizePreview.width : preferences.widths[column.id],
      resizable: true,
    })),
    ...(onAdd ? [{ id: "add", label: "", size: 36 } as ColMeta] : []),
  ];
  const fullWidth = FULL_COLS.reduce((total, column) => total + column.size, 0);

  // Header and rows share one scroll viewport, so their grid width and scrollbar gutter are identical.
  // Old compact resize preferences must never force candidate panels wider.
  const compactCols = [onPlay ? "28px" : null, "minmax(0,1fr)", "48px", "52px", onAdd ? "36px" : null];
  const gridTemplateColumns = compact
    ? compactCols.filter(Boolean).join(" ")
    : FULL_COLS.map((c) => `${c.size}px`).join(" ");

  const compactHeaders = [onPlay ? "" : null, "Κομμάτι", "BPM", "Key", onAdd ? "" : null]
    .filter((header) => header !== null);

  return (
    <div role="table" aria-rowcount={tracks.length} className={cn("flex h-full min-w-0 flex-col overflow-hidden", compact && "w-full max-w-full")}>
      {/* scroll viewport */}
      <div
        ref={parentRef}
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
          // Top fade starts under the 36px sticky header (h-9), which is opaque so rows never show through it.
          "scroll-fade-y [--scroll-fade-top:36px] min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]",
          compact ? "overflow-x-hidden" : "overflow-x-auto",
        )}
      >
        <div role="rowgroup" style={{ minWidth: compact ? undefined : fullWidth }} className="sticky top-0 z-20 h-9 min-w-0 border-b border-black/10 dark:border-white/10 bg-cm-bg-2">
          <div role="row" className="grid h-full items-center" style={{ gridTemplateColumns }}>
            {compact
              ? compactHeaders.map((h, i) => {
                  const isDivider = h === "BPM";
                  return (
                    <div
                      key={i}
                      role="columnheader"
                      className={cn(
                        COMPACT_HEAD_CLASS,
                        "relative h-full min-w-0 flex items-center",
                        h === "BPM" || h === "Key" ? "justify-center text-center" : "text-left",
                        isDivider && GRID_BORDER_L,
                      )}
                    >
                      {h && <button className="min-w-0 cursor-pointer truncate" onClick={() => onSort?.(h === "Κομμάτι" ? "title" : h.toLowerCase() as SortKey)}>{h}{sortKey === (h === "Κομμάτι" ? "title" : h.toLowerCase()) ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button>}
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
                        "relative h-full min-w-0 flex items-center",
                        ["track", "bpm", "key"].includes(c.id) ? "justify-start text-left" : "justify-center text-center",
                        isDivider && GRID_BORDER_L,
                      )}
                    >
                      {c.sortKey && onSort ? (
                        <button
                          type="button"
                          onClick={() => onSort(c.sortKey!)}
                          title={c.label}
                          aria-label={c.label}
                          className="flex min-w-0 cursor-pointer items-center gap-1 truncate transition-colors hover:text-cm-text"
                        >
                          {headLabel(c.id, c.label)}
                          {active &&
                            (sortDir === "asc" ? (
                              <ChevronUp className="h-3 w-3 shrink-0 text-cm-cyan" />
                            ) : (
                              <ChevronDown className="h-3 w-3 shrink-0 text-cm-cyan" />
                            ))}
                        </button>
                      ) : (
                        headLabel(c.id, c.label)
                      )}
                      {c.resizable && (
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Αλλαγή πλάτους στήλης ${c.label}`}
                          aria-valuemin={columnMinWidth(c.id as LibraryColumnId)}
                          aria-valuemax={MAX_COLUMN_WIDTH}
                          aria-valuenow={c.size}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Home") {
                              event.preventDefault();
                              tablePreferenceStore.resetWidths(c.id as LibraryColumnId);
                            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                              event.preventDefault();
                              tablePreferenceStore.setWidth(c.id as LibraryColumnId, c.size + (event.key === "ArrowLeft" ? -8 : 8));
                            }
                          }}
                          onPointerDown={(e) => startResize(e, c.id as LibraryColumnId)}
                          onDoubleClick={() => tablePreferenceStore.resetWidths(c.id as LibraryColumnId)}
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

        {loading ? (
          <CatalogLoading title={compact ? "Φόρτωση tracks…" : "Φόρτωση βιβλιοθήκης…"} />
        ) : tracks.length === 0 ? (
          <EmptyState icon={ListFilter} title="Δεν βρέθηκαν tracks" className="m-4">
            Τρέξε scan από τις Ρυθμίσεις ή χαλάρωσε το φίλτρο.
          </EmptyState>
        ) : (
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), width: "100%", minWidth: compact ? undefined : fullWidth, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const t = tracks[vi.index];
              const soundCloudTrack = t as SoundCloudListTrack;
              const selected = t.id === selectedId;
              const keyGroupEnd = isKeyGroupEnd(t, tracks[vi.index + 1], sortKey);
              const harmonicColor = keyColor(formatKey(t.key_text, t.key_analyzed));
              return (
                <div
                  role="row"
                  key={t.id}
                  data-key-group-end={keyGroupEnd || undefined}
                  onClick={() => onSelect(t.id)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start - HEADER_HEIGHT}px)`,
                    gridTemplateColumns,
                  }}
                  className={cn(
                    "grid cursor-pointer items-center border-b text-sm transition-colors",
                    keyGroupEnd
                      ? "border-cm-cyan/30 dark:border-cm-cyan/35"
                      : "border-black/[0.06] dark:border-white/[0.06]",
                    selected
                      ? "bg-cm-cyan/12 text-cm-text shadow-[inset_2px_0_0_var(--color-cm-cyan)]"
                      : vi.index % 2
                        ? "bg-black/[0.02] dark:bg-white/[0.025] hover:bg-black/[0.04] dark:hover:bg-white/5"
                        : "hover:bg-black/[0.04] dark:hover:bg-white/5",
                    t.missing && "opacity-40",
                  )}
                >
                  {(compact
                    ? [onPlay ? "play" : null, "track", "bpm", "key", onAdd ? "add" : null].filter((id): id is string => id !== null)
                    : FULL_COLS.map(column => column.id)
                  ).map(id => {
                    switch (id) {
                      case "select": return (
                        <div key={id} role="cell" className="flex h-full items-center justify-center">
                          <input
                            type="checkbox"
                            aria-label="Επιλογή κομματιού"
                            className="h-3.5 w-3.5 cursor-pointer accent-cm-cyan"
                            checked={selectedIds?.has(t.id) ?? false}
                            onChange={() => {}}
                            onClick={event => {
                              // The row click opens the inspector; the checkbox only changes the bulk selection.
                              event.stopPropagation();
                              const next = rangeSelect(tracks.map(row => row.id), selectedIds ?? new Set(), selectionAnchor.current, vi.index, event.shiftKey);
                              selectionAnchor.current = next.anchor;
                              onSelectionChange?.(next.selected);
                            }}
                          />
                        </div>
                      );
                      case "play": return (
                        <div key={id} role="cell" className="flex h-full items-center justify-center">
                          <button onClick={event => { event.stopPropagation(); onPlay?.(t); }} title="Ακρόαση" aria-label="Ακρόαση track" data-playback-toggle
                            className={cn("flex items-center justify-center rounded-full bg-cm-line/10 dark:bg-white/8 text-cm-muted transition hover:bg-cm-cyan/20 hover:text-cm-cyan", compact ? "h-5 w-5" : "h-6 w-6")}>
                            <Play className={cn("ml-0.5", compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
                          </button>
                        </div>
                      );
                      case "track": return compact ? (
                        <div key={id} role="cell" className={cn(COMPACT_CELL_CLASS, "min-w-0")}>
                          <div className="truncate text-cm-text">{t.title || t.file_name}</div>
                          <div className="truncate text-[10px] text-cm-faint">{t.artist || "—"}</div>
                        </div>
                      ) : (
                        <div key={id} role="cell" className="flex min-w-0 items-center gap-2.5 px-3">
                          <Artwork seed={t.id} trackId={t.id} delayMs={150} className="h-8 w-8" glyph={false} />
                          <div className="min-w-0">
                            <div className="truncate text-cm-text">{t.title || t.file_name}{t.missing && <span className="ml-2 text-[10px] text-cm-rose">(λείπει)</span>}</div>
                            <div className="truncate text-[11px] text-cm-faint">{t.artist || "—"}</div>
                          </div>
                        </div>
                      );
                      case "status": return <div key={id} role="cell" className={cn("flex h-full min-w-0 items-center justify-center px-3", GRID_BORDER_L)}><StatusBadge status={t.personal_status} /></div>;
                      case "energy": case "darkness": case "valence": case "melody": case "weirdness": return <div key={id} role="cell" className="min-w-0 px-3 text-center"><MetricValue value={t[id]} metric={id} /></div>;
                      case "bpm": return (
                        <div key={id} role="cell" style={{ color: bpmColor(effectiveBpm(t)) }} title={bpmDescription(t)}
                          className={cn(compact ? COMPACT_CELL_CLASS : CELL_CLASS, "flex h-full items-center font-mono tabular-nums text-cm-muted", compact ? "justify-center text-center" : "text-left", GRID_BORDER_L)}>
                          {effectiveBpm(t)?.toFixed(0) ?? "—"}
                        </div>
                      );
                      case "key": return <div key={id} role="cell" style={{ color: harmonicColor }} className={cn(compact ? COMPACT_CELL_CLASS : CELL_CLASS, compact ? "text-center" : "text-left", "font-mono text-cm-muted")}>{formatKey(t.key_text, t.key_analyzed, keyFormat)}</div>;
                      case "add": return (
                        <div key={id} role="cell" className="flex h-full items-center justify-center px-1">
                          <button type="button" onClick={event => { event.stopPropagation(); onAdd?.(t.id); }} disabled={addDisabled} aria-label="Προσθήκη στο set" title="Προσθήκη στο set"
                            style={{ color: harmonicColor ?? "var(--color-cm-cyan)" }}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-current/35 bg-current/12 transition-colors hover:border-current/60 hover:bg-current/25 disabled:cursor-default disabled:opacity-35">
                            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                      default: {
                        const value = id === "role" ? valueLabel(t.set_role) || "—"
                          : id === "genre" ? t.genre || "—"
                          : id === "substyle" ? valueLabel(t.psy_substyle) || "—"
                          : id === "soundcloud-plays" ? fmtCount(soundCloudTrack.soundcloud_playback_count)
                          : id === "soundcloud-likes" ? fmtCount(soundCloudTrack.soundcloud_likes_count)
                          : id === "last" ? t.last_played_at?.slice(5, 10) || "ποτέ"
                          : id === "added" ? t.imported_at?.slice(0, 10) || "—"
                          : fmtEpoch(t.created_time);
                        return (
                          <div key={id} role="cell" className={cn(
                            CELL_CLASS, "text-[11px] tabular-nums",
                            id === "last" || id === "added" || id === "created" ? "text-cm-faint" : "text-cm-muted",
                            id.startsWith("soundcloud-") && "font-mono",
                            id === "last" && "flex h-full items-center justify-center",
                            id === "last" && GRID_BORDER_L,
                          )}>{value}</div>
                        );
                      }
                    }
                  })}
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
