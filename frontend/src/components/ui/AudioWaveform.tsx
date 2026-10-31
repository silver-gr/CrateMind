import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { cn } from "../../lib/cn";

export interface AudioEnvelope { peaks: number[]; rms?: number[]; duration?: number; version?: number }

/** Reduce equal-duration samples without dropping fractional bucket boundaries. */
function reduceEnvelope(samples: number[], bars: number) {
  return Array.from({ length: bars }, (_, i) => {
    const start = i * samples.length / bars;
    const end = (i + 1) * samples.length / bars;
    let energy = 0;
    for (let j = Math.floor(start); j < Math.min(samples.length, Math.ceil(end)); j++) {
      const sample = Number.isFinite(samples[j]) ? Math.max(0, Math.min(1, samples[j])) : 0;
      const overlap = Math.min(end, j + 1) - Math.max(start, j);
      energy += sample * sample * overlap;
    }
    return Math.sqrt(energy / (end - start));
  });
}

/** One energy silhouette and a quiet reflection; canvas never handles seeking. */
export function AudioWaveform({ data, progress = 0, className, played = "var(--color-cm-cyan)", idle, drawRef }: {
  data: AudioEnvelope; progress?: number; className?: string; played?: string; idle?: string;
  /** Receives a draw(progress) function so a rAF loop can repaint the played region without React state. */
  drawRef?: MutableRefObject<((progress: number) => void) | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeColor = useRef<HTMLSpanElement>(null);
  const middleColor = useRef<HTMLSpanElement>(null);
  const endColor = useRef<HTMLSpanElement>(null);
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
      // RMS describes sustained energy; old peak-only payloads retain their real envelope.
      const samples = data.rms && data.rms.length === data.peaks.length ? data.rms : data.peaks;
      // Two-pixel bars with a one-pixel gap; no invented detail beyond available samples.
      const bars = Math.min(samples.length, Math.max(1, Math.floor(width / 3)));
      const envelope = reduceEnvelope(samples, bars);
      // Fit the overview vertically with one display-only gain for the whole track.
      // Preserve relative dynamics and silence; do not magnify near-silent noise.
      const maximum = envelope.reduce((max, amplitude) => Math.max(max, amplitude), 0);
      const displayGain = maximum >= 0.01 ? 1 / maximum : 1;
      const colors = [activeColor, middleColor, endColor, activeColor]
        .map(ref => getComputedStyle(ref.current!).color);
      function layer(stops: string[], opacity = 1) {
        const c = document.createElement("canvas");
        c.width = Math.round(width * dpr); c.height = Math.round(height * dpr);
        const ctx = c.getContext("2d")!;
        ctx.scale(dpr, dpr);
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        stops.forEach((color, i) => gradient.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), color));
        ctx.fillStyle = gradient;
        const center = height / 2;
        // Four-pixel headroom matches the player playhead's vertical inset.
        const extent = Math.max(0, center - 5);
        const step = bars ? width / bars : 0, barWidth = Math.min(2, step);
        envelope.forEach((amplitude, i) => {
          const barHeight = amplitude * displayGain * extent;
          ctx.globalAlpha = opacity;
          ctx.fillRect(i * step, center - 1 - barHeight, barWidth, barHeight);
          ctx.globalAlpha = .24 * opacity;
          ctx.fillRect(i * step, center + 1, barWidth, barHeight);
        });
        return c;
      }
      layers.current = {
        active: layer(colors),
        // Keep the full color sequence visible while the played portion stays brighter.
        idle: idle ? layer([getComputedStyle(idleColor.current!).color]) : layer(colors, .3),
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

  function draw(progress: number) {
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
  }

  useEffect(() => {
    draw(progress);
    if (drawRef) drawRef.current = draw;
    return () => { if (drawRef && drawRef.current === draw) drawRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, revision, drawRef]);

  return <div ref={root} aria-hidden="true" className={cn("pointer-events-none relative h-full w-full overflow-hidden", className)}>
    <span ref={activeColor} className="hidden" style={{ color: played }} />
    <span ref={middleColor} className="hidden" style={{ color: "var(--color-cm-chartreuse)" }} />
    <span ref={endColor} className="hidden" style={{ color: "var(--color-cm-violet)" }} />
    <span ref={idleColor} className="hidden" style={{ color: idle }} />
    <canvas data-audio-waveform="true" ref={canvas} className="absolute inset-0 h-full w-full" />
  </div>;
}
