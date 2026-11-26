import { useState } from "react";
import { ImageIcon, SlidersHorizontal } from "../../lib/icons";
import { footerIconButtonClass } from "../../lib/footerControlStyles";
import { usePlayer } from "../../lib/player";
import { usePref } from "../../lib/prefs";
import { MAXIMIZER_BUILT } from "../../lib/audio/maximizer";
import { PlaybackOptions } from "../PlaybackOptions";
import { GlossaryLink } from "../GlossaryLink";
import BackgroundPicker from "../backgrounds/BackgroundPicker";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export function AudioSettingsButton() {
  const [autoGain] = usePref("autoGain");
  const [limiter] = usePref("audioLimiter");
  const [maximizerOn] = usePref("maximizer");
  const maximizer = MAXIMIZER_BUILT && maximizerOn;
  const { processingStatus } = usePlayer();
  const [open, setOpen] = useState(false);
  const label = `Ρυθμίσεις έντασης ήχου · Auto Gain ${autoGain ? "ενεργό" : "ανενεργό"} · Audio Limiter ${limiter ? "ενεργό" : "ανενεργό"}${MAXIMIZER_BUILT ? ` · Maximizer ${maximizer ? "ενεργό" : "ανενεργό"}` : ""}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} title={label} className={footerIconButtonClass}>
          <SlidersHorizontal className="h-4 w-4" />
          {(autoGain || limiter || maximizer) && (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-cm-cyan shadow-[0_0_6px_var(--color-cm-cyan)]" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Ένταση ακρόασης</h2>
          <GlossaryLink id="auto-gain" onClick={() => setOpen(false)} />
        </div>
        <PlaybackOptions status={processingStatus} />
      </PopoverContent>
    </Popover>
  );
}

export function BackgroundSettingsButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Επιλογή φόντου" title="Επιλογή φόντου" className={footerIconButtonClass}>
          <ImageIcon className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <BackgroundPicker />
        <p className="mt-2 text-[11px] text-cm-muted">Προσαρμόζεται στο θέμα της εφαρμογής. Η μειωμένη κίνηση κρατά το φόντο στατικό.</p>
      </PopoverContent>
    </Popover>
  );
}
