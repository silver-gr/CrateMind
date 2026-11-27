import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ResizeHandle } from "./ui/ResizeHandle";
import { FactsCentre, FactsLetter } from "./DeckFacts";
import { useResizable } from "../lib/useResizable";
import { WAVE_DEFAULT_HEIGHT, WAVE_MAX_HEIGHT, WAVE_MIN_HEIGHT, deckViewHeight, deckViewMode, setDeckView } from "../lib/deckView";
import { usePref } from "../lib/prefs";
import { Blend, ChevronDown, ChevronUp, Columns3 } from "../lib/icons";
import { cn } from "../lib/cn";

/** The lane's identity colour on the screen (rail, chip, tint, the djay badge). */
const deckVar = (d: "A" | "B") => ({ "--deck": d === "A" ? "var(--cm-deck-a-lit)" : "var(--cm-deck-b-lit)" }) as CSSProperties;
/** The same deck's colour on the facts row's glass, which follows the theme. */
const factsVar = (d: "A" | "B") => ({ "--deck": d === "A" ? "var(--cm-deck-a)" : "var(--cm-deck-b)" }) as CSSProperties;

const spineBtn = "flex size-5 items-center justify-center rounded-[5px] transition-colors duration-150 hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan motion-safe:active:scale-95";

/**
 * Two-deck panel under the top bar, right of the sidebar (`top`), or between the page and the dock (`bottom`), laid out like djay: both scrolling lanes stacked edge
 * to edge in one screen (dark glass in Night Void, white glass in Solar Void) with a shared centre playhead, then the facts row: each deck's
 * numbers and overview, mirrored around a centre cell with the key relation, the Sync state and the fold and view toggles. It only provides
 * the slots: each MiniPlayer portals its own lane and its own half of the facts row, so no media is owned here.
 * Reports its height through `onHeight` so the shell can fold it into --cm-player-height and the Toaster.
 * Folded (`deckViewCollapsed`), the lanes go (mode "headers", so the waveforms unmount) and the facts row stays.
 */
export default function DeckViewSlot({ dockHeight, onHeight, position }: { dockHeight: number; onHeight: (px: number) => void; position: "top" | "bottom" }) {
  // At the bottom the handle is on the top edge (drag up grows); at the top it is on the bottom edge (drag down grows).
  const wave = useResizable({ direction: "vertical", initial: WAVE_DEFAULT_HEIGHT, min: WAVE_MIN_HEIGHT, max: WAVE_MAX_HEIGHT, storageKey: "cm:deck-wave-height", reverse: position === "bottom" });
  const [collapsed, setCollapsed] = usePref("deckViewCollapsed");
  const [translucent, setTranslucent] = usePref("waveformTranslucent");
  const [strongGrid, setStrongGrid] = usePref("waveformStrongGrid");
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Each ref callback nulls its own slot on detach.
  const waveA = useCallback((el: HTMLElement | null) => setDeckView({ waveA: el }), []);
  const waveB = useCallback((el: HTMLElement | null) => setDeckView({ waveB: el }), []);
  const factsA = useCallback((el: HTMLElement | null) => setDeckView({ factsA: el }), []);
  const factsB = useCallback((el: HTMLElement | null) => setDeckView({ factsB: el }), []);
  const fit = deckViewMode(windowHeight, dockHeight, wave.size);
  const mode = collapsed && fit === "full" ? "headers" : fit;
  const height = deckViewHeight(mode, wave.size);
  useEffect(() => { onHeight(height); }, [height, onHeight]);
  useEffect(() => { setDeckView({ mode }); }, [mode]);
  // Only the mode here: when «deckViewPosition» changes, this (old) panel's cleanup runs after the new panel's ref callbacks,
  // so clearing the slots would wipe the new panel's. The new panel's mode effect runs after this cleanup.
  useEffect(() => () => { setDeckView({ mode: "hidden" }); onHeight(0); }, [onHeight]);

  if (mode === "hidden") return null;

  // Both lanes must keep identical widths so their px per beat match (viewPxPerSec uses the lane width): the rail, chip and empty grid are
  // absolutely positioned overlays and never take layout width. The empty placeholder hides once the deck portals its waveform in.
  const lane = (deck: "A" | "B") => (
    <div ref={deck === "A" ? waveA : waveB} data-deck-lane={deck} style={{ ...deckVar(deck), height: `${wave.size}px` }}
      className={cn("cm-deck-lane relative overflow-hidden [&:has(>[data-deck-scroll-waveform])>[data-deck-empty]]:hidden", deck === "B" && "shadow-[inset_0_1px_0_var(--cm-wave-seam)]")}>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[3px] bg-[var(--deck)] shadow-[0_0_10px_var(--deck)]" />
      <span aria-hidden className={cn("pointer-events-none absolute left-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-black/45 px-1 font-mono text-xs font-bold leading-none text-[var(--deck)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--deck)_50%,transparent)] light:bg-[var(--deck)] light:text-black/85 light:ring-black/15", deck === "A" ? "top-1" : "bottom-1")}>{deck}</span>
      {/* Ghost beat grid only: the dock already says the deck is empty. */}
      <span aria-hidden data-deck-empty className="cm-deck-lane-empty pointer-events-none absolute inset-0" />
    </div>
  );

  // One deck's half of the facts row: a frame in the deck's colour (the lane's 3 px rail at its outer and inner edge, a 2 px
  // line along the bottom), and the slot the deck portals its numbers and overview into. The frame is drawn over the padding.
  // It is a size container, so a narrow half drops items by its own width. An empty deck shows its letter alone.
  const facts = (deck: "A" | "B") => (
    <div ref={deck === "A" ? factsA : factsB} data-deck-facts={deck} style={factsVar(deck)}
      className="@container/facts relative flex min-w-0 flex-1 px-[11px] py-[2px] [&:has(>[data-deck-facts-half])>[data-deck-facts-empty]]:hidden">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-[var(--deck)] shadow-[0_0_10px_var(--deck)]" />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-[var(--deck)] shadow-[0_0_10px_var(--deck)]" />
      <span aria-hidden data-deck-facts-base className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[var(--deck)] shadow-[0_0_10px_var(--deck)]" />
      <span data-deck-facts-empty className={cn("flex h-[30px] flex-1 items-center", deck === "B" && "justify-end")}><FactsLetter deck={deck} /></span>
    </div>
  );

  // The centre cell sits exactly under the playhead, so the screen's centre axis lands on it. stopPropagation keeps clicks from seeking.
  const centre = (
    <div data-deck-spine onPointerDown={e => e.stopPropagation()} className="relative flex w-[132px] shrink-0 flex-col items-center py-[2px]">
      {/* The row's bottom line runs on under the centre, from deck A's colour to deck B's. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-linear-to-r from-[var(--cm-deck-a)] to-[var(--cm-deck-b)] opacity-80" />
      <FactsCentre />
      {mode !== "compact" && (
        <div className="flex h-[26px] shrink-0 items-center gap-1">
          <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className={cn(spineBtn, "text-cm-muted")}
            aria-label={collapsed ? "Εμφάνιση κυματομορφών" : "Απόκρυψη κυματομορφών"} title={collapsed ? "Εμφάνιση κυματομορφών" : "Απόκρυψη κυματομορφών"}>
            {(position === "top") !== collapsed ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
          </button>
          {mode === "full" && (
            <div data-waveform-view-toggles className="flex items-center gap-1">
              <button type="button" className={cn(spineBtn, translucent ? "bg-cm-cyan/18 text-cm-cyan" : "text-cm-muted")} aria-pressed={translucent}
                aria-label="Διαφανές πάνελ κυματομορφών" title="Διαφανές πάνελ κυματομορφών" onClick={() => setTranslucent(!translucent)}><Blend className="size-3" aria-hidden="true" /></button>
              <button type="button" className={cn(spineBtn, strongGrid ? "bg-cm-cyan/18 text-cm-cyan" : "text-cm-muted")} aria-pressed={strongGrid}
                aria-label="Έντονο beatgrid" title="Έντονο beatgrid" onClick={() => setStrongGrid(!strongGrid)}><Columns3 className="size-3" aria-hidden="true" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Same order in both positions: screen, then the facts row.
  return (
    <div data-deck-view-panel style={{ height: `${height}px` }}
      className={cn("relative z-20 flex shrink-0 flex-col", position === "top" ? "shadow-[0_10px_24px_-12px_oklch(0_0_0/0.45)]" : "shadow-[0_-10px_24px_-12px_oklch(0_0_0/0.45)]")}>
      {mode === "full" && (
        <ResizeHandle orientation="horizontal" isDragging={wave.isDragging} ariaLabel="Αλλαγή ύψους κυματομορφών"
          className={cn("absolute inset-x-0 z-30", position === "top" ? "-bottom-1.5" : "-top-1.5")} {...wave.handleProps} />
      )}
      {mode === "full" && (
        // «Διαφανές πάνελ κυματομορφών» only ever affects this screen, which exists only in full mode, where its toggle is visible.
        <div data-deck-screen className={cn("relative shrink-0", translucent ? "bg-[var(--cm-wave-bg-translucent)]" : "bg-[var(--cm-wave-bg)]")}>
          {lane("A")}
          {lane("B")}
          {/* Top edge: the same hairline as the seam between the lanes and the one above the facts row. */}
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-[var(--cm-wave-seam)]" />
          {/* Shared playhead caps (decorative); the line itself is drawn by each lane's canvas and joins through the seam. */}
          <span aria-hidden className="pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-[var(--cm-playhead)]" />
          <span aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 z-20 -translate-x-1/2 border-x-[5px] border-b-[6px] border-x-transparent border-b-[var(--cm-playhead)]" />
        </div>
      )}
      <div data-deck-facts-row className={cn("flex min-h-0 flex-1 bg-cm-bg-2/35 backdrop-blur-xl dark:bg-cm-bg-2/50", mode === "full" && "shadow-[inset_0_1px_0_var(--cm-wave-seam)]")}>
        {facts("A")}
        {centre}
        {facts("B")}
      </div>
    </div>
  );
}
