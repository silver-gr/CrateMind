import MiniPlayer, { type MiniPlayerProps } from "./MiniPlayer";
import { ResizeHandle } from "./ui/ResizeHandle";
import { Knob } from "./ui/Knob";
import { Slider } from "./ui/slider";
import { VuMeter } from "./ui/VuMeter";
import { eqDb, setCrossfader, setDeckEq, setDeckFilter, setDeckTrim, setMixerVolume, trimDb, useDeckFx, useMixer } from "../lib/mixer";
import { useTwoDeck, type DeckId } from "../lib/player";

/** Slot, fill and cap come from .cm-fader (index.css); ticks are a repeating gradient drawn behind the track. */
const faderClass = "cm-fader cursor-pointer";
const vTicks = "bg-[repeating-linear-gradient(to_bottom,var(--cm-border-hi)_0_1px,transparent_1px_10%)] bg-[length:100%_100%] bg-no-repeat";
const hTicks = "bg-[repeating-linear-gradient(to_right,var(--cm-border-hi)_0_1px,transparent_1px_10%)] bg-no-repeat";

function VolumeFader({ deck, value }: { deck: DeckId; value: number }) {
  return (
    <div className={`flex min-h-0 w-6 flex-1 justify-center py-1 ${vTicks}`}>
      <Slider orientation="vertical" min={0} max={1} step={0.01} value={[value]}
        onValueChange={([v]) => setMixerVolume(deck, v)}
        className={`data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-0 ${faderClass}`}
        aria-label={`Ένταση Deck ${deck}`} aria-valuetext={`${Math.round(value * 100)}%`} />
    </div>
  );
}

const eqText = (v: number) => `${eqDb(v) > 0 ? "+" : ""}${eqDb(v).toFixed(1)} dB`;
const trimText = (v: number) => `${trimDb(v) > 0 ? "+" : ""}${trimDb(v).toFixed(1)} dB`;
const filterText = (v: number) => Math.abs(v) < 0.03 ? "off" : `${v < 0 ? "LP" : "HP"} ${Math.round(Math.abs(v) * 100)}%`;

/**
 * One deck's half of the strip, outer edge to centre: EQ+filter stack | trim + VU | volume fader.
 * It is a size container: knobs scale with its height (--cm-knob, 16..32px) so nothing clips in a short dock.
 */
function DeckHalf({ deck, volume, mirrored }: { deck: DeckId; volume: number; mirrored?: boolean }) {
  const fx = useDeckFx(deck);
  const label = "[@container(max-height:110px)]:hidden";
  return (
    <div role="group" aria-label={`Mixer Deck ${deck}`}
      className={`flex min-h-0 min-w-0 flex-1 gap-1.5 overflow-hidden rounded-md border border-cm-line/15 bg-cm-panel/40 p-1 [container-type:size] dark:border-white/8 ${mirrored ? "flex-row-reverse" : ""}`}>
      <div className="flex flex-col justify-between [--cm-knob:clamp(16px,calc((100cqh-4px)/4-11px),32px)]">
        <Knob label="HIGH" value={fx.eq.hi} valueText={eqText} labelClassName={label} onChange={v => setDeckEq(deck, "hi", v)} />
        <Knob label="MID" value={fx.eq.mid} valueText={eqText} labelClassName={label} onChange={v => setDeckEq(deck, "mid", v)} />
        <Knob label="LOW" value={fx.eq.lo} valueText={eqText} labelClassName={label} onChange={v => setDeckEq(deck, "lo", v)} />
        <Knob label="FILTER" value={fx.filter} valueText={filterText} labelClassName={label} onChange={v => setDeckFilter(deck, v)} />
      </div>
      {/* Middle column: the trim knob above the VU. */}
      <div className="flex min-h-0 flex-col items-center gap-1 py-1 [--cm-knob:clamp(16px,calc((100cqh-4px)/4-11px),32px)]">
        <Knob label="TRIM" value={fx.trim} valueText={trimText} labelClassName={label} onChange={v => setDeckTrim(deck, v)} />
        <VuMeter deck={deck} className="min-h-0 flex-1" />
      </div>
      <div className="flex min-h-0 flex-col items-center">
        <VolumeFader deck={deck} value={volume} />
      </div>
    </div>
  );
}

function MixerStrip() {
  const mixer = useMixer();
  return (
    // No side borders: the decks draw their own inner edges and round off beside the mixer.
    <div className="cm-mixer-enter flex w-56 shrink-0 flex-col justify-center gap-1.5 px-1.5 py-2">
      <div className="flex min-h-0 flex-1 gap-px">
        <DeckHalf deck="A" volume={mixer.volume.A} />
        <div className="w-px self-stretch bg-cm-border-hi" aria-hidden />
        <DeckHalf deck="B" volume={mixer.volume.B} mirrored />
      </div>
      <div className="flex w-full items-center gap-2 text-[10px] font-semibold text-cm-muted">
        <span>A</span>
        <div className={`flex-1 px-1 ${hTicks}`}>
          <Slider min={-1} max={1} step={0.01} value={[mixer.crossfader]}
            onValueChange={([v]) => setCrossfader(v)} onDoubleClick={() => setCrossfader(0)}
            className={`${faderClass} cm-fader-bipolar`} aria-label="Crossfader" aria-valuetext={mixer.crossfader.toFixed(2)} />
        </div>
        <span>B</span>
      </div>
    </div>
  );
}

/**
 * The global dock. Deck A's MiniPlayer keeps the same tree position in both modes
 * (remounting would restart its audio); two-deck mode only adds the mixer and Deck B.
 */
export default function DeckDock({ height, isDragging, handleProps, collapsed = false }: Pick<MiniPlayerProps, "height" | "isDragging" | "handleProps"> & { collapsed?: boolean }) {
  const twoDeck = useTwoDeck();
  return (
    // Collapsed: hidden, never unmounted, so the decks keep their media and keep playing.
    <div className={collapsed ? "hidden" : "relative flex h-full w-full"}>
      {twoDeck && (
        <ResizeHandle orientation="horizontal" isDragging={isDragging} ariaLabel="Αλλαγή ύψους player"
          className="absolute -top-1.5 inset-x-0 z-40" {...handleProps} />
      )}
      <div className="min-w-0 flex-1">
        <MiniPlayer deck="A" height={height} isDragging={isDragging} handleProps={twoDeck ? undefined : handleProps} />
      </div>
      {twoDeck && <MixerStrip />}
      {twoDeck && (
        <div className="cm-deck-enter min-w-0 flex-1">
          <MiniPlayer deck="B" mirrored height={height} />
        </div>
      )}
    </div>
  );
}
