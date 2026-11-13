import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
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
import InstallPrompt from "../InstallPrompt";
import Sidebar from "./Sidebar";
import WindowControls from "./WindowControls";
import SoftAuroraBackground from "./SoftAuroraBackground";
import { useResizable } from "../../lib/useResizable";
import { useTheme } from "../../lib/theme";
import { peakLimiterWorkletUrl } from "../../lib/playbackAudio";
import { PLAYER_DEFAULT_HEIGHT, PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, DECK_DEFAULT_HEIGHT, DECK_MIN_HEIGHT, DECK_MAX_HEIGHT } from "../../lib/playerLayout";
import { useTwoDeck } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/cn";
import { ChevronDown, ChevronUp } from "../../lib/icons";

/** A top panel never stacks on the dock, so its height reports are ignored; resize drags then skip re-rendering the shell and dock. */
const IGNORE_PANEL_HEIGHT = (_px: number) => {};

/** Height of the folded dock: just enough for the arrow that unfolds it. */
const DOCK_COLLAPSED_HEIGHT = 22;
import { useMidiActions } from "../../lib/midiActions";
import PwaTitlebar from "./PwaTitlebar";

/** App chrome: aurora backdrop, sidebar, routed content, full-width player dock, ⌘K palette, install prompt, toasts. */
export default function AppShell({ children }: { children: ReactNode }) {
  const [theme] = useTheme();
  const [profile] = usePref("libraryProfile");

  const twoDeck = useTwoDeck();
  useMidiActions();
  const single = useResizable({
    direction: "vertical",
    initial: PLAYER_DEFAULT_HEIGHT,
    min: PLAYER_MIN_HEIGHT,
    max: PLAYER_MAX_HEIGHT,
    storageKey: "cm:player-height",
    reverse: true,
  });
  const deckMode = useResizable({
    direction: "vertical",
    initial: DECK_DEFAULT_HEIGHT,
    min: DECK_MIN_HEIGHT,
    max: DECK_MAX_HEIGHT,
    storageKey: "cm:deck-height",
    reverse: true,
  });
  const { size: playerHeight, isDragging: isPlayerDragging, handleProps: playerHandleProps } = twoDeck ? deckMode : single;

  // Two-deck panel height (headers + waveforms); it sits above the dock and counts as player height.
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
      <div className="relative flex h-full flex-col">
        <SoftAuroraBackground />
        <div data-native-titlebar-strip data-tauri-drag-region aria-hidden="true" />
        <WindowControls />
        <PwaTitlebar />
        <CommandPalette key={profile} />
        <ShortcutsDialog />
        <InstallPrompt />

        {twoDeck && deckViewPosition === "top" && <DeckViewSlot dockHeight={stackHeight} onHeight={IGNORE_PANEL_HEIGHT} position="top" />}

        <div className="relative z-10 flex min-h-0 flex-1">
          <Sidebar key={profile} />
          {/* ground over the aurora so page text stays legible */}
          <main className="min-h-0 flex-1 overflow-hidden bg-cm-bg/30">{children}</main>
        </div>

        {twoDeck && deckViewPosition === "bottom" && <DeckViewSlot dockHeight={stackHeight} onHeight={setPanelHeight} position="bottom" />}

        {mixActive && <MixStatusStrip />}
        <MixAnnouncer />

        {/* full-width dock below sidebar + content — flex child, never overlays */}
        <div className={cn("relative z-20 shrink-0", dockCollapsed && "border-t border-cm-line/20 bg-cm-bg-2/60 dark:border-white/8")} style={{ height: `${dockHeight}px` }}>
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

        <Toaster
          theme={theme}
          position="bottom-center"
          offset={{ bottom: totalHeight + 16, right: 16 }}
          mobileOffset={{ bottom: totalHeight + 16, right: 16, left: 16 }}
          toastOptions={{
            unstyled: true,
            classNames: {
              // Opaque menu surface; toasts stacked behind the front one hide their content (no text bleed).
              toast:
                "surface-menu flex w-full items-center gap-3 rounded-2xl border p-4 text-cm-text *:transition-opacity *:duration-200 data-[front=false]:data-[expanded=false]:*:opacity-0",
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
            },
          }}
        />
      </div>
    </TooltipProvider>
    </MotionConfig>
  );
}
