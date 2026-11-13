import { cn } from "@/lib/cn";
import type { ChipTone } from "@/lib/queryChips";

const TONE_VAR: Record<ChipTone, string> = {
  cyan: "var(--color-cm-cyan)",
  blue: "var(--color-cm-blue)",
  violet: "var(--color-cm-violet)",
  chartreuse: "var(--color-cm-chartreuse)",
  magenta: "var(--color-cm-magenta)",
  amber: "var(--color-cm-amber)",
  rose: "var(--color-cm-rose)",
  muted: "var(--color-cm-faint)",
};

/** Circular progress gauge. `value` is 0..1. Decorative-but-real where fed real ratios. */
export function Gauge({
  value,
  size = 92,
  tone = "cyan",
  label,
  sub,
  className,
}: {
  value: number;
  size?: number;
  tone?: ChipTone;
  label?: string;
  sub?: string;
  className?: string;
}) {
  const v = Math.max(0, Math.min(1, value || 0));
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className={cn("relative grid place-items-center", className)} style={{ width: size, height: size }}>
      {/* The neon glow sits on the <svg>: CSS filters on SVG children are unreliable in WebKit/WebView2. */}
      <svg
        width={size}
        height={size}
        className="-rotate-90"
        style={{ filter: `drop-shadow(0 0 4px oklch(from ${TONE_VAR[tone]} l c h / 0.55))` }}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--cm-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TONE_VAR[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-mono text-sm font-semibold tabular-nums text-cm-text">{label ?? `${Math.round(v * 100)}%`}</div>
        {sub && <div className="text-[10px] uppercase tracking-[0.12em] text-cm-faint">{sub}</div>}
      </div>
    </div>
  );
}

/** Simple vertical bar chart for histograms (Energy Maps). Optional click→deep-link. */
export function Bars({
  data,
  max,
  height = 120,
  className,
  onSelect,
}: {
  data: { label: string; value: number; tone?: ChipTone }[];
  max?: number;
  height?: number;
  className?: string;
  onSelect?: (label: string) => void;
}) {
  const hi = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn("flex items-end gap-1.5", className)} style={{ height }}>
      {data.map((d) => {
        const h = hi > 0 ? (d.value / hi) * 100 : 0;
        const Comp = onSelect ? "button" : "div";
        return (
          <Comp
            key={d.label}
            {...(onSelect ? { onClick: () => onSelect(d.label), type: "button" as const } : {})}
            title={`${d.label}: ${d.value}`}
            className={cn("group flex h-full flex-1 flex-col items-center justify-end gap-1", onSelect && "cursor-pointer")}
          >
            <span className="font-mono text-[9px] tabular-nums text-cm-faint opacity-0 transition group-hover:opacity-100">{d.value}</span>
            <span
              className="w-full rounded-t transition-[height,filter] group-hover:brightness-125"
              style={{ height: `${Math.max(2, h)}%`, background: TONE_VAR[d.tone ?? "cyan"] }}
            />
            <span className="font-mono text-[9px] text-cm-faint">{d.label}</span>
          </Comp>
        );
      })}
    </div>
  );
}

export default Gauge;
