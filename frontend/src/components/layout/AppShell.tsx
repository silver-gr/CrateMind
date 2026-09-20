import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "../ui/tooltip";
import MiniPlayer from "../MiniPlayer";
import CommandPalette from "../CommandPalette";
import Sidebar from "./Sidebar";
import SoftAuroraBackground from "./SoftAuroraBackground";
import { useResizable } from "../../lib/useResizable";
import { useTheme } from "../../lib/theme";

/** App chrome: aurora backdrop, sidebar, routed content, full-width player dock, ⌘K palette, toasts. */
export default function AppShell({ children }: { children: ReactNode }) {
  const [theme] = useTheme();

  const {
    size: playerHeight,
    isDragging: isPlayerDragging,
    handleProps: playerHandleProps,
  } = useResizable({
    direction: "vertical",
    initial: 64,
    min: 60,
    max: 150,
    storageKey: "cm:player-height",
    reverse: true,
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--cm-player-height", `${playerHeight}px`);
  }, [playerHeight]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex h-full flex-col">
        <SoftAuroraBackground />
        <CommandPalette />

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
            classNames: {
              toast:
                "!bg-cm-panel-2 !border !border-cm-border !text-cm-text !rounded-xl !backdrop-blur-xl shadow-lg",
              description: "!text-cm-muted",
            },
          }}
        />
      </div>
    </TooltipProvider>
  );
}
