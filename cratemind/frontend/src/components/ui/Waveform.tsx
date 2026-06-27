import { cn } from "@/lib/cn";

/**
 * Cosmetic waveform. CrateMind has no peak data (read-only audio), so bars are a
 * deterministic pseudo-random field keyed on a seed — decorative only. Real audio
 * still plays/seeks via the MiniPlayer's <audio> + range input. ALWAYS
 * pointer-events-none so it never intercepts a seek overlay placed above it.
 */
export function Waveform({
  seed,
  bars = 56,
  progress = 0,
  className,
  played = "var(--color-cm-cyan)",
  idle = "oklch(0.82 0.07 250 / 0.22)",
}: {
  seed: string | number;
  bars?: number;
  progress?: number; // 0..1 — tints the played portion
  className?: string;
  played?: string;
  idle?: string;
}) {
  let h = (typeof seed === "string"
    ? seed.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) & 0x7fffffff, 7)
    : Math.abs(Math.trunc(seed)) || 7);
  const heights: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const noise = 0.2 + ((h % 1000) / 1000) * 0.8;
    const arch = Math.sin((i / bars) * Math.PI) * 0.35 + 0.65; // gentle center swell
    heights.push(Math.max(0.12, Math.min(1, noise * arch)));
  }
  const playedTo = Math.floor(progress * bars);
  return (
    <div aria-hidden className={cn("pointer-events-none flex h-full items-center gap-px", className)}>
      {heights.map((ht, i) => (
        <span
          key={i}
          className="w-full flex-1 rounded-full"
          style={{ height: `${ht * 100}%`, background: i <= playedTo ? played : idle }}
        />
      ))}
    </div>
  );
}

export default Waveform;
