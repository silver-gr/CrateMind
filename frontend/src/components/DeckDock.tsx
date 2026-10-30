import MiniPlayer, { type MiniPlayerProps } from "./MiniPlayer";
import { ResizeHandle } from "./ui/ResizeHandle";
import { Slider } from "./ui/slider";
import { setCrossfader, setMixerVolume, useMixer } from "../lib/mixer";
import { useTwoDeck, type DeckId } from "../lib/player";

const faderClass =
  "cursor-pointer [&_[data-slot=slider-track]]:bg-cm-border-hi [&_[data-slot=slider-range]]:bg-cm-cyan [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-cm-cyan [&_[data-slot=slider-thumb]]:bg-cm-cyan";

function VolumeFader({ deck, value }: { deck: DeckId; value: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[10px] font-semibold text-cm-cyan">{deck}</span>
      <Slider orientation="vertical" min={0} max={1} step={0.01} value={[value]}
        onValueChange={([v]) => setMixerVolume(deck, v)}
        className={`data-[orientation=vertical]:h-20 data-[orientation=vertical]:min-h-0 ${faderClass}`}
        aria-label={`Ένταση Deck ${deck}`} aria-valuetext={`${Math.round(value * 100)}%`} />
    </div>
  );
}

function MixerStrip() {
  const mixer = useMixer();
  return (
    <div className="flex w-40 shrink-0 flex-col items-center justify-center gap-3 border-x border-cm-line/20 px-4 py-3 dark:border-white/8">
      <div className="flex justify-center gap-8">
        <VolumeFader deck="A" value={mixer.volume.A} />
        <VolumeFader deck="B" value={mixer.volume.B} />
      </div>
      <div className="flex w-full items-center gap-2 text-[10px] font-semibold text-cm-muted">
        <span>A</span>
        <Slider min={-1} max={1} step={0.01} value={[mixer.crossfader]}
          onValueChange={([v]) => setCrossfader(v)} onDoubleClick={() => setCrossfader(0)}
          className={faderClass} aria-label="Crossfader" aria-valuetext={mixer.crossfader.toFixed(2)} />
        <span>B</span>
      </div>
    </div>
  );
}

/**
 * The global dock. Deck A's MiniPlayer keeps the same tree position in both modes
 * (remounting would restart its audio); two-deck mode only adds the mixer and Deck B.
 */
export default function DeckDock({ height, isDragging, handleProps }: Pick<MiniPlayerProps, "height" | "isDragging" | "handleProps">) {
  const twoDeck = useTwoDeck();
  return (
    <div className="relative flex h-full w-full">
      {twoDeck && (
        <ResizeHandle orientation="horizontal" isDragging={isDragging} ariaLabel="Αλλαγή ύψους player"
          className="absolute -top-1.5 inset-x-0 z-40" {...handleProps} />
      )}
      <div className="min-w-0 flex-1">
        <MiniPlayer deck="A" height={height} isDragging={isDragging} handleProps={twoDeck ? undefined : handleProps} />
      </div>
      {twoDeck && <MixerStrip />}
      {twoDeck && (
        <div className="min-w-0 flex-1">
          <MiniPlayer deck="B" mirrored height={height} />
        </div>
      )}
    </div>
  );
}
