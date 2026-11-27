import type { CSSProperties } from "react";
import MiniPlayer, { type MiniPlayerProps } from "./MiniPlayer";
import { ResizeHandle } from "./ui/ResizeHandle";
import { Knob } from "./ui/Knob";
import { KNOB_ID } from "../lib/knobFlash";
import { Hint } from "./ui/tooltip";
import { Slider } from "./ui/slider";
import { VuMeter } from "./ui/VuMeter";
import { usePref } from "../lib/prefs";
import { eqDb, setCrossfader, setCueGain, setCueMix, setDeckEq, setDeckFilter, setDeckTrim, setMixerVolume, trimDb, useDeckFx, useMixer } from "../lib/mixer";
import { useTwoDeck, type DeckId } from "../lib/player";

/** Slot, fill and cap come from .cm-fader (styles/deck.css); ticks are a repeating gradient drawn behind the track. */
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
// Fully left the LOW kill zone has removed the bass, so the dB figure would undersell it.
const lowText = (v: number) => (v <= -1 ? "Κομμένο" : eqText(v));
const trimText = (v: number) => `${trimDb(v) > 0 ? "+" : ""}${trimDb(v).toFixed(1)} dB`;
const filterText = (v: number) => Math.abs(v) < 0.03 ? "Κλειστό" : `${v < 0 ? "LP" : "HP"} ${Math.round(Math.abs(v) * 100)}%`;
// The headphone knobs: the store holds 0..1, the knob -1..1.
const cueGainText = (v: number) => `${Math.round((v + 1) * 50)}%`;
const cueMixText = (v: number) => `${Math.round((1 - v) * 50)}% cue · ${Math.round((v + 1) * 50)}% master`;
const CUE_HINT = "Δεν επηρεάζει ακόμη τον ήχο: δεν υπάρχει έξοδος ακουστικών.";

// --deck colours a deck's knob arcs and fader cap (A cyan, B lime green); static, the hardware never animates.
const deckColour = (deck: DeckId) => ({ "--deck": deck === "A" ? "var(--cm-deck-a)" : "var(--cm-deck-b)" }) as CSSProperties;

/**
 * One deck's knob column at the mixer's outer edge, top to bottom TRIM, HIGH, MID, LOW, FILTER, over the mixer's full height.
 * It is a size container with no padding: the knobs follow its height (--cm-knob: five rows of knob and name; each name sits
 * 3 px up in the knob's empty bottom and 1 px into the next row's empty top, so a row is the knob plus 9 px: 30.6 px knobs at the
 * 208 px dock, at most 36; 2 px under the last name). The column is 46 px, so «FILTER» fits; a wider pill («LP 100») passes over its edge.
 */
function KnobColumn({ deck, area }: { deck: DeckId; area: string }) {
  const fx = useDeckFx(deck);
  const label = "-mt-[3px] -mb-px [@container(max-height:130px)]:hidden";
  return (
    <div role="group" aria-label={`Mixer Deck ${deck}`} style={deckColour(deck)}
      className={`${area} flex min-h-0 w-[46px] flex-col items-center justify-between rounded-md bg-cm-panel/40 pb-0.5 ring-1 ring-inset ring-cm-line/15 [container-type:size] [--cm-knob:clamp(16px,calc((100cqh-45px)/5),36px)] dark:ring-white/8`}>
      <Knob label="TRIM" controlId={KNOB_ID.trim(deck)} value={fx.trim} valueText={trimText} labelClassName={label} onChange={v => setDeckTrim(deck, v)} />
      <Knob label="HIGH" controlId={KNOB_ID.eq(deck, "hi")} value={fx.eq.hi} valueText={eqText} labelClassName={label} onChange={v => setDeckEq(deck, "hi", v)} />
      <Knob label="MID" controlId={KNOB_ID.eq(deck, "mid")} value={fx.eq.mid} valueText={eqText} labelClassName={label} onChange={v => setDeckEq(deck, "mid", v)} />
      <Knob label="LOW" controlId={KNOB_ID.eq(deck, "lo")} value={fx.eq.lo} valueText={lowText} labelClassName={label} onChange={v => setDeckEq(deck, "lo", v)} />
      <Knob label="FILTER" controlId={KNOB_ID.filter(deck)} value={fx.filter} valueText={filterText} labelClassName={label} onChange={v => setDeckFilter(deck, v)} />
    </div>
  );
}

/** One deck's channel between the knob columns, outer edge to centre: the VU with 16 px kept under it, then the volume fader. */
function Channel({ deck, volume, mirrored }: { deck: DeckId; volume: number; mirrored?: boolean }) {
  return (
    <div style={deckColour(deck)} className={`flex min-h-0 gap-1 ${mirrored ? "flex-row-reverse" : ""}`}>
      <div className="flex min-h-0 flex-col items-center gap-1 py-1">
        <VuMeter deck={deck} className="min-h-0 flex-1" />
        {/* 16 px kept free for the headphone-cue button («Στα ακουστικά»), which comes with the headphone output; nothing is drawn until then. */}
        <span aria-hidden data-pfl-space className="h-4 w-6 shrink-0" />
      </div>
      <div className="flex min-h-0 flex-col items-center">
        <VolumeFader deck={deck} value={volume} />
      </div>
    </div>
  );
}

/** «Q»: Quantize for both decks (lib/quantize.ts), lit while on. */
function QuantizeChip() {
  const [on, setOn] = usePref("quantize");
  const label = `Quantize · ${on ? "ενεργό" : "ανενεργό"}: τα loop και τα hot cue πέφτουν πάνω στα beats, όπου το track έχει αξιόπιστο beatgrid`;
  return (
    <button type="button" aria-pressed={on} aria-label={label} title={label} onClick={() => setOn(!on)}
      className={`flex h-4 w-5 shrink-0 items-center justify-center rounded-sm border text-[9px] font-bold transition focus-visible:outline-2 focus-visible:outline-cm-cyan ${on
        ? "border-cm-cyan/50 bg-cm-cyan/10 text-cm-cyan shadow-[0_0_8px_-3px_var(--color-cm-cyan)]"
        : "border-cm-line/20 text-cm-muted hover:text-cm-text dark:border-white/10"}`}>
      Q
    </button>
  );
}

/**
 * The mixer between the decks, 250 px: a knob column per deck at its outer edges, running its full height, and between them the
 * headphone row, the two channels and a short crossfader under the channel faders (its ends are coloured per deck, no letters).
 * Its 4 px top and bottom leave the knob columns 200 px of the 208 px dock (30.6 px knobs) and the faders 133 px. The
 * master meter, «MAX» and REC live in the top bar (layout/TopBar.tsx).
 */
function MixerStrip() {
  const mixer = useMixer();
  return (
    // No side borders: the decks draw their own inner edges and round off beside the mixer.
    <div className="cm-mixer-enter relative z-10 grid w-[250px] shrink-0 grid-cols-[46px_minmax(0,1fr)_46px] grid-rows-[auto_minmax(0,1fr)_auto] gap-x-1 gap-y-1 px-1.5 py-1">
      <KnobColumn deck="A" area="[grid-area:1/1/4/2]" />
      {/* Headphone knobs, name under the knob: they follow the controller, but there is no headphone output yet, so they are dimmed. «Q» sits between them. */}
      <div className="flex items-center justify-between [grid-area:1/2] [--cm-knob:21px]">
        <Hint text={`Ένταση ακουστικών. ${CUE_HINT}`}><div className="opacity-60">
          <Knob unipolar label="CUE GAIN" controlId={KNOB_ID.cueGain} ariaLabel={`Ένταση ακουστικών (${CUE_HINT})`} value={mixer.cueGain * 2 - 1} valueText={cueGainText}
            labelClassName="-mt-[3px]" onChange={v => setCueGain((v + 1) / 2)} />
        </div></Hint>
        <QuantizeChip />
        <Hint text={`Μείξη cue και master στα ακουστικά. ${CUE_HINT}`}><div className="opacity-60">
          <Knob label="CUE MIX" controlId={KNOB_ID.cueMix} ariaLabel={`Μείξη ακουστικών (${CUE_HINT})`} value={mixer.cueMix * 2 - 1} valueText={cueMixText}
            labelClassName="-mt-[3px]" onChange={v => setCueMix((v + 1) / 2)} />
        </div></Hint>
      </div>
      <div className="flex min-h-0 justify-between [grid-area:2/2]">
        <Channel deck="A" volume={mixer.volume.A} />
        <Channel deck="B" volume={mixer.volume.B} mirrored />
      </div>
      <div className={`flex h-5 items-center px-1 [grid-area:3/2] ${hTicks}`}>
        <Slider min={-1} max={1} step={0.01} value={[mixer.crossfader]}
          onValueChange={([v]) => setCrossfader(v)} onDoubleClick={() => setCrossfader(0)}
          className={`${faderClass} cm-fader-bipolar cm-fader-xfade`} aria-label="Crossfader" aria-valuetext={mixer.crossfader.toFixed(2)} />
      </div>
      <KnobColumn deck="B" area="[grid-area:1/3/4/4]" />
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
