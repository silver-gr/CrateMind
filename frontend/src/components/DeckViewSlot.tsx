import { useCallback, useEffect, useState } from "react";
import { ResizeHandle } from "./ui/ResizeHandle";
import { useResizable } from "../lib/useResizable";
import { DECK_HEADER_HEIGHT, WAVE_DEFAULT_HEIGHT, WAVE_MAX_HEIGHT, WAVE_MIN_HEIGHT, deckViewHeight, deckViewMode, setDeckView } from "../lib/deckView";
import { usePref } from "../lib/prefs";
import { ChevronDown, ChevronUp } from "../lib/icons";

/** Height of the folded panel strip; matches the folded dock. */
const COLLAPSED_HEIGHT = 22;

/**
 * Two-deck panel under the title bar (`top`) or between the page and the dock (`bottom`). It only provides the areas: each MiniPlayer portals its own
 * DeckHeader + DeckScrollWaveform into its area (deck A above, deck B below), so no media is owned here.
 * Reports its height through `onHeight` so the shell can fold it into --cm-player-height and the Toaster.
 * Folded (`deckViewCollapsed`), it is a thin strip and reports mode "hidden", so the waveforms unmount until it opens again.
 */
export default function DeckViewSlot({ dockHeight, onHeight, position }: { dockHeight: number; onHeight: (px: number) => void; position: "top" | "bottom" }) {
  // At the bottom the handle is on the top edge (drag up grows); at the top it is on the bottom edge (drag down grows).
  const wave = useResizable({ direction: "vertical", initial: WAVE_DEFAULT_HEIGHT, min: WAVE_MIN_HEIGHT, max: WAVE_MAX_HEIGHT, storageKey: "cm:deck-wave-height", reverse: position === "bottom" });
  const [collapsed, setCollapsed] = usePref("deckViewCollapsed");
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const refA = useCallback((el: HTMLElement | null) => setDeckView({ A: el }), []);
  const refB = useCallback((el: HTMLElement | null) => setDeckView({ B: el }), []);
  const mode = collapsed ? "hidden" : deckViewMode(windowHeight, dockHeight, wave.size);
  const height = collapsed ? COLLAPSED_HEIGHT : deckViewHeight(mode, wave.size);
  useEffect(() => { onHeight(height); }, [height, onHeight]);
  useEffect(() => { setDeckView({ mode, waveHeight: wave.size }); }, [mode, wave.size]);
  useEffect(() => () => { setDeckView({ A: null, B: null, mode: "hidden" }); onHeight(0); }, [onHeight]);

  if (mode === "hidden" && !collapsed) return null;
  const deckHeight = DECK_HEADER_HEIGHT + (mode === "full" ? wave.size : 0);
  const area = (deck: "A" | "B") => (
    <div ref={deck === "A" ? refA : refB} data-deck-view={deck} style={{ height: `${deckHeight}px` }}
      className="relative overflow-hidden border-t border-cm-line/20 bg-cm-bg-2/60 first:border-t-0 dark:border-white/8">
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-cm-faint">Deck {deck} άδειο</span>
    </div>
  );
  // The chevron points the way the panel will move: a top panel folds up, a bottom panel folds down.
  const foldIcon = (position === "top") === collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />;
  return (
    <div className={`relative z-20 shrink-0 border-cm-line/50 dark:border-white/20 ${collapsed ? "bg-cm-bg-2/60" : ""} ${position === "top" ? "border-b-2 shadow-[0_8px_16px_-6px_rgb(0_0_0/0.28)]" : "border-t-2 shadow-[0_-8px_16px_-6px_rgb(0_0_0/0.28)]"}`} style={{ height: `${height}px` }}>
      {mode === "full" && (
        <ResizeHandle orientation="horizontal" isDragging={wave.isDragging} ariaLabel="Αλλαγή ύψους κυματομορφών"
          className={`absolute inset-x-0 z-30 ${position === "top" ? "-bottom-1.5" : "-top-1.5"}`} {...wave.handleProps} />
      )}
      {!collapsed && area("A")}
      {!collapsed && area("B")}
      <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}
        aria-label={collapsed ? "Εμφάνιση κυματομορφών" : "Απόκρυψη κυματομορφών"} title={collapsed ? "Εμφάνιση κυματομορφών" : "Απόκρυψη κυματομορφών"}
        className="absolute right-2 top-0.5 z-50 flex size-5 items-center justify-center rounded text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan motion-safe:active:scale-95">
        {foldIcon}
      </button>
    </div>
  );
}
