import type { MutableRefObject, ReactNode, RefObject } from "react";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform } from "./ui/TrackWaveform";
import { CueMarkers } from "./PlayerCues";
import { StructureMarkers } from "./StructureMarkers";
import { FxRackRow } from "./FxRackRow";
import { OverviewHover } from "./OverviewHover";
import { ActionContextMenu } from "./ui/context-menu";
import type { BeatGrid } from "../lib/beatGrid";
import { lastSeconds, timeLeftText } from "../lib/deckFacts";
import type { Track, TrackCue } from "../lib/types";
import type { CuePadSlots } from "../lib/cuePads";
import type { MenuSource } from "../lib/menus/entries";
import { pickDeck } from "../lib/menus/deckMenu";
import { cn } from "../lib/cn";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;

function elapsed(time: number): string {
  return clock(Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0);
}

/**
 * A deck's overview in the facts row under the waveforms: the whole track, wide and short, for seeking. The played part is
 * dimmed, the pad-cue flags hang from the top edge and the bass ticks stand on the bottom edge. The canvas ignores the
 * pointer; the invisible range input on top does the seeking, and the hover («+16 bars») listens on the wrapper.
 */
export function DeckOverview({ deck, track, time, duration, progress, drawRef, playheadRef, canSeek, onSeek, onCueSeek = onSeek, cues = [], cueSlots, grid = null, className }: {
  deck: "A" | "B";
  track: Track;
  time: number;
  duration: number;
  progress: number;
  drawRef: MutableRefObject<((progress: number) => void) | null>;
  playheadRef: RefObject<HTMLDivElement | null>;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
  /** A click on a cue marker (a jump to that cue); `onSeek` when omitted. */
  onCueSeek?: (seconds: number) => void;
  cues?: TrackCue[];
  cueSlots?: CuePadSlots;
  /** The deck's beat grid, for the seek hover («+16 bars»); none: it shows the time. */
  grid?: BeatGrid | null;
  className?: string;
}) {
  const seekDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const seekReady = canSeek && seekDuration > 0;
  return (
    // The cue flags' hit area is cut to the top 12 px, so most of this short strip still seeks under them.
    <div data-player-waveform className={cn("relative rounded-[4px] focus-within:ring-1 focus-within:ring-cm-cyan/70 [&_[data-player-cues]]:h-3", className)}>
      <div className="absolute inset-0 overflow-hidden rounded-[4px] bg-cm-contrast/6">
        <TrackWaveform spectral trackId={track.id} sourceRevision={track.modified_time} progress={progress} drawRef={drawRef} className="absolute inset-0" />
        {/* The host rAF moves this element; the played part is dimmed by its child, so the dim costs no JS. */}
        <div ref={playheadRef} className="pointer-events-none absolute inset-0 z-10 will-change-transform" style={{ transform: `translateX(${progress * 100}%)` }}>
          <div aria-hidden className="absolute inset-y-0 right-full w-full bg-cm-bg/55" />
          <div className="absolute inset-y-0 -left-px w-0.5 bg-[var(--cm-playhead)]" />
        </div>
      </div>
      <CueMarkers compact cues={cues} slots={cueSlots} duration={seekDuration} canSeek={seekReady}
        onSeek={positionMs => onCueSeek(positionMs / 1000)} />
      <StructureMarkers trackId={track.id} duration={seekDuration} canSeek={seekReady} onSeek={onSeek} />
      <input data-playback-shortcuts type="range" min={0} max={seekDuration} step={0.1}
        value={Number.isFinite(time) ? Math.max(0, Math.min(seekDuration, time)) : 0}
        disabled={!seekReady}
        onChange={event => { if (seekReady) onSeek(Number(event.target.value)); }}
        onPointerDown={event => event.stopPropagation()}
        onMouseDown={event => { if (event.ctrlKey) event.preventDefault(); }}
        className="cm-overview-seek absolute inset-0 z-20 h-full w-full cursor-pointer touch-none opacity-0 disabled:cursor-default"
        aria-label={`Μετακίνηση στο track, Deck ${deck}`}
        title="Κλικ ή σύρσιμο για μετακίνηση" />
      <OverviewHover grid={grid} time={time} duration={seekDuration} trackId={track.id} canSeek={seekReady} />
    </div>
  );
}

/**
 * One deck's two inner columns in the two-deck dock, between its pads (outer edge) and its pitch fader (beside the mixer).
 * Info column, 248 px (it shrinks to 150 px only on a narrow deck): the time left, large, with the elapsed time and the deck's
 * `status` (an error or the loading sign) under it, and the transport (`transport`: play, Sync) on the cover's side; then the FX
 * picker on its own line and the FX button, BEATS and WET on the next. BPM and key are in the facts row under the waveforms, the
 * octave fix («×½» / «×2») in the deck menu's «BPM». The overview lives in the facts row too (`DeckOverview`). Cover column,
 * next to the fader: a large artwork with the title (sliding when it is too long) and artist under it. Both columns centre their
 * content vertically. Deck B is mirrored. A narrow deck drops the cover column and shows the title above the time instead. A
 * right-click on either column opens the deck's `menu`. `rating` (the fast rating strip, null with its switch off) sits under the
 * FX rows: its meters keep at least the 58 px the status menu (at most 84 px) leaves in a 150 px column, and the column has room
 * for the 28 px row down to the lowest dock.
 */
const DECK_RULE = {
  left: "relative before:pointer-events-none before:absolute before:inset-y-4 before:-left-1.5 before:z-10 before:w-px before:bg-linear-to-b before:from-transparent before:via-cm-contrast/16 before:to-transparent",
  right: "relative before:pointer-events-none before:absolute before:inset-y-4 before:-right-1.5 before:z-10 before:w-px before:bg-linear-to-b before:from-transparent before:via-cm-contrast/16 before:to-transparent",
};
/**
 * A hairline between two of the deck's columns: one pixel in the middle of the 12 px gap on the given side, fading out toward
 * the dock's top and bottom. It takes no room, and it is drawn over the cover's playing glow, which spills into the same gap.
 */
export const deckRule = (side: "left" | "right") => DECK_RULE[side];

export function DeckHeader({ deck, mirrored = false, playing = false, track, time, duration, coverSize, transport, status, rating, menu }: {
  deck: "A" | "B";
  /** Deck B: the cover column on the left of the info column, and each row reversed. */
  mirrored?: boolean;
  /** Lights the artwork ring in the deck colour. */
  playing?: boolean;
  track: Track;
  time: number;
  duration: number;
  /** The artwork's largest side in px, set by the dock's height; a narrow deck shrinks it further. */
  coverSize: number;
  /** Play and Sync, in reading order. */
  transport?: ReactNode;
  /** The deck's error or loading sign, beside the elapsed time. */
  status?: ReactNode;
  /** The fast rating strip (`DeckRatingStrip`). */
  rating?: ReactNode;
  /** The deck's right-click menu (`useDeckMenu`). */
  menu?: MenuSource<true>;
}) {
  const label = track.title || track.file_name;
  return (
    <>
    <ActionContextMenu pick={pickDeck} menu={menu}>
    <div data-deck-info={deck} className={cn("@container/deckinfo flex h-full min-h-0 min-w-[150px] flex-[0_1_248px] flex-col justify-center gap-2", deckRule(mirrored ? "left" : "right"), mirrored ? "order-3" : "order-2")}>
      <div className="hidden min-w-0 shrink-0 truncate text-xs font-semibold leading-none text-cm-text @max-[540px]/player:block" title={label}>{label}</div>
      {/* The number read under pressure leads: a static colour change at 30 s left, no blinking. The elapsed time sits under it. */}
      <div className={cn("flex h-10 min-w-0 shrink-0 items-center gap-2 @max-[215px]/deckinfo:gap-1.5", mirrored && "flex-row-reverse")}>
        <div className={cn("flex shrink-0 flex-col gap-0.5", mirrored ? "items-end" : "items-start")}>
          <span role="group" aria-label="Υπόλοιπο χρόνου" className={cn("font-mono text-2xl font-bold leading-none tracking-[-0.02em] tabular-nums", lastSeconds(duration, time) ? "text-cm-rose" : "text-cm-text")}>
            {timeLeftText(duration, time)}
          </span>
          <span className={cn("flex h-3.5 items-center gap-1.5", mirrored && "flex-row-reverse")}>
            <span role="group" aria-label="Χρόνος αναπαραγωγής" className="font-mono text-sm font-semibold leading-none tracking-[-0.02em] tabular-nums text-cm-muted">
              {elapsed(time)}
            </span>
            {status}
          </span>
        </div>
        <span className="min-w-0 flex-1" />
        {transport}
      </div>
      <FxRackRow deck={deck} mirrored={mirrored} track={track} />
      {rating}
    </div>
    </ActionContextMenu>
    {/* Sized against the deck's width too: on a narrow deck the cover gives way before the info column does. Not clipped, so the
        playing ring and glow spill past the cover's edges; the title and artist clip and truncate on their own. */}
    <ActionContextMenu pick={pickDeck} menu={menu}>
    <div data-deck-cover={deck} style={{ width: `clamp(64px, 20cqw - 36px, ${coverSize}px)` }} className={cn("flex h-full min-h-0 shrink-0 flex-col justify-center gap-2 @max-[540px]/player:hidden", mirrored ? "order-2" : "order-3")}>
      <Artwork seed={track.id} trackId={track.id} className={cn("aspect-square w-full shrink-0 rounded-xl object-cover outline outline-1 -outline-offset-1 outline-cm-contrast/10 transition-shadow duration-200",
        playing && "shadow-[0_0_0_2px_color-mix(in_oklch,var(--deck)_70%,transparent),0_0_14px_color-mix(in_oklch,var(--deck)_40%,transparent)]")} />
      <div className="min-w-0">
        <div className="@container overflow-hidden text-sm font-semibold leading-[1.3] tracking-[-0.01em] text-cm-text" title={label}><span className="cm-marquee">{label}</span></div>
        <div className="mt-0.5 truncate text-xs text-cm-muted" title={track.artist ?? undefined}>{track.artist}</div>
      </div>
    </div>
    </ActionContextMenu>
    </>
  );
}
