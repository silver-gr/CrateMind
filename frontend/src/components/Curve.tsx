import { useId } from "react";

interface Props {
  values: (number | null)[];
  min?: number;
  max?: number;
  color?: string;
  label?: string;
  height?: number;
}

export default function Curve({
  values,
  min,
  max,
  color = "var(--color-cm-cyan)",
  label,
  height = 36,
}: Props) {
  const rawId = useId();
  const gid = `curve-${rawId.replace(/:/g, "")}`;
  const nums = values.map((v) => (v == null ? null : v));
  const present = nums.filter((v): v is number => v != null);
  if (present.length === 0) {
    return (
      <div className="w-full min-w-0">
        {label && <div className="mb-1 text-xs text-cm-muted">{label}</div>}
        <div
          style={{ height }}
          className="grid place-items-center rounded-lg border border-dashed border-cm-border text-[11px] text-cm-faint"
        >
          Χωρίς δεδομένα
        </div>
      </div>
    );
  }
  const lo = min ?? Math.min(...present);
  const hi = max ?? Math.max(...present);
  const span = hi - lo || 1;
  const w = 100;
  // Fit the observed portion to the plot, including when edge tracks lack ratings.
  const observed = nums.flatMap((value, index) => value == null ? [] : [{ value, index }]);
  const firstIndex = observed[0].index;
  const indexSpan = observed[observed.length - 1].index - firstIndex || 1;
  const coords = observed.map(({ value, index }) => ({
    x: ((index - firstIndex) / indexSpan) * w,
    y: height - ((value - lo) / span) * height,
  }));
  if (coords.length === 1) coords.push({ ...coords[0], x: w });

  const line = coords.map((p) => `${p.x},${p.y}`).join(" ");
  const firstX = coords[0].x;
  const lastX = coords[coords.length - 1].x;
  const area = `${line} ${lastX},${height} ${firstX},${height}`;

  return (
    <div className="w-full min-w-0">
      {label && (
        <div className="mb-1 flex justify-between text-xs text-cm-muted">
          <span>{label}</span>
          <span className="font-mono tabular-nums text-cm-faint">
            {lo.toFixed(0)}–{hi.toFixed(0)}
          </span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{
          height,
          width: "100%",
          display: "block",
          filter: `drop-shadow(0 0 4px oklch(from ${color} l c h / 0.5))`,
        }}
      >
        <defs>
          <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={height}>
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`} stroke="none" />
        <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
