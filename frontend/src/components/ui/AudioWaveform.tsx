import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface AudioEnvelope { peaks: number[]; rms?: number[]; duration?: number; version?: number }

/** Pixel-sized peak silhouette with a separate RMS body; canvas never handles seeking. */
export function AudioWaveform({ data, progress = 0, className, played = "var(--color-cm-cyan)",
  idle = "color-mix(in oklch, var(--color-cm-text) 30%, transparent)" }: {
  data: AudioEnvelope; progress?: number; className?: string; played?: string; idle?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeColor = useRef<HTMLSpanElement>(null);
  const idleColor = useRef<HTMLSpanElement>(null);
  const layers = useRef<{ active: HTMLCanvasElement; idle: HTMLCanvasElement } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    function build() {
      const bounds = el!.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const dpr = window.devicePixelRatio || 1;
      // Two-pixel bars with a one-pixel gap; no invented detail beyond available samples.
      const bars = Math.min(data.peaks.length, Math.max(1, Math.floor(width / 3)));
      const envelope = Array.from({ length: bars }, (_, i) => {
        const start = Math.floor(i * data.peaks.length / bars);
        const end = Math.floor((i + 1) * data.peaks.length / bars);
        let peak = 0, energy = 0;
        for (let j = start; j < end; j++) {
          peak = Math.max(peak, data.peaks[j]);
          energy += (data.rms?.[j] ?? data.peaks[j]) ** 2;
        }
        return { peak, rms: Math.sqrt(energy / (end - start)) };
      });
      function layer(color: string) {
        const c = document.createElement("canvas");
        c.width = Math.round(width * dpr); c.height = Math.round(height * dpr);
        const ctx = c.getContext("2d")!;
        ctx.scale(dpr, dpr); ctx.fillStyle = color;
        const center = height * .6, top = center - 1, bottom = height - center - 1;
        const step = width / bars, barWidth = Math.min(2, step);
        envelope.forEach(({ peak, rms }, i) => {
          ctx.globalAlpha = .4;
          ctx.fillRect(i * step, center - peak * top, barWidth, peak * (top + bottom));
          ctx.globalAlpha = 1;
          ctx.fillRect(i * step, center - rms * top, barWidth, rms * (top + bottom));
        });
        return c;
      }
      layers.current = {
        active: layer(getComputedStyle(activeColor.current!).color),
        idle: layer(getComputedStyle(idleColor.current!).color),
      };
      setRevision(n => n + 1);
    }
    const observer = new ResizeObserver(build);
    observer.observe(el);
    const theme = new MutationObserver(build);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    window.addEventListener("resize", build);
    build();
    return () => { observer.disconnect(); theme.disconnect(); window.removeEventListener("resize", build); };
  }, [data, played, idle]);

  useEffect(() => {
    const c = canvas.current, l = layers.current;
    if (!c || !l) return;
    if (c.width !== l.active.width) c.width = l.active.width;
    if (c.height !== l.active.height) c.height = l.active.height;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(l.idle, 0, 0);
    ctx.save(); ctx.beginPath();
    ctx.rect(0, 0, Math.max(0, Math.min(1, progress)) * c.width, c.height);
    ctx.clip(); ctx.drawImage(l.active, 0, 0); ctx.restore();
  }, [progress, revision]);

  return <div ref={root} aria-hidden="true" className={cn("pointer-events-none relative h-full w-full overflow-hidden", className)}>
    <span ref={activeColor} className="hidden" style={{ color: played }} />
    <span ref={idleColor} className="hidden" style={{ color: idle }} />
    <canvas data-audio-waveform="true" ref={canvas} className="absolute inset-0 h-full w-full" />
  </div>;
}
