import { Sparkles, SlidersHorizontal } from "../../lib/icons";
import { cn } from "../../lib/cn";
import { usePlayer } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { PlaybackOptions } from "../PlaybackOptions";
import BackgroundPicker from "../backgrounds/BackgroundPicker";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const buttonClass = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cm-border text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan";

export function AudioSettingsButton() {
  const [autoGain] = usePref("autoGain");
  const [limiter] = usePref("audioLimiter");
  const { processingStatus } = usePlayer();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Ρυθμίσεις έντασης ήχου" title="Auto Gain και Audio Limiter"
          className={cn(buttonClass, (autoGain || limiter) && "border-cm-cyan/40 text-cm-cyan")}>
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <h2 className="mb-3 text-sm font-semibold">Ένταση ακρόασης</h2>
        <PlaybackOptions status={processingStatus} />
      </PopoverContent>
    </Popover>
  );
}

export function BackgroundSettingsButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Επιλογή φόντου" title="Επιλογή φόντου" className={buttonClass}>
          <Sparkles className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <BackgroundPicker />
        <p className="mt-2 text-[11px] text-cm-muted">Προσαρμόζεται στο θέμα της εφαρμογής. Η μειωμένη κίνηση κρατά το φόντο στατικό.</p>
      </PopoverContent>
    </Popover>
  );
}
