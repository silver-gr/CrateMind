import { toast } from "sonner";
import { usePref } from "../lib/prefs";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { CEILING_RANGE, TARGET_RANGE, useMaximizerMeters } from "../lib/useMaximizer";
import type { MaximizerMeters } from "../lib/audio/maximizer";
import { Slider } from "./ui/slider";
import { Switch } from "./ui/switch";

/** The bar's full width, in dB of gain reduction. */
const GR_SPAN_DB = 12;
/** Limiter plus brickwall gain reduction, in dB (≥ 0). */
const reductionDb = (meters: MaximizerMeters | null) => meters ? Math.max(0, -(meters.limiterDb + meters.brickwallDb)) : 0;

/** Thin gain-reduction bar, growing from the right. A leaf: only it re-renders with the ~30 Hz meters. */
export function MaximizerReductionBar({ className = "" }: { className?: string }) {
  const scale = Math.min(1, reductionDb(useMaximizerMeters()) / GR_SPAN_DB);
  return (
    <span aria-hidden className={`relative block h-1 overflow-hidden rounded-full bg-cm-track ${className}`}>
      <span className="absolute inset-0 origin-right bg-cm-amber transition-transform duration-150 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${scale.toFixed(3)})` }} />
    </span>
  );
}

function MeterReadout() {
  const meters = useMaximizerMeters();
  const loudness = meters && meters.lufsOut > -69.9 ? `${meters.lufsOut.toFixed(1)} LUFS` : "—";
  return (
    <div className="space-y-1.5 text-[11px] text-cm-muted">
      <div className="flex items-baseline justify-between gap-2">
        <span>Μείωση στάθμης</span>
        <span className="font-mono tabular-nums text-cm-text">{meters ? `${reductionDb(meters).toFixed(1)} dB` : "—"}</span>
      </div>
      <MaximizerReductionBar />
      <div className="flex items-baseline justify-between gap-2">
        <span>Ένταση εξόδου</span>
        <span className="font-mono tabular-nums text-cm-text">{loudness}</span>
      </div>
    </div>
  );
}

function LevelSlider({ label, value, text, range, step, onChange }: {
  label: string; value: number; text: string; range: { min: number; max: number }; step: number; onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-cm-muted">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-cm-text">{text}</span>
      </div>
      <Slider className="mt-2" min={range.min} max={range.max} step={step} value={[value]}
        onValueChange={([next]) => onChange(next)} aria-label={label} aria-valuetext={text} />
    </div>
  );
}

/** The built-in Maximizer on the master bus: switch, target, ceiling and its meters. */
export function MaximizerControls() {
  const [on, setOn] = usePref("maximizer");
  const [targetDb, setTargetDb] = usePref("maximizerTargetDb");
  const [ceilingDb, setCeilingDb] = usePref("maximizerCeilingDb");
  function toggle(value: boolean) {
    // Unlock inside the click itself; the controller acts once the context runs.
    if (value) void unlockPlaybackAudio().catch(() => toast.error("Πάτησε αναπαραγωγή για ενεργοποίηση της επεξεργασίας ήχου."));
    setOn(value);
  }
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-cm-text">Maximizer</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">Σταθερή ένταση και όριο κορυφών στη συνολική έξοδο όλων των decks.</span>
        </span>
        <Switch size="sm" className="mt-0.5" checked={on} onCheckedChange={toggle} aria-label="Maximizer" />
      </label>
      <LevelSlider label="Στόχος έντασης" value={targetDb} text={`${targetDb.toFixed(0)} LUFS`} range={TARGET_RANGE} step={1} onChange={setTargetDb} />
      <LevelSlider label="Οροφή" value={ceilingDb} text={`${ceilingDb.toFixed(1)} dB`} range={CEILING_RANGE} step={0.1} onChange={setCeilingDb} />
      <MeterReadout />
    </div>
  );
}
