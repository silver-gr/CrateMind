import { type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { Disc3 } from "@/lib/icons";

/**
 * Cosmetic album-art placeholder. CrateMind stores no artwork (read-only library),
 * so we render a deterministic neon gradient tile keyed on the track id — stable
 * per track, cheap (pure CSS, no network), safe on virtualized rows. Decorative.
 */
const HUES = [205, 252, 300, 340, 128, 78, 18]; // cm cyan/blue/violet/magenta/chartreuse/amber/rose

function hash(seed: string | number): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function Artwork({
  seed,
  className,
  circle = false,
  glyph = true,
}: {
  seed: string | number;
  className?: string;
  circle?: boolean;
  glyph?: boolean;
}) {
  const h = hash(seed);
  const a = HUES[h % HUES.length];
  const b = HUES[(h >> 4) % HUES.length];
  const ang = h % 360;
  const style: CSSProperties = {
    backgroundImage: `linear-gradient(${ang}deg, oklch(0.58 0.18 ${a}), oklch(0.26 0.10 ${b}))`,
  };
  return (
    <div
      aria-hidden
      className={cn("relative grid shrink-0 place-items-center overflow-hidden", circle ? "rounded-full" : "rounded-lg", className)}
      style={style}
    >
      <div
        className="absolute inset-0"
        style={{ backgroundImage: "radial-gradient(circle at 28% 22%, oklch(1 0 0 / 0.20), transparent 55%)" }}
      />
      {glyph && <Disc3 className="relative h-1/3 w-1/3 text-white/25" />}
    </div>
  );
}

export default Artwork;
