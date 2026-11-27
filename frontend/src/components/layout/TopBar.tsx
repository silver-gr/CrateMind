import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { followAnalysisJob } from "../../lib/bpmUpdates";
import { cn } from "../../lib/cn";
import { isDesktopRuntime } from "../../lib/desktopRuntime";
import { Grid3x3 } from "../../lib/icons";
import { useMidiConnected } from "../../lib/mixer";
import { useTwoDeck } from "../../lib/player";
import { useOutsideMaster } from "../../lib/recorder";
import type { Job } from "../../lib/types";
import { barChip, TopBarRecord } from "../RecordingControls";
import { ThemeToggle } from "../ui/ThemeToggle";
import { BackgroundSettingsButton, LoudnessBarButton, barIcon } from "./AppearanceControls";

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

/** The job row's message while `analyze_all` holds tracks back because a deck plays (PLAYBACK_PAUSE_MESSAGE in
 * backend/app/services/audio_analysis.py, the line the Settings job card shows). */
export const ANALYSIS_DECK_PAUSE = "Σε παύση όσο παίζει ένα deck";

/** The chip's state: its percent, and whether the analysis is waiting for the decks; null while no analysis runs. */
export type AnalysisState = { percent: number; waiting: boolean };

export function analysisState(job: Pick<Job, "kind" | "status" | "processed" | "total" | "message"> | null): AnalysisState | null {
  const percent = analysisPercent(job);
  return percent === null ? null : { percent, waiting: job?.message === ANALYSIS_DECK_PAUSE };
}

/** The chip's visible text after «Ανάλυση», and its tooltip. */
export function analysisChipText({ percent, waiting }: AnalysisState): { value: string; label: string } {
  return waiting
    ? { value: `${percent}% · παύση`, label: `Η ανάλυση BPM και key περιμένει όσο παίζουν τα decks (${percent}%). Συνεχίζει μόλις σταματήσουν. Άνοιγμα της ανάλυσης στις Ρυθμίσεις` }
    : { value: `${percent}%`, label: `Ανάλυση BPM και key σε εξέλιξη: ${percent}%. Άνοιγμα της ανάλυσης στις Ρυθμίσεις` };
}

/** «23:14»: 24-hour, as the Greek default. */
export const clockText = (date: Date) => `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;

const POLL_MS = 3000;

/** The running analysis, asked every few seconds while the window is visible. */
function useRunningAnalysis(): AnalysisState | null {
  const [state, setState] = useState<AnalysisState | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(poll, POLL_MS);
      if (document.visibilityState !== "visible") return;
      api.scanStatus().then(job => {
        if (!alive) return;
        // Every running scan or analysis, wherever it started, ends in ANALYSIS_FINISHED (the Library's cache follows it).
        if (job) followAnalysisJob(job, api.scanStatus);
        const next = analysisState(job);
        setState(now => (now?.percent === next?.percent && now?.waiting === next?.waiting ? now : next));
      }, () => {});
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return state;
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

/** Waiting for the decks reads calmer: muted number, the progress line in a faint grey instead of cyan. */
function AnalysisChip({ state }: { state: AnalysisState }) {
  const navigate = useNavigate();
  const { value, label } = analysisChipText(state);
  return (
    <button type="button" aria-label={label} title={label} onClick={() => navigate("/settings?section=analysis")}
      data-waiting={state.waiting || undefined}
      className={cn(barChip, "relative overflow-hidden hover:text-cm-text")}>
      <span className="@max-[1200px]/topbar:hidden">Ανάλυση</span>
      <span className={cn("whitespace-nowrap font-mono tabular-nums", state.waiting ? "text-cm-muted" : "text-cm-text")}>{value}</span>
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-cm-contrast/10">
        <span className={cn("block h-full", state.waiting ? "bg-cm-contrast/30" : "bg-cm-cyan")} style={{ width: `${state.percent}%` }} />
      </span>
    </button>
  );
}

/**
 * The top bar, in every host: a layer drawn over the 32 px title strip, which stays bare, drag-only and hidden from assistive
 * tech. The layer ignores the pointer except on its buttons, so every empty stretch still drags the window and a double-click
 * still zooms it. Left: controller status and a running analysis. Centre, on the window's centre line: «Ένταση ακρόασης» with
 * the master meter, and REC to its right. Right: the background and theme buttons, then the clock. The corners stay clear for the macOS traffic lights (windowed) and
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
        {analysis !== null && <AnalysisChip state={analysis} />}
        <div className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center @max-[700px]/topbar:static @max-[700px]/topbar:ml-1.5 @max-[700px]/topbar:translate-x-0">
          <div className="relative flex items-center">
            <LoudnessBarButton outside={outside} />
            {/* Grows to the right, so the meter never moves. */}
            <div className="absolute left-full top-1/2 ml-3 -translate-y-1/2"><TopBarRecord outside={outside} /></div>
          </div>
        </div>
        {/* Right: the background, the theme and the clock, dropping out in that order as the window narrows (a recording's
            228 px REC must still clear them with Windows' 150 px corner). Settings and the palette keep the first two. */}
        <div className="ml-auto flex items-center gap-1.5">
          <BackgroundSettingsButton className="@max-[1240px]/topbar:hidden" />
          <ThemeToggle tooltipSide="bottom" className={cn(barIcon, "@max-[1180px]/topbar:hidden")} />
          <span className="ml-1 font-mono text-xs font-medium tabular-nums text-cm-muted @max-[800px]/topbar:hidden">{clock}</span>
        </div>
      </div>
    </div>
  );
}
