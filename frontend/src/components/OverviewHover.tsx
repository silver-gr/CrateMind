import { useEffect, useRef, useState } from "react";
import type { BeatGrid } from "../lib/beatGrid";
import { sectionAt, seekHoverText } from "../lib/barsFromPlayhead";
import { useTrackStructure } from "../lib/trackStructureStore";

/** The part's name joins the chip only on an overview at least this wide. */
const SECTION_MIN_PX = 400;
/** Mono 10 px: about this wide per character, plus the chip's padding. */
const CHAR_PX = 6.2;

/**
 * The seek hover on an overview: a neutral line at the pointer and how far it is from the playhead («+16 bars»). It draws on
 * a layer that ignores the pointer and listens on its parent, the overview's wrapper, so a click still seeks as before.
 * Hidden on touch, while a seek drag runs and while the deck cannot seek.
 */
export function OverviewHover({ grid, time, duration, trackId, canSeek }: {
  grid: BeatGrid | null;
  /** The playhead, in the track's seconds. */
  time: number;
  duration: number;
  trackId: number;
  canSeek: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const wrapper = layer.current?.parentElement;
    if (!wrapper) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.buttons !== 0) { setAt(null); return; }
      const box = wrapper.getBoundingClientRect();
      setAt(box.width > 0 ? { x: Math.max(0, Math.min(box.width, e.clientX - box.left)), width: box.width } : null);
    };
    const leave = () => setAt(null);
    wrapper.addEventListener("pointermove", move);
    wrapper.addEventListener("pointerleave", leave);
    wrapper.addEventListener("pointerdown", leave);
    return () => {
      wrapper.removeEventListener("pointermove", move);
      wrapper.removeEventListener("pointerleave", leave);
      wrapper.removeEventListener("pointerdown", leave);
    };
  }, []);
  const wide = at != null && at.width >= SECTION_MIN_PX;
  const structure = useTrackStructure(wide ? trackId : null);
  const show = at != null && canSeek && duration > 0 && Number.isFinite(time);
  const pointer = show ? (at.x / at.width) * duration : 0;
  const text = show ? seekHoverText(grid, time, pointer) : "";
  const section = show && wide ? sectionAt(structure?.sections, pointer) : null;
  const chars = text.length + (section ? section.length + 3 : 0);
  const flip = show && at.x + 6 + chars * CHAR_PX + 8 > at.width;
  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0 z-30">
      {show && (
        <div className="absolute inset-y-0" style={{ left: at.x }}>
          <div className="absolute inset-y-0 -left-px w-px bg-cm-text/75" />
          <span className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-[3px] bg-black/60 px-1 font-mono text-[10px] font-semibold leading-[14px] tabular-nums text-white ${flip ? "right-1.5" : "left-1.5"}`}>
            {text}{section && <span className="font-medium text-white/65"> · {section}</span>}
          </span>
        </div>
      )}
    </div>
  );
}
