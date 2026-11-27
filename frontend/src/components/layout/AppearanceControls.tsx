import { useRef, useState } from "react";
import { ImageIcon, Volume2 } from "../../lib/icons";
import { usePlayer } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { MAXIMIZER_BUILT } from "../../lib/audio/maximizer";
import { cn } from "../../lib/cn";
import { PlaybackOptions } from "../PlaybackOptions";
import { MasterMeterBar } from "../MasterMeter";
import { MaximizerControls, MaximizerReductionBar } from "../MaximizerControls";
import { barChip } from "../RecordingControls";
import { GlossaryLink } from "../GlossaryLink";
import BackgroundPicker from "../backgrounds/BackgroundPicker";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** What is on, for the button's name and its cyan dot. */
function useProcessing() {
  const [autoGain] = usePref("autoGain");
  const [limiter] = usePref("audioLimiter");
  const [maximizerOn] = usePref("maximizer");
  const maximizer = MAXIMIZER_BUILT && maximizerOn;
  const label = `Ρυθμίσεις έντασης ήχου · Auto Gain ${autoGain ? "ενεργό" : "ανενεργό"} · Audio Limiter ${limiter ? "ενεργό" : "ανενεργό"}${MAXIMIZER_BUILT ? ` · Maximizer ${maximizer ? "ενεργό" : "ανενεργό"}` : ""}`;
  return { any: autoGain || limiter || maximizer, maximizer, label };
}

const activeDot = "absolute rounded-full bg-cm-cyan shadow-[0_0_6px_var(--color-cm-cyan)]";

/**
 * «Ένταση ακρόασης»: the master meter with the held peak on top, the switches, and what «LIM» means. Wide and low; the
 * Maximizer's controls (personal builds) are a second column, so it grows sideways, never down.
 */
function LoudnessPanel({ onGlossary }: { onGlossary: () => void }) {
  const { processingStatus } = usePlayer();
  const peak = useRef<HTMLSpanElement>(null);
  const main = (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Ένταση ακρόασης</h2>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-cm-muted" ref={peak} />
        <GlossaryLink id="auto-gain" onClick={onGlossary} />
      </div>
      <MasterMeterBar live lamp={false} row={8} className="w-full" peak={peak} />
      <PlaybackOptions status={processingStatus} wide />
      <p className="text-[11px] leading-snug text-cm-muted">
        <b className="font-mono font-bold text-cm-text">LIM</b>: ο limiter ασφαλείας του master, πάντα ενεργός· ξεχωριστός από τον Audio Limiter.
      </p>
    </div>
  );
  if (!MAXIMIZER_BUILT) return main;
  return (
    <div className="grid grid-cols-[16rem_1fr] gap-4">
      <div className="border-r border-cm-line/15 pr-4 dark:border-white/8"><MaximizerControls /></div>
      {main}
    </div>
  );
}

/**
 * The top bar's centre: one button holding the speaker (cyan dot while Auto Gain, the Limiter or the Maximizer is on), the
 * master meter with «LIM», and «MAX» with its reduction while the Maximizer runs (personal builds). Its popover hangs to the
 * left of the button and below the bar, wide and low, so it never covers the playhead at the window's centre.
 */
export function LoudnessBarButton({ outside }: { outside: boolean }) {
  const { any, maximizer, label } = useProcessing();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  return (
    <Popover open={open} onOpenChange={next => { if (next) setWidth(button.current?.offsetWidth ?? 0); setOpen(next); }}>
      <PopoverTrigger asChild>
        <button ref={button} type="button" aria-label={`Ένταση ακρόασης · ${label}`} title="Ένταση ακρόασης"
          className={cn(barChip, "gap-2 bg-cm-contrast/5 px-1.5 hover:bg-cm-contrast/10 data-[state=open]:border-cm-cyan/40")}>
          <span className="relative flex size-4 shrink-0 items-center justify-center text-cm-text">
            <Volume2 className="size-3.5" />
            {any && <span aria-hidden className={cn(activeDot, "-right-0.5 -top-0.5 size-1.5")} />}
          </span>
          <MasterMeterBar live outside={outside} className="w-40 @max-[1000px]/topbar:w-24" />
          {maximizer && (
            <span className="flex h-4 shrink-0 items-center gap-1 rounded-[3px] border border-cm-cyan/50 bg-cm-cyan/10 px-1 font-mono text-[10px] font-bold leading-none text-cm-cyan">
              MAX<MaximizerReductionBar className="w-6" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* Bottom-end, moved left by the button's width: the popover's right edge meets the button's left edge. */}
      <PopoverContent side="bottom" align="end" alignOffset={width} sideOffset={2} collisionPadding={8}
        className={cn("max-w-[calc(100vw-1rem)] p-3", MAXIMIZER_BUILT ? "w-[780px]" : "w-[500px]")}>
        <LoudnessPanel onGlossary={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The top bar's icon buttons (theme, background): as tall as its chips, a lit square while their popover is open. */
export const barIcon = "pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-md text-cm-muted transition hover:bg-cm-contrast/10 hover:text-cm-text active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-cm-cyan data-[state=open]:bg-cm-cyan/12 data-[state=open]:text-cm-cyan [&_svg]:size-3.5";

/** «Επιλογή φόντου» in the top bar, right of the centre: the popover hangs under the bar from the button's right edge. */
export function BackgroundSettingsButton({ className }: { className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Επιλογή φόντου" title="Επιλογή φόντου" className={cn(barIcon, className)}>
          <ImageIcon aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={2} collisionPadding={8} className="w-72 max-w-[calc(100vw-1rem)]">
        <BackgroundPicker />
        <p className="mt-2 text-[11px] text-cm-muted">Προσαρμόζεται στο θέμα της εφαρμογής. Η μειωμένη κίνηση κρατά το φόντο στατικό.</p>
      </PopoverContent>
    </Popover>
  );
}
