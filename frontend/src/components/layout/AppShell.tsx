import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "../ui/tooltip";
import DeckDock from "../DeckDock";
import DeckViewSlot from "../DeckViewSlot";
import MixConductor from "../MixConductor";
import MixStatusStrip, { MixAnnouncer, STRIP_H } from "../MixStatusStrip";
import { useMixStatus } from "../../lib/mix/mixSession";
import { combinedPlayerHeight } from "../../lib/deckView";
import CommandPalette from "../CommandPalette";
import ShortcutsDialog from "../ShortcutsDialog";
import AboutDialog from "../AboutDialog";
import InstallPrompt from "../InstallPrompt";
import Sidebar from "./Sidebar";
import WindowControls from "./WindowControls";
import SoftAuroraBackground from "./SoftAuroraBackground";
import { useResizable } from "../../lib/useResizable";
import { useTheme } from "../../lib/theme";
import { peakLimiterWorkletUrl } from "../../lib/playbackAudio";
import { PLAYER_DEFAULT_HEIGHT, PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, DECK_DEFAULT_HEIGHT, DECK_HEIGHT_KEY, DECK_MIN_HEIGHT, DECK_MAX_HEIGHT, dockSides, moveOldDeckHeight } from "../../lib/playerLayout";
import { PageLeftRailContext, PageRailContext } from "../../lib/pageRail";
import { preferenceStorage } from "../../lib/preferenceStorage";
import { useTwoDeck } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/cn";
import { ChevronDown, ChevronUp } from "../../lib/icons";

/** A top panel never stacks on the dock, so its height reports are ignored; resize drags then skip re-rendering the shell and dock. */
const IGNORE_PANEL_HEIGHT = (_px: number) => {};

/** Height of the folded dock: just enough for the arrow that unfolds it. */
const DOCK_COLLAPSED_HEIGHT = 22;
import { useMidiActions } from "../../lib/midiActions";
import { useMaximizer } from "../../lib/useMaximizer";
import { useMasterHostWatcher } from "../../lib/masterHost";
import { useFxRack } from "../../lib/useFxRack";
import { usePlayHistory } from "../../lib/usePlayHistory";
import { useDeckRescue } from "../../lib/useDeckRescue";
import { installNativeMenuGuard } from "../../lib/nativeContextMenu";
import PwaTitlebar from "./PwaTitlebar";
import TopBar from "./TopBar";

/** App chrome: aurora backdrop, sidebar, routed content, page rail, player dock, ⌘K palette, install prompt, toasts. */
export default function AppShell({ children }: { children: ReactNode }) {
  const [theme] = useTheme();
  const [profile] = usePref("libraryProfile");

  const twoDeck = useTwoDeck();
  useMidiActions();
  useMaximizer();
  useMasterHostWatcher(twoDeck);
  useFxRack(twoDeck);
  usePlayHistory();
  useDeckRescue();
  // Desktop app: no webview menu («Reload») outside CrateMind's own menus and text.
  useEffect(() => installNativeMenuGuard(), []);
  const single = useResizable({
    direction: "vertical",
    initial: PLAYER_DEFAULT_HEIGHT,
    min: PLAYER_MIN_HEIGHT,
    max: PLAYER_MAX_HEIGHT,
    storageKey: "cm:player-height",
    reverse: true,
  });
  // Before the two-deck height is first read: a stored 240 px, the default while the overview lived in the dock, becomes 208 once.
  useState(() => { try { moveOldDeckHeight(preferenceStorage); } catch { /* preferences unavailable: the stored height stays */ } });
  const deckMode = useResizable({
    direction: "vertical",
    initial: DECK_DEFAULT_HEIGHT,
    min: DECK_MIN_HEIGHT,
    max: DECK_MAX_HEIGHT,
    storageKey: DECK_HEIGHT_KEY,
    reverse: true,
  });
  const { size: playerHeight, isDragging: isPlayerDragging, handleProps: playerHandleProps } = twoDeck ? deckMode : single;

  // Two-deck panel height (waveforms + facts row); at the bottom it sits above the dock and counts as player height.
  const [panelHeight, setPanelHeight] = useState(0);
  const [deckViewPosition] = usePref("deckViewPosition");
  const [dockCollapsed, setDockCollapsed] = usePref("dockCollapsed");
  const dockHeight = dockCollapsed ? DOCK_COLLAPSED_HEIGHT : playerHeight;
  // A running set mix adds its status strip right above the dock.
  const mixActive = useMixStatus() !== "idle";
  const stackHeight = dockHeight + (mixActive ? STRIP_H : 0);
  // Only a bottom panel stacks on the dock; bottom-anchored overlays (toasts, sidebar footer) clear both.
  const totalHeight = combinedPlayerHeight(stackHeight, twoDeck && deckViewPosition === "bottom" ? panelHeight : 0);

  useEffect(() => {
    document.documentElement.style.setProperty("--cm-player-height", `${totalHeight}px`);
  }, [totalHeight]);

  // The widths of the page column and the two side columns (none depends on where the dock sits: a grid item that spans the
  // flexible page column never sizes the side columns), from which the two-deck dock picks the span it sits in.
  const mainRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState({ column: 0, left: 0, right: 0 });
  useLayoutEffect(() => {
    const els = [mainRef.current, leftRef.current, rightRef.current];
    if (els.some(el => !el) || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const [column, left, right] = els.map(el => Math.round(el!.getBoundingClientRect().width));
      setWidths(prev => (prev.column === column && prev.left === left && prev.right === right ? prev : { column, left, right }));
    };
    measure(); // before the first paint, so the dock never starts in the wrong place
    const observer = new ResizeObserver(measure);
    for (const el of els) observer.observe(el!);
    return () => observer.disconnect();
  }, []);
  const sides = dockSides(widths.column, widths.left, widths.right, twoDeck);
  // The right rail's content element, made once: a page portals its right panel into it from its first render (lib/pageRail.tsx).
  const [rail] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "flex h-full min-h-0";
    return el;
  });
  const railHost = useCallback((host: HTMLDivElement | null) => {
    rightRef.current = host;
    if (host && rail && rail.parentElement !== host) host.appendChild(rail);
  }, [rail]);
  // The left column's element for a page's left panel, made once; a page moves its panel there only while the sidebar shows no
  // column of its own (the floating bar), which the sidebar reports.
  const [leftHost] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "flex h-full min-h-0";
    return el;
  });
  const leftRailHost = useCallback((host: HTMLDivElement | null) => { if (host && leftHost && leftHost.parentElement !== host) host.appendChild(leftHost); }, [leftHost]);
  const [floatingSidebar, setFloatingSidebar] = useState(false);
  const leftRail = useMemo(() => (leftHost ? { host: leftHost, shown: floatingSidebar } : null), [leftHost, floatingSidebar]);
  // Both side columns run from under the top bar, beside the top deck panel and the page; each runs on to the window's bottom
  // when the dock leaves it room (dockSides), else it ends above the bottom panel, the mix strip and the dock.
  const leftRows = sides === "both" || sides === "left" ? "[grid-row:1/6]" : "[grid-row:1/3]";
  const railRows = sides === "both" || sides === "right" ? "[grid-row:1/6]" : "[grid-row:1/3]";
  const under = { both: "[grid-column:2]", left: "[grid-column:2/4]", right: "[grid-column:1/3]", none: "[grid-column:1/4]" }[sides];

  // In-app «Μειωμένη κίνηση» reaches CSS (data-reduce-motion on <html>; main.tsx sets it before first render)
  // and every Motion component (MotionConfig). Layout effect, so the first paint after a change already honours it.
  const [reduceMotion] = usePref("reduceMotion");
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-reduce-motion", reduceMotion);
  }, [reduceMotion]);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
    <TooltipProvider delayDuration={300}>
      <meta name="cratemind-audio-worklet" content={peakLimiterWorkletUrl} />
      <div className="relative flex h-full flex-col overflow-clip">
        <SoftAuroraBackground />
        <div data-native-titlebar-strip data-tauri-drag-region aria-hidden="true" />
        <WindowControls />
        <TopBar />
        <PwaTitlebar />
        <CommandPalette key={profile} />
        <ShortcutsDialog />
        <AboutDialog />
        <InstallPrompt />

        {/* sidebar or a page's left panel | top deck panel over the page | right rail, over the bottom panel, the mix strip and the dock.
            Placement is CSS only: nothing remounts when the dock moves or the sidebar folds, unfolds or is resized. */}
        <div className="relative z-10 grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)_auto_auto_auto]">
          {/* Above the panels beside it, so its resize handle stays whole next to the deck panel. */}
          <div ref={leftRef} className={cn("relative z-30 flex min-h-0 [grid-column:1]", leftRows)}>
            <Sidebar key={profile} onFloating={setFloatingSidebar} />
            {/* On the page's ground (as under <main>), so a left panel looks as it did in the page. */}
            <div ref={leftRailHost} data-page-left-rail className="flex min-h-0 bg-cm-bg/30 light:bg-transparent" />
          </div>
          {/* Between the side columns: the lanes, and so the playhead, centre on the width left. */}
          {twoDeck && deckViewPosition === "top" && <div className="min-w-0 [grid-row:1] [grid-column:2]"><DeckViewSlot dockHeight={stackHeight} onHeight={IGNORE_PANEL_HEIGHT} position="top" /></div>}
          {/* ground over the aurora so page text stays legible */}
          <main ref={mainRef} className="min-h-0 min-w-0 overflow-hidden bg-cm-bg/30 [grid-area:2/2] light:bg-transparent">
            <PageRailContext.Provider value={rail}><PageLeftRailContext.Provider value={leftRail}>{children}</PageLeftRailContext.Provider></PageRailContext.Provider>
          </main>
          <div ref={railHost} data-page-rail className={cn("flex min-h-0 [grid-column:3]", railRows)} />

          {twoDeck && deckViewPosition === "bottom" && <div className={cn("min-w-0 [grid-row:3]", under)}><DeckViewSlot dockHeight={stackHeight} onHeight={setPanelHeight} position="bottom" /></div>}

          {mixActive && <div className={cn("min-w-0 [grid-row:4]", under)}><MixStatusStrip /></div>}

          {/* the dock between the side columns, beside one of them, or under the whole window (dockSides) — a grid row, never overlays */}
          <div data-dock-sides={sides} className={cn("relative z-20 min-w-0 [grid-row:5]", under, dockCollapsed && "border-t border-cm-line/20 bg-cm-bg-2/35 backdrop-blur-xl dark:border-white/8 dark:bg-cm-bg-2/60")} style={{ height: `${dockHeight}px` }}>
            <DeckDock
              height={playerHeight}
              isDragging={isPlayerDragging}
              handleProps={playerHandleProps}
              collapsed={dockCollapsed}
            />
            <MixConductor />
            <button type="button" onClick={() => setDockCollapsed(!dockCollapsed)} aria-expanded={!dockCollapsed}
              aria-label={dockCollapsed ? "Εμφάνιση decks" : "Απόκρυψη decks"} title={dockCollapsed ? "Εμφάνιση decks" : "Απόκρυψη decks"}
              className="absolute right-2 top-0.5 z-50 flex size-5 items-center justify-center rounded text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan motion-safe:active:scale-95">
              {dockCollapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          </div>
        </div>
        <MixAnnouncer />

        <Toaster
          theme={theme}
          position="bottom-center"
          // Toasts time out; a task's outcome (TASK_RESULT_TOAST) stays until closed with the X.
          offset={{ bottom: totalHeight + 16, right: 16 }}
          mobileOffset={{ bottom: totalHeight + 16, right: 16, left: 16 }}
          // The widest a toast may get; each toast is as wide as its text needs (see `toast` below), centred in this.
          style={{ "--width": "min(880px, calc(100vw - 2rem))" } as CSSProperties}
          toastOptions={{
            unstyled: true,
            closeButtonAriaLabel: "Κλείσιμο",
            classNames: {
              // Frosted glass like the cards; toasts stacked behind the front one hide their content (no text bleed through the glass).
              toast:
                "glass-strong inset-x-0 mx-auto flex w-fit max-w-full min-w-[min(20rem,100%)] items-center gap-3 rounded-2xl border p-4 text-cm-text *:transition-opacity *:duration-200 data-[front=false]:data-[expanded=false]:*:opacity-0",
              content: "min-w-0 flex-1 space-y-1",
              title: "text-sm font-medium leading-relaxed",
              description: "text-xs leading-relaxed text-cm-muted",
              icon: "shrink-0",
              success: "[&_[data-icon]]:text-cm-chartreuse",
              error: "border-cm-rose/35 [&_[data-icon]]:text-cm-rose",
              warning: "border-cm-amber/35 [&_[data-icon]]:text-cm-amber",
              info: "[&_[data-icon]]:text-cm-cyan",
              // Solar Void keeps ink text: cyan on cyan/12 is under AA at 12px there.
              actionButton: "rounded-md bg-cm-cyan/12 px-2.5 py-1 text-xs font-medium text-cm-text dark:text-cm-cyan ring-1 ring-inset ring-cm-cyan/30 transition-colors hover:bg-cm-cyan/20",
              cancelButton: "surface-field rounded-md border px-2 py-1 text-xs text-cm-muted",
              // `!`: sonner's dark-theme rule paints its own background and colour on the close button, even on unstyled toasts.
              closeButton: "order-last flex size-6 shrink-0 cursor-pointer items-center justify-center self-start rounded-md bg-transparent! text-cm-muted! transition-colors hover:bg-cm-cyan/10! hover:text-cm-text! focus-visible:outline-2 focus-visible:outline-cm-cyan",
            },
          }}
        />
      </div>
    </TooltipProvider>
    </MotionConfig>
  );
}
