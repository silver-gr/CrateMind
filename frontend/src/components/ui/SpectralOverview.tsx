import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { DetailWaveform } from "../../lib/detailWaveform";
import { renderOverviewRGBA, OVERVIEW_MAX_WIDTH, OVERVIEW_MAX_HEIGHT } from "../../lib/overviewWaveform";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/cn";

/** Cached spectral bitmap; pointer handling and playhead positioning belong to the host. */
export function SpectralOverview({ data, progress = 0, className, drawRef }: {
  data: DetailWaveform;
  progress?: number;
  className?: string;
  drawRef?: MutableRefObject<((progress: number) => void) | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<HTMLCanvasElement | null>(null);
  const [palette] = usePref("waveformPalette");
  const draw = useCallback((_progress: number) => {
    const target = canvas.current, cached = bitmap.current;
    if (!target || !cached) return;
    if (target.width !== cached.width) target.width = cached.width;
    if (target.height !== cached.height) target.height = cached.height;
    const context = target.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    // Keep the entire spectral image readable before playback and after the playhead.
    context.drawImage(cached, 0, 0);
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let previousWidth = 0, previousHeight = 0;
    function build() {
      const bounds = element!.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const dpr = Math.max(.5, Math.min(4, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.min(OVERVIEW_MAX_WIDTH, Math.round(bounds.width * dpr)));
      const height = Math.max(1, Math.min(OVERVIEW_MAX_HEIGHT, Math.round(bounds.height * dpr)));
      if (width === previousWidth && height === previousHeight) return;
      const cached = document.createElement("canvas");
      cached.width = width; cached.height = height;
      const context = cached.getContext("2d");
      if (!context) return;
      context.putImageData(new ImageData(renderOverviewRGBA(data, width, height, palette), width, height), 0, 0);
      bitmap.current = cached;
      previousWidth = width; previousHeight = height;
      draw(0);
    }
    const observer = new ResizeObserver(build);
    observer.observe(element);
    window.addEventListener("resize", build);
    build();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", build);
      bitmap.current = null;
    };
  }, [data, palette, draw]);

  useEffect(() => {
    if (drawRef) drawRef.current = draw;
    return () => { if (drawRef?.current === draw) drawRef.current = null; };
  }, [draw, drawRef]);
  useEffect(() => { draw(progress); }, [draw, progress]);

  return <div ref={root} aria-hidden="true" className={cn("pointer-events-none relative h-full w-full overflow-hidden", className)}>
    <canvas ref={canvas} data-spectral-overview="true" className="absolute inset-0 h-full w-full" />
  </div>;
}
