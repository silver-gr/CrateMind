import { cn } from "@/lib/cn";
import { WHEEL_NUMBERS, CAMELOT_TO_MUSICAL, neighbors, toCamelot, camelotCode, keyColor } from "@/lib/camelot";

/**
 * Camelot wheel. 12 numbers × 2 rings (outer = B/major, inner = A/minor).
 * `counts` uses normalized effective musical keys and sets slice brightness;
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
    const intensity = (counts[code] || 0) / max;
    const isSel = code === selCode;
    const isNbr = nbrs.has(code);
    const fill = keyColor(code);
    const [lx, ly] = polar(cx, cy, (r0 + r1) / 2, i * 30);
    return (
      <g
        key={code}
        role={onSelect ? "radio" : undefined}
        aria-checked={onSelect ? isSel : undefined}
        aria-label={`${code}, ${CAMELOT_TO_MUSICAL[code]}, ${(counts[code] || 0).toLocaleString("el-GR")} tracks`}
        tabIndex={onSelect ? (code === (selCode ?? "12A") ? 0 : -1) : undefined}
        className={onSelect ? "group cursor-pointer outline-none" : undefined}
        onClick={onSelect ? () => onSelect(code) : undefined}
        onKeyDown={onSelect ? (event) => {
          let target: string;
          if (event.key === "Enter" || event.key === " ") target = code;
          else if (event.key === "ArrowRight") target = `${num % 12 + 1}${ring}`;
          else if (event.key === "ArrowLeft") target = `${(num + 10) % 12 + 1}${ring}`;
          else if (event.key === "ArrowUp") target = `${num}B`;
          else if (event.key === "ArrowDown") target = `${num}A`;
          else if (event.key === "Home") target = `12${ring}`;
          else if (event.key === "End") target = `11${ring}`;
          else return;
          event.preventDefault();
          onSelect(target);
          event.currentTarget.ownerSVGElement?.querySelector<SVGElement>(`[data-key="${target}"]`)?.focus();
        } : undefined}
        data-key={code}
      >
        <title>{`${code} · ${CAMELOT_TO_MUSICAL[code]} · ${(counts[code] || 0).toLocaleString("el-GR")} tracks`}</title>
        <path
          d={sector(cx, cy, r0, r1, a0, a1)}
          fill={fill}
          fillOpacity={0.16 + 0.64 * intensity}
          stroke={isSel ? "var(--color-cm-cyan)" : isNbr ? "var(--color-cm-chartreuse)" : "oklch(0.82 0.07 250 / 0.18)"}
          strokeWidth={isSel ? 2.5 : isNbr ? 1.5 : 0.75}
          strokeDasharray={isNbr ? "4 2" : undefined}
          className="transition-[stroke,fill] hover:brightness-125 group-focus-visible:stroke-cm-text group-focus-visible:stroke-[3]"
        />
        <text x={lx} y={ly - (size >= 300 ? 5 : 0)} dominantBaseline="central" textAnchor="middle" className="pointer-events-none fill-cm-text font-mono font-semibold" style={{ fontSize: size >= 300 ? 14 : ring === "B" ? 11 : 9 }} aria-hidden="true">
          {code}
        </text>
        {size >= 300 && <text x={lx} y={ly + 10} dominantBaseline="central" textAnchor="middle" className="pointer-events-none fill-cm-text font-mono" style={{ fontSize: 10 }} aria-hidden="true">{CAMELOT_TO_MUSICAL[code]}</text>}
      </g>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={onSelect ? "radiogroup" : "img"}
      aria-label="Camelot wheel αρμονικής συμβατότητας"
      className={cn("max-w-full select-none", className)}
    >
      {WHEEL_NUMBERS.map((_, i) => slice(i, "B"))}
      {WHEEL_NUMBERS.map((_, i) => slice(i, "A"))}
      <circle cx={cx} cy={cy} r={rIn} fill="var(--color-cm-panel-2)" stroke="var(--color-cm-border)" />
      <text x={cx} y={cy - (size >= 300 && selCode ? 8 : 0)} dominantBaseline="central" textAnchor="middle" className="fill-cm-text font-mono font-semibold" style={{ fontSize: size >= 300 ? 24 : 12 }} aria-hidden="true">
        {selCode ?? "KEY"}
      </text>
      {size >= 300 && selCode && <text x={cx} y={cy + 17} dominantBaseline="central" textAnchor="middle" className="fill-cm-text font-mono" style={{ fontSize: 12 }} aria-hidden="true">{(counts[selCode] ?? 0).toLocaleString("el-GR")} tracks</text>}
    </svg>
  );
}

export default KeyWheel;
