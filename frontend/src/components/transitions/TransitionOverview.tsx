import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../lib/cn";
import { barSeconds } from "../../lib/beatGrid";
import { CONTROL_COPY } from "../../lib/transitions/copy";
import { sourceToAudio, windowAudioS, type LaneSpec } from "../../lib/transitions/dualWaveform";
import { TrackWaveform } from "../ui/TrackWaveform";

interface Span { left: number; width: number }
export interface OverviewLayout { t0: number; t1: number; out: Span; in: Span }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Both full tracks on the editor's audio axis (0 = window start): the incoming one starts `inStartS / rateIn` before
 *  the window, so it reads as offset under the outgoing one. Spans are fractions of the strip width. */
export function overviewLayout(out: LaneSpec, inn: LaneSpec): OverviewLayout {
  const a = [sourceToAudio(out, 0), sourceToAudio(out, out.duration)];
  const b = [sourceToAudio(inn, 0), sourceToAudio(inn, inn.duration)];
  const t0 = Math.min(a[0], b[0]);
  const t1 = Math.max(a[1], b[1]);
  const span = Math.max(1e-6, t1 - t0);
  const frac = ([s, e]: number[]): Span => ({ left: (s - t0) / span, width: (e - s) / span });
  return { t0, t1, out: frac(a), in: frac(b) };
}

/** The zoomed view (`bars` outgoing bars around `centerAudioS`) as a fraction span of the strip. */
export function overviewViewport(l: OverviewLayout, view: { centerAudioS: number; bars: number }, barAudioS: number): Span {
  const span = Math.max(1e-6, l.t1 - l.t0);
  const width = Math.min(1, (view.bars * barAudioS) / span);
  return { left: (view.centerAudioS - (view.bars * barAudioS) / 2 - l.t0) / span, width };
}

export const clampViewCenter = (l: OverviewLayout, centerAudioS: number) => clamp(centerAudioS, l.t0, l.t1);

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
const mmss = (s: number) => `${s < 0 ? "−" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, "0")}`;

/**
 * Overview strip: the outgoing track (upper half) and the incoming one (lower half) in full, the transition window as a
 * cyan band and the zoomed view as a rectangle. Dragging anywhere pans the view 1:1 (a press away from the rectangle
 * first centres it there); the rectangle is a slider for the keyboard (←/→ one bar, Shift four).
 */
export function TransitionOverview({ out, in: inn, window: win, view, onViewChange, className }: {
  out: LaneSpec;
  in: LaneSpec;
  window: { outStartS: number; bars: number };
  view: { centerAudioS: number; bars: number };
  onViewChange(centerAudioS: number): void;
  className?: string;
}) {
  const layout = overviewLayout(out, inn);
  const span = Math.max(1e-6, layout.t1 - layout.t0);
  const barAudioS = barSeconds(out.grid, out.anchorS) / (out.rate > 0 ? out.rate : 1);
  const vp = overviewViewport(layout, view, barAudioS);
  const vpLeft = clamp(vp.left, 0, 1 - vp.width);
  const winStart = sourceToAudio(out, win.outStartS);
  const winSpan = { left: (winStart - layout.t0) / span, width: windowAudioS(out.grid, win.outStartS, win.bars, out.rate) / span };
  const drag = useRef<{ id: number; x: number; center: number } | null>(null);

  const setCenter = (c: number) => { const next = clampViewCenter(layout, c); if (Math.abs(next - view.centerAudioS) > 1e-9) onViewChange(next); };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    let center = view.centerAudioS;
    if (!(e.target as HTMLElement).closest("[data-overview-viewport]")) {
      center = clampViewCenter(layout, layout.t0 + ((e.clientX - rect.left) / Math.max(1, rect.width)) * span);
      setCenter(center);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, center };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setCenter(d.center + ((e.clientX - d.x) / Math.max(1, e.currentTarget.getBoundingClientRect().width)) * span);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === e.pointerId) drag.current = null; };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setCenter(view.centerAudioS + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 4 : 1) * barAudioS);
  };

  return (
    <div role="group" aria-label={CONTROL_COPY.overview}
      className={cn("relative h-12 cursor-pointer touch-none select-none overflow-hidden rounded-md bg-cm-line/5", className)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
      <div className="absolute inset-x-0 top-0 h-1/2 pb-px">
        <div className="absolute inset-y-0" style={{ left: pct(layout.out.left), width: pct(layout.out.width) }}>
          <TrackWaveform trackId={out.trackId} sourceRevision={out.revision} spectral className="h-full w-full" />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1/2 pt-px">
        <div className="absolute inset-y-0" style={{ left: pct(layout.in.left), width: pct(layout.in.width) }}>
          <TrackWaveform trackId={inn.trackId} sourceRevision={inn.revision} spectral className="h-full w-full" />
        </div>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-x border-cm-cyan/60 bg-cm-cyan/15"
        style={{ left: pct(winSpan.left), width: pct(winSpan.width) }} />
      <div
        data-overview-viewport
        role="slider"
        tabIndex={0}
        aria-label={CONTROL_COPY.viewport}
        aria-orientation="horizontal"
        aria-valuemin={Math.round(layout.t0)}
        aria-valuemax={Math.round(layout.t1)}
        aria-valuenow={Math.round(view.centerAudioS)}
        aria-valuetext={mmss(view.centerAudioS)}
        onKeyDown={onKeyDown}
        className="absolute inset-y-0 cursor-grab rounded-[3px] bg-cm-text/8 ring-1 ring-cm-text/70 ring-inset outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-cm-cyan"
        style={{ left: pct(vpLeft), width: pct(vp.width) }}
      />
    </div>
  );
}
