import type { MutableRefObject, ReactNode, RefObject } from "react";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform } from "./ui/TrackWaveform";
import { CueMarkers } from "./PlayerCues";
import type { Track, TrackCue } from "../lib/types";
import type { CuePadSlots } from "../lib/cuePads";
import { cn } from "../lib/cn";

function remaining(duration: number, time: number): string {
  if (!isFinite(duration) || duration <= 0) return "-0:00";
  const left = Math.max(0, Math.round(duration - time));
  return `-${Math.floor(left / 60)}:${(left % 60).toString().padStart(2, "0")}`;
}

/**
 * One deck's two inner columns in the two-deck dock, between its pads (outer edge) and its pitch fader (beside the mixer).
 * Waveform column: the remaining time and the transport (`transport`: play, Sync) above a small overview for seeking with
 * the played part dimmed, and the tempo (`tempo`: BPM, key) below it. Cover column, next to the fader: a large artwork
 * with the title (sliding when it is too long) and artist under it. Transport and tempo sit on the cover's side. Both
 * columns centre their content vertically. Deck B is mirrored. A narrow deck drops the cover column and shows the title above the time instead.
 */
export function DeckHeader({ deck, mirrored = false, playing = false, track, time, duration, progress, drawRef, playheadRef, canSeek, onSeek, cues = [], cueSlots, coverSize, transport, tempo }: {
  deck: "A" | "B";
  /** Deck B: the cover column on the left of the waveform column, and each row reversed. */
  mirrored?: boolean;
  /** Lights the artwork ring in the deck colour. */
  playing?: boolean;
  track: Track;
  time: number;
  duration: number;
  progress: number;
  drawRef: MutableRefObject<((progress: number) => void) | null>;
  playheadRef: RefObject<HTMLDivElement | null>;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
  cues?: TrackCue[];
  cueSlots?: CuePadSlots;
  /** The artwork's largest side in px, set by the dock's height; a narrow deck shrinks it further. */
  coverSize: number;
  /** Play and Sync, in reading order. */
  transport?: ReactNode;
  /** BPM and key. */
  tempo?: ReactNode;
}) {
  const label = track.title || track.file_name;
  const seekDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const seekReady = canSeek && seekDuration > 0;
  const left = Number.isFinite(duration) && duration > 0 ? duration - time : Infinity;
  return (
    <>
    <div data-deck-info={deck} className={cn("@container/deckinfo flex h-full min-h-0 min-w-[150px] flex-[1_1_0] flex-col justify-center gap-2", mirrored ? "order-3" : "order-2")}>
      <div className="hidden min-w-0 shrink-0 truncate text-xs font-semibold leading-none text-cm-text @max-[540px]/player:block" title={label}>{label}</div>
      <div className={cn("flex h-10 min-w-0 shrink-0 items-center gap-2 @max-[215px]/deckinfo:gap-1.5", mirrored && "flex-row-reverse")}>
        {/* A static colour change at 30 s left, no blinking. */}
        <span role="group" aria-label="Υπόλοιπο χρόνου" className={cn("shrink-0 font-mono text-xl font-bold leading-none tracking-[-0.02em] tabular-nums @min-[340px]/deckinfo:text-2xl", left <= 30 ? "text-cm-rose" : "text-cm-text")}>
          {remaining(duration, time)}
        </span>
        <span className="min-w-0 flex-1" />
        {transport}
      </div>
      <div data-player-waveform className="relative max-h-28 min-h-5 flex-1 rounded-md focus-within:ring-1 focus-within:ring-cm-cyan/70">
        <div className="absolute inset-0 overflow-hidden rounded-md bg-cm-contrast/6">
          <TrackWaveform spectral trackId={track.id} sourceRevision={track.modified_time} progress={progress} drawRef={drawRef} className="absolute inset-0" />
          {/* The host rAF moves this element; the played part is dimmed by its child, so the dim costs no JS. */}
          <div ref={playheadRef} className="pointer-events-none absolute inset-0 z-10 will-change-transform" style={{ transform: `translateX(${progress * 100}%)` }}>
            <div aria-hidden className="absolute inset-y-0 right-full w-full bg-cm-bg/55" />
            <div className="absolute inset-y-0 -left-px w-0.5 bg-[var(--cm-playhead)]" />
          </div>
        </div>
        <CueMarkers compact cues={cues} slots={cueSlots} duration={seekDuration} canSeek={seekReady}
          onSeek={positionMs => onSeek(positionMs / 1000)} />
        <input data-playback-shortcuts type="range" min={0} max={seekDuration} step={0.1}
          value={Number.isFinite(time) ? Math.max(0, Math.min(seekDuration, time)) : 0}
          disabled={!seekReady}
          onChange={event => { if (seekReady) onSeek(Number(event.target.value)); }}
          onPointerDown={event => event.stopPropagation()}
          className="cm-overview-seek absolute inset-0 z-20 h-full w-full cursor-pointer touch-none opacity-0 disabled:cursor-default"
          aria-label={`Μετακίνηση στο track, Deck ${deck}`}
          title="Κλικ ή σύρσιμο για μετακίνηση" />
      </div>
      {tempo && <div className={cn("flex h-8 min-w-0 shrink-0 items-center", mirrored ? "justify-start" : "justify-end")}>{tempo}</div>}
    </div>
    {/* Sized against the deck's width too: on a narrow deck the cover gives way before the waveform does. */}
    <div data-deck-cover={deck} style={{ width: `clamp(64px, 20cqw - 36px, ${coverSize}px)` }} className={cn("flex h-full min-h-0 shrink-0 flex-col justify-center gap-2 overflow-hidden @max-[540px]/player:hidden", mirrored ? "order-2" : "order-3")}>
      <Artwork seed={track.id} trackId={track.id} className={cn("aspect-square w-full shrink-0 rounded-xl object-cover outline outline-1 -outline-offset-1 outline-cm-contrast/10 transition-shadow duration-200",
        playing && "shadow-[0_0_0_2px_color-mix(in_oklch,var(--deck)_70%,transparent),0_0_14px_color-mix(in_oklch,var(--deck)_40%,transparent)]")} />
      <div className="min-w-0">
        <div className="@container overflow-hidden text-sm font-semibold leading-[1.3] tracking-[-0.01em] text-cm-text" title={label}><span className="cm-marquee">{label}</span></div>
        <div className="mt-0.5 truncate text-xs text-cm-muted" title={track.artist ?? undefined}>{track.artist}</div>
      </div>
    </div>
    </>
  );
}
