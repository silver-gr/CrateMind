import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "../ui/tooltip";
import MiniPlayer from "../MiniPlayer";
import CommandPalette from "../CommandPalette";
import Sidebar from "./Sidebar";
import SoftAuroraBackground from "./SoftAuroraBackground";

/** App chrome: aurora backdrop, sidebar, routed content, full-width player dock, ⌘K palette, toasts. */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex h-full flex-col">
        <SoftAuroraBackground />
        <CommandPalette />

        <div className="relative z-10 flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        </div>

        {/* full-width dock below sidebar + content — flex child, never overlays */}
        <div className="relative z-20">
          <MiniPlayer />
        </div>

        <Toaster
          theme="dark"
          position="bottom-right"
          offset={84}
          toastOptions={{
            classNames: {
              toast:
                "!bg-cm-panel-2 !border !border-white/10 !text-cm-text !rounded-xl !backdrop-blur-xl",
              description: "!text-cm-muted",
            },
          }}
        />
      </div>
    </TooltipProvider>
  );
}
