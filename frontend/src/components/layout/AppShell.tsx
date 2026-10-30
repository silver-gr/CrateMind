import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "../ui/tooltip";
import MiniPlayer from "../MiniPlayer";
import CommandPalette from "../CommandPalette";
import InstallPrompt from "../InstallPrompt";
import Sidebar from "./Sidebar";
import SoftAuroraBackground from "./SoftAuroraBackground";
import { useResizable } from "../../lib/useResizable";
import { useTheme } from "../../lib/theme";
import { peakLimiterWorkletUrl } from "../../lib/playbackAudio";
import { PLAYER_DEFAULT_HEIGHT, PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT } from "../../lib/playerLayout";
import PwaTitlebar from "./PwaTitlebar";

/** App chrome: aurora backdrop, sidebar, routed content, full-width player dock, ⌘K palette, install prompt, toasts. */
export default function AppShell({ children }: { children: ReactNode }) {
  const [theme] = useTheme();

  const {
    size: playerHeight,
    isDragging: isPlayerDragging,
    handleProps: playerHandleProps,
  } = useResizable({
    direction: "vertical",
    initial: PLAYER_DEFAULT_HEIGHT,
    min: PLAYER_MIN_HEIGHT,
    max: PLAYER_MAX_HEIGHT,
    storageKey: "cm:player-height",
    reverse: true,
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--cm-player-height", `${playerHeight}px`);
  }, [playerHeight]);

  return (
    <TooltipProvider delayDuration={300}>
      <meta name="cratemind-audio-worklet" content={peakLimiterWorkletUrl} />
      <div className="relative flex h-full flex-col">
        <SoftAuroraBackground />
        <div data-native-titlebar-strip data-tauri-drag-region aria-hidden="true" />
        <PwaTitlebar />
        <CommandPalette />
        <InstallPrompt />

        <div className="relative z-10 flex min-h-0 flex-1">
          <Sidebar />
          {/* ground over the aurora so page text stays legible */}
          <main className="min-h-0 flex-1 overflow-hidden bg-cm-bg/30">{children}</main>
        </div>

        {/* full-width dock below sidebar + content — flex child, never overlays */}
        <div className="relative z-20 shrink-0" style={{ height: `${playerHeight}px` }}>
          <MiniPlayer
            height={playerHeight}
            isDragging={isPlayerDragging}
            handleProps={playerHandleProps}
          />
        </div>

        <Toaster
          theme={theme}
          position="bottom-center"
          offset={{ bottom: playerHeight + 16, right: 16 }}
          mobileOffset={{ bottom: playerHeight + 16, right: 16, left: 16 }}
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
