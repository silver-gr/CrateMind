interface Props {
  values: (number | null)[];
  min?: number;
  max?: number;
  color?: string;
  label?: string;
  height?: number;
}

export default function Curve({ values, min, max, color = "#34d399", label, height = 36 }: Props) {
  const nums = values.map((v) => (v == null ? null : v));
  const present = nums.filter((v): v is number => v != null);
  if (present.length === 0) {
    return <div className="text-xs text-neutral-600">{label}: no data</div>;
  }
  const lo = min ?? Math.min(...present);
  const hi = max ?? Math.max(...present);
  const span = hi - lo || 1;
  const w = 100;
  const step = nums.length > 1 ? w / (nums.length - 1) : 0;
  const pts = nums
    .map((v, i) => (v == null ? null : `${i * step},${height - ((v - lo) / span) * height}`))
    .filter(Boolean)
    .join(" ");
  return (
    <div>
      {label && (
        <div className="mb-1 flex justify-between text-xs text-neutral-400">
          <span>{label}</span>
          <span className="text-neutral-600">
            {lo.toFixed(0)}–{hi.toFixed(0)}
          </span>
        </div>
      )}
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-9 w-full">
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
    </div>
  );
}
