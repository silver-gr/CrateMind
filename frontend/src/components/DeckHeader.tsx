import type { CSSProperties, MutableRefObject, RefObject } from "react";
import { bpmColor } from "../lib/bpmColor";
import { keyColor, formatKey } from "../lib/camelot";
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
 * One deck's strip in the panel's info row (djay-style): artwork with the deck letter, title + remaining time + key, artist + BPM, and the
 * overview with the played part dimmed. Deck B is mirrored: artwork on the outer (right) edge, text still left-aligned.
 */
export function DeckHeader({ deck, mirrored = false, playing = false, track, bpm, bpmText, keyFormat, time, duration, progress, drawRef, playheadRef, canSeek, onSeek, cues = [], cueSlots }: {
  deck: "A" | "B";
  /** Deck B: artwork on the right (outer) edge. */
  mirrored?: boolean;
  /** Lights the artwork ring and the deck letter in the deck colour. */
  playing?: boolean;
  track: Track;
  bpm: number | null | undefined;
  bpmText: string;
  keyFormat: "camelot" | "musical" | "both";
  time: number;
  duration: number;
  progress: number;
  drawRef: MutableRefObject<((progress: number) => void) | null>;
  playheadRef: RefObject<HTMLDivElement | null>;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
  cues?: TrackCue[];
  cueSlots?: CuePadSlots;
}) {
  const label = track.title || track.file_name;
  const seekDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const seekReady = canSeek && seekDuration > 0;
  const left = Number.isFinite(duration) && duration > 0 ? duration - time : Infinity;
  const kc = keyColor(track.key_text, track.key_analyzed);
  return (
    <div data-deck-info={deck} className={cn("grid h-full min-w-0 items-center gap-x-3 px-3 py-1.5", mirrored ? "grid-cols-[minmax(0,1fr)_52px]" : "grid-cols-[52px_minmax(0,1fr)]")}>
      <div className={cn("relative size-[52px]", mirrored && "order-last")}>
        <Artwork seed={track.id} trackId={track.id} className={cn("size-[52px] rounded-[10px] object-cover outline outline-1 -outline-offset-1 outline-cm-contrast/10 transition-shadow duration-200",
          playing && (deck === "A"
            ? "shadow-[0_0_0_2px_color-mix(in_oklch,var(--cm-deck-a)_70%,transparent),0_0_14px_color-mix(in_oklch,var(--cm-deck-a)_40%,transparent)]"
            : "shadow-[0_0_0_2px_color-mix(in_oklch,var(--cm-deck-b)_70%,transparent),0_0_14px_color-mix(in_oklch,var(--cm-deck-b)_40%,transparent)]"))} />
        <span aria-hidden className={cn("absolute -top-1 flex size-[18px] items-center justify-center rounded-[5px] font-mono text-[10px] font-bold ring-1 ring-inset transition-colors duration-150", mirrored ? "-right-1" : "-left-1",
          deck === "A" ? "text-cm-deck-a ring-cm-deck-a/45" : "text-cm-deck-b ring-cm-deck-b/45",
          // Opaque tint: the chip sits over the artwork, which must not show through the letter.
          playing ? (deck === "A" ? "bg-[color-mix(in_oklch,var(--cm-deck-a)_20%,var(--cm-bg-2))]" : "bg-[color-mix(in_oklch,var(--cm-deck-b)_20%,var(--cm-bg-2))]") : "bg-cm-bg-2")}>{deck}</span>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex h-[22px] min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em] text-cm-text" title={label}>{label}</span>
          {/* A static colour change at 30 s left, no blinking. */}
          <span role="group" aria-label="Υπόλοιπο χρόνου" className={cn("shrink-0 font-mono text-xl font-bold leading-[22px] tracking-[-0.02em] tabular-nums", left <= 30 ? "text-cm-rose" : "text-cm-text")}>
            {remaining(duration, time)}
          </span>
          <span style={{ "--kc": kc } as CSSProperties} className="shrink-0 rounded-[4px] bg-[color-mix(in_oklch,var(--kc,var(--cm-muted))_14%,transparent)] px-1 font-mono text-[11px] font-bold leading-4 text-[var(--kc,var(--cm-muted))]">
            {formatKey(track.key_text, track.key_analyzed, keyFormat)}
          </span>
        </div>
        <div className="flex h-3.5 min-w-0 items-center gap-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-cm-muted">{track.artist}</span>
          <span style={{ color: bpmColor(bpm) }} className="shrink-0 font-mono font-medium tabular-nums">{bpmText}</span>
        </div>
        <div data-player-waveform className="relative mt-0.5 h-3.5 rounded-[3px] focus-within:ring-1 focus-within:ring-cm-cyan/70">
          <div className="absolute inset-0 overflow-hidden rounded-[3px] bg-cm-contrast/6">
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
            className="cm-overview-seek absolute inset-x-0 -top-2 z-20 h-[calc(100%+8px)] w-full cursor-pointer touch-none opacity-0 disabled:cursor-default"
            aria-label={`Μετακίνηση στο track, Deck ${deck}`}
            title="Κλικ ή σύρσιμο για μετακίνηση" />
        </div>
      </div>
    </div>
  );
}
