import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "./ui/ResizeHandle";
import { useResizable } from "../lib/useResizable";
import { DECK_INFO_HEIGHT, WAVE_DEFAULT_HEIGHT, WAVE_MAX_HEIGHT, WAVE_MIN_HEIGHT, deckViewHeight, deckViewMode, setDeckView } from "../lib/deckView";
import { usePref } from "../lib/prefs";
import { Blend, ChevronDown, ChevronUp, Columns3, Headphones } from "../lib/icons";
import { cn } from "../lib/cn";

/** Height of the folded panel strip; matches the folded dock. */
const COLLAPSED_HEIGHT = 22;

/** The lane's identity colour on the dark screen (rail, chip, tint, the djay badge). */
const deckVar = (d: "A" | "B") => ({ "--deck": d === "A" ? "var(--cm-deck-a-lit)" : "var(--cm-deck-b-lit)" }) as CSSProperties;

const spineBtn = "flex size-5 items-center justify-center rounded-[5px] transition-colors duration-150 hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan motion-safe:active:scale-95";

/**
 * Two-deck panel under the title bar (`top`) or between the page and the dock (`bottom`), laid out like djay: both scrolling lanes stacked edge
 * to edge in one always-dark screen with a shared centre playhead, then one info row with deck A's and deck B's strips around a centre spine
 * (fold and view toggles). It only provides the slots: each MiniPlayer portals its own lane and info strip, so no media is owned here.
 * Reports its height through `onHeight` so the shell can fold it into --cm-player-height and the Toaster.
 * Folded (`deckViewCollapsed`), it is a thin strip and reports mode "hidden", so the waveforms unmount until it opens again.
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
  const infoA = useCallback((el: HTMLElement | null) => setDeckView({ infoA: el }), []);
  const infoB = useCallback((el: HTMLElement | null) => setDeckView({ infoB: el }), []);
  const mode = collapsed ? "hidden" : deckViewMode(windowHeight, dockHeight, wave.size);
  const height = collapsed ? COLLAPSED_HEIGHT : deckViewHeight(mode, wave.size);
  useEffect(() => { onHeight(height); }, [height, onHeight]);
  useEffect(() => { setDeckView({ mode }); }, [mode]);
  // Only the mode here: when «deckViewPosition» changes, this (old) panel's cleanup runs after the new panel's ref callbacks,
  // so clearing the slots would wipe the new panel's. The new panel's mode effect runs after this cleanup.
  useEffect(() => () => { setDeckView({ mode: "hidden" }); onHeight(0); }, [onHeight]);

  // Folding unmounts the focused button and mounts the other: keep keyboard focus on the fold control.
  const foldRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => { if (refocus.current) { refocus.current = false; foldRef.current?.focus(); } }, [collapsed]);
  const fold = (next: boolean) => { refocus.current = true; setCollapsed(next); };

  if (mode === "hidden" && !collapsed) return null;

  if (collapsed) {
    // The whole strip is the button; the chevron sits at the centre, where the spine's fold button is when the panel is open.
    return (
      <button ref={foldRef} type="button" data-deck-view-collapsed onClick={() => fold(false)} aria-expanded={false}
        aria-label="Εμφάνιση κυματομορφών" title="Εμφάνιση κυματομορφών" style={{ height: COLLAPSED_HEIGHT }}
        className={cn("group relative z-20 flex w-full shrink-0 items-center justify-center gap-2 border-cm-contrast/10 bg-cm-bg-2/60 text-cm-muted transition-colors duration-150 hover:bg-cm-cyan/8 hover:text-cm-cyan focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cm-cyan",
          position === "top" ? "border-b" : "border-t")}>
        <span aria-hidden className="h-1 w-8 rounded-full bg-cm-contrast/15 transition-colors duration-150 group-hover:bg-cm-cyan/50" />
        {position === "top" ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronUp className="size-3.5" aria-hidden="true" />}
        <span aria-hidden className="h-1 w-8 rounded-full bg-cm-contrast/15 transition-colors duration-150 group-hover:bg-cm-cyan/50" />
      </button>
    );
  }

  // Both lanes must keep identical widths so their px per beat match (viewPxPerSec uses the lane width): the rail, chip and empty grid are
  // absolutely positioned overlays and never take layout width. The empty placeholder hides once the deck portals its waveform in.
  const lane = (deck: "A" | "B") => (
    <div ref={deck === "A" ? waveA : waveB} data-deck-lane={deck} style={{ ...deckVar(deck), height: `${wave.size}px` }}
      className={cn("cm-deck-lane relative overflow-hidden [&:has(>[data-deck-scroll-waveform])>[data-deck-empty]]:hidden", deck === "B" && "shadow-[inset_0_1px_0_var(--cm-wave-seam)]")}>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[3px] bg-[var(--deck)] shadow-[0_0_10px_var(--deck)]" />
      <span aria-hidden className={cn("pointer-events-none absolute left-2 z-10 flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-black/45 px-1 font-mono text-[10px] font-bold leading-none text-[var(--deck)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--deck)_50%,transparent)]", deck === "A" ? "top-1" : "bottom-1")}>{deck}</span>
      {/* Ghost beat grid only: the info row below already says the deck is empty. */}
      <span aria-hidden data-deck-empty className="cm-deck-lane-empty pointer-events-none absolute inset-0" />
    </div>
  );

  const info = (deck: "A" | "B") => (
    <div ref={deck === "A" ? infoA : infoB} data-deck-info-slot={deck} className="relative min-w-0 [&:has(>[data-deck-info])>[data-deck-empty]]:hidden">
      <div data-deck-empty className={cn("flex h-full items-center gap-3 px-3", deck === "B" && "flex-row-reverse text-right")}>
        <span aria-hidden className="flex size-[52px] shrink-0 items-center justify-center rounded-[10px] border border-dashed border-cm-contrast/15 text-cm-faint"><Headphones className="size-4" /></span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-cm-muted">Deck {deck} άδειο</span>
          <span className="block truncate text-[11px] text-cm-faint">Φόρτωσε track (Load {deck === "A" ? 1 : 2})</span>
        </span>
      </div>
    </div>
  );

  // The spine sits exactly under the playhead, so the screen's centre axis lands on the controls. stopPropagation keeps clicks from seeking.
  const spine = (
    <div data-deck-spine className="flex flex-col items-center justify-center gap-1 border-x border-cm-contrast/8" onPointerDown={e => e.stopPropagation()}>
      <button ref={foldRef} type="button" onClick={() => fold(true)} aria-expanded aria-label="Απόκρυψη κυματομορφών" title="Απόκρυψη κυματομορφών" className={cn(spineBtn, "text-cm-muted")}>
        {position === "top" ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
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
  );

  // Same order in both positions: screen, then the info row, so at the bottom the strips sit right above their deck halves.
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
          {/* Shared playhead caps (decorative); the line itself is drawn by each lane's canvas and joins through the seam. */}
          <span aria-hidden className="pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-[var(--cm-playhead)]" />
          <span aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 z-20 -translate-x-1/2 border-x-[5px] border-b-[6px] border-x-transparent border-b-[var(--cm-playhead)]" />
        </div>
      )}
      <div data-deck-info-row style={{ height: `${DECK_INFO_HEIGHT}px` }}
        className={cn("grid shrink-0 grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)] bg-cm-bg-2/65 backdrop-blur-xl dark:bg-cm-bg-2/50", mode === "full" && "shadow-[inset_0_1px_0_oklch(0_0_0/0.4)]")}>
        {info("A")}
        {spine}
        {info("B")}
      </div>
    </div>
  );
}
