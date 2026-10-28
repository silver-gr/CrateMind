import { toast } from "sonner";
import { usePref } from "../lib/prefs";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { Switch } from "./ui/switch";

export function PlaybackOptions({ status }: { status?: string }) {
  const [autoGain, setAutoGain] = usePref("autoGain");
  const [limiter, setLimiter] = usePref("audioLimiter");
  function change(value: boolean, setter: (value: boolean) => void) {
    // Unlock during the user's gesture; never wait for a loudness request first.
    if (value) void unlockPlaybackAudio().catch(() => toast.error("Πάτησε αναπαραγωγή για ενεργοποίηση της επεξεργασίας ήχου."));
    setter(value);
  }
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-cm-text">Auto Gain</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">Εξισορροπεί την ένταση μεταξύ tracks. Η πρώτη μέτρηση αποθηκεύεται για την επόμενη ακρόαση.</span>
        </span>
        <Switch size="sm" className="mt-0.5" checked={autoGain} onCheckedChange={value => change(value, setAutoGain)} aria-label="Auto Gain" />
      </label>
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-cm-text">Audio Limiter</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">Περιορίζει τις κορυφές της έντασης κατά την αναπαραγωγή.</span>
        </span>
        <Switch size="sm" className="mt-0.5" checked={limiter} onCheckedChange={value => change(value, setLimiter)} aria-label="Audio Limiter" />
      </label>
      {status && <p role="status" className="text-[11px] leading-relaxed text-cm-muted">{status}</p>}
      <p className="text-[10px] leading-relaxed text-cm-faint">Μόνο για ακρόαση · τα αρχεία και τα tags δεν αλλάζουν.</p>
    </div>
  );
}
