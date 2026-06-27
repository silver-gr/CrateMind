import { cn } from "@/lib/cn";
import { WHEEL_NUMBERS, neighbors, toCamelot, camelotCode } from "@/lib/camelot";

/**
 * Camelot wheel. 12 numbers × 2 rings (outer = B/major, inner = A/minor).
 * `counts` (real, from exact `trackCount("key:8A")` buckets) sets slice brightness;
 * `selected` highlights a key + its harmonic neighbours. Click a slice → onSelect(code).
 */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function sector(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, rOut, a0);
  const [x1, y1] = polar(cx, cy, rOut, a1);
  const [x2, y2] = polar(cx, cy, rIn, a1);
  const [x3, y3] = polar(cx, cy, rIn, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} A${rOut},${rOut} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rIn},${rIn} 0 ${large} 0 ${x3},${y3} Z`;
}

export function KeyWheel({
  counts = {},
  selected,
  onSelect,
  size = 260,
  className,
}: {
  counts?: Record<string, number>;
  selected?: string | null;
  onSelect?: (code: string) => void;
  size?: number;
  className?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOut = size / 2 - 2;
  const rMid = rOut * 0.66;
  const rIn = rOut * 0.34;
  const max = Math.max(1, ...Object.values(counts));

  const sel = selected ? toCamelot(selected) : null;
  const selCode = sel ? camelotCode(sel) : null;
  const nbrs = sel ? new Set(neighbors(sel).map(camelotCode)) : new Set<string>();

  function slice(i: number, ring: "A" | "B") {
    const num = WHEEL_NUMBERS[i];
    const code = `${num}${ring}`;
    const a0 = i * 30 - 15;
    const a1 = i * 30 + 15;
    const [r0, r1] = ring === "B" ? [rMid, rOut] : [rIn, rMid];
    const hue = i * 30;
    const intensity = (counts[code] || 0) / max;
    const isSel = code === selCode;
    const isNbr = nbrs.has(code);
    const fill = `oklch(${0.42 + 0.18 * intensity} ${0.12 + 0.08 * intensity} ${hue} / ${0.35 + 0.5 * intensity})`;
    const [lx, ly] = polar(cx, cy, (r0 + r1) / 2, i * 30);
    return (
      <g key={code} className={onSelect ? "cursor-pointer" : undefined} onClick={onSelect ? () => onSelect(code) : undefined}>
        <title>{`${code} · ${counts[code] || 0} tracks`}</title>
        <path
          d={sector(cx, cy, r0, r1, a0, a1)}
          fill={fill}
          stroke={isSel ? "var(--color-cm-cyan)" : isNbr ? "var(--color-cm-chartreuse)" : "oklch(0.82 0.07 250 / 0.18)"}
          strokeWidth={isSel ? 2.5 : isNbr ? 1.5 : 0.75}
          className="transition-[stroke,fill] hover:brightness-125"
        />
        <text x={lx} y={ly} dominantBaseline="central" textAnchor="middle" className="pointer-events-none fill-white/85 font-mono" style={{ fontSize: ring === "B" ? 11 : 9 }}>
          {code}
        </text>
      </g>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Camelot wheel αρμονικής συμβατότητας"
      className={cn("select-none", className)}
    >
      {WHEEL_NUMBERS.map((_, i) => slice(i, "B"))}
      {WHEEL_NUMBERS.map((_, i) => slice(i, "A"))}
      <circle cx={cx} cy={cy} r={rIn} fill="oklch(0.16 0.038 274 / 0.7)" stroke="oklch(0.82 0.07 250 / 0.14)" />
      <text x={cx} y={cy} dominantBaseline="central" textAnchor="middle" className="fill-cm-faint font-mono" style={{ fontSize: 9 }}>
        {selCode ?? "KEY"}
      </text>
    </svg>
  );
}

export default KeyWheel;
