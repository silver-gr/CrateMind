import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { PLAYER_DEFAULT_HEIGHT, PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, DECK_DEFAULT_HEIGHT, DECK_HEIGHT_KEY, DECK_MIN_HEIGHT, DECK_MAX_HEIGHT, dockInColumn, moveOldDeckHeight } from "../../lib/playerLayout";
import { PageRailContext } from "../../lib/pageRail";
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

  // The page column's width (it does not depend on where the dock sits): wide enough, the two-deck dock moves into it.
  const mainRef = useRef<HTMLElement>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setColumnWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const inColumn = dockInColumn(columnWidth, twoDeck);
  // The right rail's content element, made once: a page portals its right panel into it from its first render (lib/pageRail.tsx).
  const [rail] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "flex h-full min-h-0";
    return el;
  });
  const railHost = useCallback((host: HTMLDivElement | null) => { if (host && rail && rail.parentElement !== host) host.appendChild(rail); }, [rail]);
  // Sidebar and rail run to the bottom beside a dock in the page column; under a full-width dock they end above it.
  const side = inColumn ? "[grid-row:1/5]" : "[grid-row:1]";
  const under = inColumn ? "[grid-column:2]" : "[grid-column:1/4]";

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

        {twoDeck && deckViewPosition === "top" && <DeckViewSlot dockHeight={stackHeight} onHeight={IGNORE_PANEL_HEIGHT} position="top" />}

        {/* sidebar | page | right rail over the bottom panel, the mix strip and the dock. Placement is CSS only: nothing remounts when the dock moves. */}
        <div className="relative z-10 grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto_auto_auto]">
          <div className={cn("flex min-h-0 [grid-column:1]", side)}><Sidebar key={profile} /></div>
          {/* ground over the aurora so page text stays legible */}
          <main ref={mainRef} className="min-h-0 min-w-0 overflow-hidden bg-cm-bg/30 [grid-area:1/2] light:bg-transparent">
            <PageRailContext.Provider value={rail}>{children}</PageRailContext.Provider>
          </main>
          <div ref={railHost} data-page-rail className={cn("flex min-h-0 [grid-column:3]", side)} />

          {twoDeck && deckViewPosition === "bottom" && <div className={cn("min-w-0 [grid-row:2]", under)}><DeckViewSlot dockHeight={stackHeight} onHeight={setPanelHeight} position="bottom" /></div>}

          {mixActive && <div className={cn("min-w-0 [grid-row:3]", under)}><MixStatusStrip /></div>}

          {/* the dock under the page column (two decks, wide enough) or the whole window — a grid row, never overlays */}
          <div data-dock-placement={inColumn ? "column" : "full"} className={cn("relative z-20 min-w-0 [grid-row:4]", under, dockCollapsed && "border-t border-cm-line/20 bg-cm-bg-2/35 backdrop-blur-xl dark:border-white/8 dark:bg-cm-bg-2/60")} style={{ height: `${dockHeight}px` }}>
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
