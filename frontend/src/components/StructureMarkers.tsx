import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/cn";
import { formatClock, mixPoints } from "../lib/trackStructure";
import { useTrackStructure } from "../lib/trackStructureStore";

/**
 * The track's mix points along a deck's mini waveform: a small tick on its bottom edge where the bass comes in (bright)
 * or stops (dim). The cue flags keep the top edge. Hover names the point and how long what starts there lasts; a click
 * moves the deck there. Nothing is drawn for a track without a measured structure.
 */
export function StructureMarkers({ trackId, duration, canSeek, onSeek }: {
  trackId: number;
  duration: number;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
}) {
  const structure = useTrackStructure(trackId);
  if (!structure || !Number.isFinite(duration) || duration <= 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {mixPoints(structure.sections).map(point => {
        const pct = Math.min(100, Math.max(0, (point.time_s / duration) * 100));
        const bassIn = point.kind === "first-bass" || point.kind === "return";
        const clock = formatClock(point.time_s);
        return (
          <Tooltip key={`${point.kind}-${point.time_s}`} delayDuration={120}>
            <TooltipTrigger asChild>
              <button type="button" data-structure-marker={point.kind} disabled={!canSeek} aria-label={`${point.label} ${clock}, ${point.detail}`}
                className="group/mark pointer-events-auto absolute bottom-0 z-30 flex h-3.5 w-3.5 -translate-x-1/2 cursor-pointer items-end justify-center outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 disabled:cursor-default"
                style={{ left: `clamp(7px, ${pct}%, calc(100% - 7px))` }}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation();
                  if (event.detail > 0) event.currentTarget.blur();   // a mouse click must not keep focus: Space stays the transport toggle
                  onSeek(point.time_s);
                }}
                onKeyDown={event => event.stopPropagation()}
                onKeyUp={event => event.stopPropagation()}>
                <span aria-hidden className={cn("h-[5px] w-[7px] transition-colors duration-150 [clip-path:polygon(50%_0,100%_100%,0_100%)] group-hover/mark:bg-cm-text group-focus-visible/mark:bg-cm-text",
                  bassIn ? "bg-cm-text/80" : "bg-cm-text/35")} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-left">
              <span className="font-medium">{point.label} · <span className="font-mono tabular-nums">{clock}</span></span>
              <span className="block text-cm-muted">{point.detail}</span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
