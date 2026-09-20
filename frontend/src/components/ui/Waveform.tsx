import { useMemo } from "react";
import { cn } from "@/lib/cn";

export interface WaveformProps {
  /** Optional fallback seed if real audio peaks are not yet loaded */
  seed?: string | number;
  /** Real audio amplitude peaks extracted from the source file (0.0 to 1.0) */
  peaks?: number[];
  /** Desired number of visual bars (default 160) */
  bars?: number;
  /** Playback progress 0..1 */
  progress?: number;
  className?: string;
  played?: string;
  idle?: string;
}

/**
 * High-fidelity SoundCloud-style mirrored waveform driven by REAL AUDIO PEAKS.
 *
 * - When `peaks` is provided, displays the 100% genuine acoustic amplitude envelope
 *   of the actual audio file: real drops, breakdowns, buildups, and fades.
 * - Upper container: transient peaks extending upward from the centerline.
 * - Centerline: 1px hairline tracking playback position.
 * - Lower container: mirrored reflection extending downward with reduced opacity.
 * - No fake or hallucinated section labels.
 *
 * ALWAYS pointer-events-none so it never intercepts player range scrubber clicks.
 */
export function Waveform({
  seed = 7,
  peaks,
  bars = 160,
  progress = 0,
  className,
  played = "var(--color-cm-cyan)",
  idle = "color-mix(in oklch, var(--color-cm-text) 24%, transparent)",
}: WaveformProps) {
  const barHeights = useMemo(() => {
    // 1. If REAL peaks are provided from the backend audio decoder:
    if (peaks && peaks.length > 0) {
      if (peaks.length === bars) {
        return peaks;
      }
      // Resample peaks to target `bars` count via bucket averaging / peak hold
      const resampled: number[] = [];
      const ratio = peaks.length / bars;
      for (let i = 0; i < bars; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
        let maxP = 0;
        for (let j = start; j < end && j < peaks.length; j++) {
          if (peaks[j] > maxP) maxP = peaks[j];
        }
        resampled.push(maxP || 0.05);
      }
      return resampled;
    }

    // 2. Fallback only if peaks are still loading or unavailable:
    let h =
      typeof seed === "string"
        ? seed.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) & 0x7fffffff, 7)
        : Math.abs(Math.trunc(seed)) || 7;

    const fallback: number[] = [];
    for (let i = 0; i < bars; i++) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      const noise = 0.2 + ((h % 1000) / 1000) * 0.6;
      fallback.push(Math.max(0.06, Math.min(1.0, noise)));
    }
    return fallback;
  }, [peaks, seed, bars]);

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const playedTo = Math.floor(clampedProgress * bars);

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none relative flex h-full w-full flex-col justify-between overflow-hidden select-none",
        className,
      )}
    >
      {/* Top half: SoundCloud upper peaks */}
      <div className="relative z-1 flex flex-1 min-h-0 items-end gap-px overflow-hidden pt-1">
        {barHeights.map((val, i) => (
          <span
            key={i}
            className="w-full flex-1 rounded-t-[1px] transition-colors"
            style={{
              height: `${Math.max(4, Math.round(val * 100))}%`,
              backgroundColor: i <= playedTo ? played : idle,
            }}
          />
        ))}
      </div>

      {/* Centerline hairline */}
      <div
        className="relative z-1 h-px w-full shrink-0"
        style={{
          background: `linear-gradient(to right, ${played} ${clampedProgress * 100}%, color-mix(in oklch, var(--color-cm-text) 16%, transparent) ${clampedProgress * 100}%)`,
        }}
      />

      {/* Bottom half: SoundCloud mirrored reflection */}
      <div className="relative z-1 flex h-[35%] min-h-0 items-start gap-px overflow-hidden">
        {barHeights.map((val, i) => (
          <span
            key={i}
            className="w-full flex-1 rounded-b-[1px] opacity-45 transition-colors"
            style={{
              height: `${Math.max(3, Math.round(val * 65))}%`,
              backgroundColor: i <= playedTo ? played : idle,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default Waveform;
