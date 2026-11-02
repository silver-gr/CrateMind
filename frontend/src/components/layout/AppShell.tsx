import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "../ui/tooltip";
import DeckDock from "../DeckDock";
import DeckViewSlot from "../DeckViewSlot";
import { combinedPlayerHeight } from "../../lib/deckView";
import CommandPalette from "../CommandPalette";
import ShortcutsDialog from "../ShortcutsDialog";
import InstallPrompt from "../InstallPrompt";
import Sidebar from "./Sidebar";
import SoftAuroraBackground from "./SoftAuroraBackground";
import { useResizable } from "../../lib/useResizable";
import { useTheme } from "../../lib/theme";
import { peakLimiterWorkletUrl } from "../../lib/playbackAudio";
import { PLAYER_DEFAULT_HEIGHT, PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT, DECK_DEFAULT_HEIGHT, DECK_MIN_HEIGHT, DECK_MAX_HEIGHT } from "../../lib/playerLayout";
import { useTwoDeck } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/cn";
import { ChevronDown, ChevronUp } from "../../lib/icons";

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
  // Only a bottom panel stacks on the dock; bottom-anchored overlays (toasts, sidebar footer) clear both.
  const totalHeight = combinedPlayerHeight(dockHeight, twoDeck && deckViewPosition === "bottom" ? panelHeight : 0);

  useEffect(() => {
    document.documentElement.style.setProperty("--cm-player-height", `${totalHeight}px`);
  }, [totalHeight]);

  return (
    <TooltipProvider delayDuration={300}>
      <meta name="cratemind-audio-worklet" content={peakLimiterWorkletUrl} />
      <div className="relative flex h-full flex-col">
        <SoftAuroraBackground />
        <div data-native-titlebar-strip data-tauri-drag-region aria-hidden="true" />
        <PwaTitlebar />
        <CommandPalette key={profile} />
        <ShortcutsDialog />
        <InstallPrompt />

        {twoDeck && deckViewPosition === "top" && <DeckViewSlot dockHeight={dockHeight} onHeight={setPanelHeight} position="top" />}

        <div className="relative z-10 flex min-h-0 flex-1">
          <Sidebar key={profile} />
          {/* ground over the aurora so page text stays legible */}
          <main className="min-h-0 flex-1 overflow-hidden bg-cm-bg/30">{children}</main>
        </div>

        {twoDeck && deckViewPosition === "bottom" && <DeckViewSlot dockHeight={dockHeight} onHeight={setPanelHeight} position="bottom" />}

        {/* full-width dock below sidebar + content — flex child, never overlays */}
        <div className={cn("relative z-20 shrink-0", dockCollapsed && "border-t border-cm-line/20 bg-cm-bg-2/60 dark:border-white/8")} style={{ height: `${dockHeight}px` }}>
          <DeckDock
            height={playerHeight}
            isDragging={isPlayerDragging}
            handleProps={playerHandleProps}
            collapsed={dockCollapsed}
          />
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
              toast:
                "glass-strong flex w-full items-center gap-3 rounded-2xl p-4 text-cm-text",
              content: "min-w-0 flex-1 space-y-1",
              title: "text-sm font-medium leading-relaxed",
              description: "text-xs leading-relaxed text-cm-muted",
              icon: "shrink-0 text-cm-cyan",
              actionButton: "surface-field rounded-md border px-2 py-1 text-xs text-cm-text",
              cancelButton: "surface-field rounded-md border px-2 py-1 text-xs text-cm-muted",
            },
          }}
        />
      </div>
    </TooltipProvider>
  );
}
