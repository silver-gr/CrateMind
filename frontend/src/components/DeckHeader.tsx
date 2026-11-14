import type { MutableRefObject, RefObject } from "react";
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
 * One deck's info block in the two-deck dock, on the outer side of its pads: artwork, title, artist and the remaining time, then a small
 * overview for seeking, with the played part dimmed. BPM and key stay beside the transport. Deck B is mirrored: artwork on the outer
 * (right) edge with the title against it, the time on the inner side. The block takes the dock's spare width up to a cap; when it gets narrow the artwork goes first.
 */
export function DeckHeader({ deck, mirrored = false, playing = false, track, time, duration, progress, drawRef, playheadRef, canSeek, onSeek, cues = [], cueSlots, className }: {
  deck: "A" | "B";
  /** Deck B: artwork on the right (outer) edge. */
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
  className?: string;
}) {
  const label = track.title || track.file_name;
  const seekDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const seekReady = canSeek && seekDuration > 0;
  const left = Number.isFinite(duration) && duration > 0 ? duration - time : Infinity;
  return (
    <div data-deck-info={deck} className={cn("@container/deckinfo flex min-w-[140px] max-w-[360px] flex-[1_1_0] flex-col justify-center gap-2", className)}>
      <div className={cn("flex min-w-0 items-center gap-3", mirrored && "flex-row-reverse")}>
        <Artwork seed={track.id} trackId={track.id} className={cn("size-[52px] shrink-0 rounded-[10px] object-cover outline outline-1 -outline-offset-1 outline-cm-contrast/10 transition-shadow duration-200 @max-[260px]/deckinfo:hidden",
          playing && "shadow-[0_0_0_2px_color-mix(in_oklch,var(--deck)_70%,transparent),0_0_14px_color-mix(in_oklch,var(--deck)_40%,transparent)]")} />
        <div className={cn("min-w-0 flex-1", mirrored && "text-right")}>
          <div className="truncate text-sm font-semibold tracking-[-0.01em] text-cm-text" title={label}>{label}</div>
          <div className="truncate text-[11px] text-cm-muted">{track.artist}</div>
        </div>
        {/* A static colour change at 30 s left, no blinking. */}
        <span role="group" aria-label="Υπόλοιπο χρόνου" className={cn("shrink-0 font-mono text-xl font-bold leading-none tracking-[-0.02em] tabular-nums", left <= 30 ? "text-cm-rose" : "text-cm-text")}>
          {remaining(duration, time)}
        </span>
      </div>
      <div data-player-waveform className="relative h-8 rounded-[5px] focus-within:ring-1 focus-within:ring-cm-cyan/70">
        <div className="absolute inset-0 overflow-hidden rounded-[5px] bg-cm-contrast/6">
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
    </div>
  );
}
