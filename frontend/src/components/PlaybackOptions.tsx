import { toast } from "sonner";
import { usePref } from "../lib/prefs";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { Switch } from "./ui/switch";
import { MAXIMIZER_BUILT } from "../lib/audio/maximizer";
import { MaximizerControls } from "./MaximizerControls";

const AUTO_GAIN_HELP = "Εξισορροπεί την ένταση μεταξύ tracks. Η πρώτη μέτρηση αποθηκεύεται για την επόμενη ακρόαση.";
const LIMITER_HELP = "Περιορίζει τις κορυφές της έντασης κατά την αναπαραγωγή.";

/**
 * Auto Gain, Audio Limiter and (personal builds) the Maximizer. `wide`: the low layout of the top bar's popover, the switches
 * in one row with their help as a tooltip; the Maximizer's controls are then the popover's own second column.
 */
export function PlaybackOptions({ status, wide = false }: { status?: string; wide?: boolean }) {
  const [autoGain, setAutoGain] = usePref("autoGain");
  const [limiter, setLimiter] = usePref("audioLimiter");
  function change(value: boolean, setter: (value: boolean) => void) {
    // Unlock during the user's gesture; never wait for a loudness request first.
    if (value) void unlockPlaybackAudio().catch(() => toast.error("Πάτησε αναπαραγωγή για ενεργοποίηση της επεξεργασίας ήχου."));
    setter(value);
  }
  if (wide) {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-5">
          <label title={AUTO_GAIN_HELP} className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-cm-text">
            Auto Gain
            <Switch size="sm" checked={autoGain} onCheckedChange={value => change(value, setAutoGain)} aria-label="Auto Gain" />
          </label>
          <label title={LIMITER_HELP} className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-cm-text">
            Audio Limiter
            <Switch size="sm" checked={limiter} onCheckedChange={value => change(value, setLimiter)} aria-label="Audio Limiter" />
          </label>
        </div>
        {status && <p role="status" className="text-[11px] leading-snug text-cm-muted">{status}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-cm-text">Auto Gain</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">{AUTO_GAIN_HELP}</span>
        </span>
        <Switch size="sm" className="mt-0.5" checked={autoGain} onCheckedChange={value => change(value, setAutoGain)} aria-label="Auto Gain" />
      </label>
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-cm-text">Audio Limiter</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">{LIMITER_HELP}</span>
        </span>
        <Switch size="sm" className="mt-0.5" checked={limiter} onCheckedChange={value => change(value, setLimiter)} aria-label="Audio Limiter" />
      </label>
      {MAXIMIZER_BUILT && <MaximizerControls />}
      {status && <p role="status" className="text-[11px] leading-relaxed text-cm-muted">{status}</p>}
      <p className="text-[10px] leading-relaxed text-cm-faint">Μόνο για ακρόαση · τα αρχεία και τα tags δεν αλλάζουν.</p>
    </div>
  );
}
