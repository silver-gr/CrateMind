import type { MutableRefObject, RefObject } from "react";
import { bpmColor } from "../lib/bpmColor";
import { keyColor, formatKey } from "../lib/camelot";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform } from "./ui/TrackWaveform";
import type { Track } from "../lib/types";

function remaining(duration: number, time: number): string {
  if (!isFinite(duration) || duration <= 0) return "-0:00";
  const left = Math.max(0, Math.round(duration - time));
  return `-${Math.floor(left / 60)}:${(left % 60).toString().padStart(2, "0")}`;
}

/** One deck's header row in the panel: artwork, title/artist, BPM, big remaining time, key and the overview strip. */
export function DeckHeader({ deck, track, bpm, bpmText, keyFormat, time, duration, progress, drawRef, playheadRef }: {
  deck: "A" | "B";
  track: Track;
  bpm: number | null | undefined;
  bpmText: string;
  keyFormat: "camelot" | "musical" | "both";
  time: number;
  duration: number;
  progress: number;
  drawRef: MutableRefObject<((progress: number) => void) | null>;
  playheadRef: RefObject<HTMLDivElement | null>;
}) {
  const label = track.title || track.file_name;
  return (
    <div className="flex h-full min-w-0 items-center gap-3 px-3">
      <span className="font-mono text-[10px] font-semibold text-cm-cyan">{deck}</span>
      <Artwork seed={track.id} trackId={track.id} className="size-9 shrink-0 rounded-md object-cover" />
      <div className="min-w-0 flex-1 basis-0">
        <div className="truncate text-xs font-semibold text-cm-text" title={label}>{label}</div>
        <div className="truncate text-[10px] text-cm-muted">{track.artist}</div>
      </div>
      <span style={{ color: bpmColor(bpm) }} className="shrink-0 font-mono text-xs font-medium tabular-nums">{bpmText}</span>
      <span style={{ color: keyColor(track.key_text, track.key_analyzed) }} className="shrink-0 font-mono text-xs font-medium">
        {formatKey(track.key_text, track.key_analyzed, keyFormat)}
      </span>
      <div role="group" aria-label="Υπόλοιπο χρόνου" className="shrink-0 font-mono text-xl font-semibold tabular-nums text-cm-text">
        {remaining(duration, time)}
      </div>
      <div data-player-waveform className="relative h-8 min-w-24 flex-[1_1_0] basis-0">
        <TrackWaveform trackId={track.id} sourceRevision={track.modified_time} progress={progress} drawRef={drawRef} className="absolute inset-0" />
        <div ref={playheadRef} className="pointer-events-none absolute inset-y-0 left-0 z-10 w-full" style={{ transform: `translateX(${progress * 100}%)` }}>
          <div className="h-full w-0.5 bg-cm-cyan" />
        </div>
      </div>
    </div>
  );
}
