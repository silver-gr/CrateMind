import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { isDesktopRuntime } from "../../lib/desktopRuntime";
import { Grid3x3 } from "../../lib/icons";
import { useMidiConnected } from "../../lib/mixer";
import { useTwoDeck } from "../../lib/player";
import { useOutsideMaster } from "../../lib/recorder";
import type { Job } from "../../lib/types";
import { barChip, TopBarRecord } from "../RecordingControls";
import { LoudnessBarButton } from "./AppearanceControls";

/** The native host's mark: macOS windowed "overlay", macOS full screen "fullscreen", Windows "custom"; the web runner has none. */
const marker = () => (typeof document === "undefined" ? undefined : document.documentElement.dataset.nativeTitlebar);
function subscribeMarker(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-native-titlebar"] });
  return () => observer.disconnect();
}
const useMarker = () => useSyncExternalStore(subscribeMarker, marker, () => undefined);

/** «Ανάλυση 41%»'s number: a BPM / key analysis still pending or running, else null. */
export function analysisPercent(job: Pick<Job, "kind" | "status" | "processed" | "total"> | null): number | null {
  if (job?.kind !== "analyze" || (job.status !== "running" && job.status !== "pending")) return null;
  return job.total ? Math.min(100, Math.floor((job.processed / job.total) * 100)) : 0;
}

/** «23:14»: 24-hour, as the Greek default. */
export const clockText = (date: Date) => `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;

const POLL_MS = 3000;

/** The running analysis, asked every few seconds while the window is visible. */
function useRunningAnalysis(): number | null {
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(poll, POLL_MS);
      if (document.visibilityState !== "visible") return;
      api.scanStatus().then(job => { if (alive) setPercent(analysisPercent(job)); }, () => {});
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return percent;
}

function useClock(): string {
  const [now, setNow] = useState(() => clockText(new Date()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const date = new Date();
      setNow(clockText(date));
      timer = setTimeout(tick, 60_000 - date.getSeconds() * 1000 - date.getMilliseconds() + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** Plain text that ignores the pointer, so it drags the window like the empty strip. */
function ControllerStatus() {
  const connected = useMidiConnected();
  return (
    <div className={cn(barChip, "pointer-events-none border-transparent px-1 dark:border-transparent")}>
      <Grid3x3 aria-hidden className={cn("size-3.5", connected ? "text-cm-cyan" : "text-cm-faint")} />
      <span className={cn("whitespace-nowrap @max-[1000px]/topbar:sr-only", connected ? "text-cm-text" : "text-cm-faint")}>
        {connected ? "Mixtrack" : "Κανένα controller"}
      </span>
    </div>
  );
}

function AnalysisChip({ percent }: { percent: number }) {
  const navigate = useNavigate();
  const label = `Ανάλυση BPM και key σε εξέλιξη: ${percent}%. Άνοιγμα της ανάλυσης στις Ρυθμίσεις`;
  return (
    <button type="button" aria-label={label} title={label} onClick={() => navigate("/settings?section=analysis")}
      className={cn(barChip, "relative overflow-hidden hover:text-cm-text")}>
      <span className="@max-[1200px]/topbar:hidden">Ανάλυση</span>
      <span className="font-mono tabular-nums text-cm-text">{percent}%</span>
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-cm-contrast/10">
        <span className="block h-full bg-cm-cyan" style={{ width: `${percent}%` }} />
      </span>
    </button>
  );
}

/**
 * The top bar, in every host: a layer drawn over the 32 px title strip, which stays bare, drag-only and hidden from assistive
 * tech. The layer ignores the pointer except on its buttons, so every empty stretch still drags the window and a double-click
 * still zooms it. Left: controller status and a running analysis. Centre, on the window's centre line: «Ένταση ακρόασης» with
 * the master meter, and REC to its right. Right: the clock. The corners stay clear for the macOS traffic lights (windowed) and
 * the Windows caption buttons; macOS full screen and the web runner have neither, so the bar starts 12 px in. Every item is
 * centred in the 32 px strip (16 px down); on windowed macOS the shell moves the traffic lights down to that line too
 * (`traffic_light_position` in native/src-tauri/src/lib.rs).
 */
export default function TopBar() {
  const host = useMarker();
  const mac = host === "overlay";
  const desktop = isDesktopRuntime();
  const twoDeck = useTwoDeck();
  const outside = useOutsideMaster(twoDeck);
  const analysis = useRunningAnalysis();
  const clock = useClock();
  return (
    <div data-top-bar className="@container/topbar pointer-events-none fixed inset-x-0 top-0 z-50 h-[var(--cm-titlebar-height)] select-none">
      <div className={cn("relative flex h-full items-center gap-1.5", mac ? "pl-[88px] pr-3" : host === "custom" ? "pl-3 pr-[150px]" : "px-3")}>
        {desktop && <ControllerStatus />}
        {analysis !== null && <AnalysisChip percent={analysis} />}
        <div className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center @max-[700px]/topbar:static @max-[700px]/topbar:ml-1.5 @max-[700px]/topbar:translate-x-0">
          <div className="relative flex items-center">
            <LoudnessBarButton outside={outside} />
            {/* Grows to the right, so the meter never moves. */}
            <div className="absolute left-full top-1/2 ml-3 -translate-y-1/2"><TopBarRecord outside={outside} /></div>
          </div>
        </div>
        <span className="ml-auto font-mono text-xs font-medium tabular-nums text-cm-muted @max-[800px]/topbar:hidden">{clock}</span>
      </div>
    </div>
  );
}
