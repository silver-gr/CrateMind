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
    return <div className="text-xs text-cm-faint">{label}: χωρίς δεδομένα</div>;
  }
  const lo = min ?? Math.min(...present);
  const hi = max ?? Math.max(...present);
  const span = hi - lo || 1;
  const w = 100;
  const step = nums.length > 1 ? w / (nums.length - 1) : 0;

  const coords = nums
    .map((v, i) => (v == null ? null : { x: i * step, y: height - ((v - lo) / span) * height }))
    .filter((p): p is { x: number; y: number } => p != null);

  const line = coords.map((p) => `${p.x},${p.y}`).join(" ");
  const firstX = coords[0].x;
  const lastX = coords[coords.length - 1].x;
  const area = `${line} ${lastX},${height} ${firstX},${height}`;

  return (
    <div>
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
        style={{ height }}
      >
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--color-cm-violet)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`} stroke="none" />
        <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </div>
  );
}
