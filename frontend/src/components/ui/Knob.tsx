import { useRef } from "react";
import { cn } from "@/lib/cn";

const SWEEP = 135; // degrees either side of the top
const DRAG_PX = 200; // pointer travel for the full -1..1 range
const STEP = 0.05;
const PAGE = 0.25;
const R = 12;

const clamp = (v: number) => Math.max(-1, Math.min(1, v));
/** Pointer angle in degrees clockwise from the top for a value in -1..1. */
export const knobAngle = (value: number) => clamp(value) * SWEEP;
/** Value after dragging `dy` px downward from `start` (up raises it); 200 px spans the whole range. */
export const knobDragValue = (start: number, dy: number) => clamp(start - (dy / DRAG_PX) * 2);
/** Value after an arrow/Page/Home/End key, or null for any other key. */
export function knobKeyValue(value: number, key: string): number | null {
  if (key === "ArrowUp" || key === "ArrowRight") return clamp(Math.round((value + STEP) * 100) / 100);
  if (key === "ArrowDown" || key === "ArrowLeft") return clamp(Math.round((value - STEP) * 100) / 100);
  if (key === "PageUp") return clamp(Math.round((value + PAGE) * 100) / 100);
  if (key === "PageDown") return clamp(Math.round((value - PAGE) * 100) / 100);
  if (key === "Home") return -1;
  if (key === "End") return 1;
  return null;
}
const point = (deg: number) => {
  const r = (deg * Math.PI) / 180;
  return `${(16 + R * Math.sin(r)).toFixed(2)} ${(16 - R * Math.cos(r)).toFixed(2)}`;
};
/** SVG arc path between two angles (degrees from the top, clockwise). */
export const knobArc = (from: number, to: number) =>
  `M ${point(from)} A ${R} ${R} 0 ${Math.abs(to - from) > 180 ? 1 : 0} ${to >= from ? 1 : 0} ${point(to)}`;

/** Bipolar arc knob (-1..1, 0 = centre). No transitions: controllers move it at high frequency. */
export function Knob({ label, value, onChange, valueText, className, labelClassName }: { label: string; value: number; onChange: (v: number) => void; valueText?: (v: number) => string; className?: string; labelClassName?: string }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const angle = knobAngle(value);
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg role="slider" tabIndex={0} viewBox="0 0 32 32" aria-label={label} aria-valuemin={-1} aria-valuemax={1}
        aria-valuenow={Number(value.toFixed(2))} aria-valuetext={valueText?.(value)} aria-orientation="vertical"
        className="size-[var(--cm-knob,2rem)] cursor-ns-resize touch-none rounded-full outline-none select-none focus-visible:ring-2 focus-visible:ring-cm-cyan"
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v: value }; }}
        onPointerMove={e => { if (drag.current) onChange(knobDragValue(drag.current.v, e.clientY - drag.current.y)); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => onChange(0)}
        onKeyDown={e => { const next = knobKeyValue(value, e.key); if (next !== null) { e.preventDefault(); onChange(next); } }}>
        <path d={knobArc(-SWEEP, SWEEP)} fill="none" strokeWidth={2.5} strokeLinecap="round" className="stroke-cm-border-hi" />
        {angle !== 0 && <path d={knobArc(0, angle)} fill="none" strokeWidth={2.5} strokeLinecap="round" className="stroke-cm-cyan" />}
        {/* The knob body inside the ring, with its pointer running to the cap's edge. */}
        <circle cx={16} cy={16} r={8.25} strokeWidth={0.75} className="fill-[var(--cm-cap)] stroke-[var(--cm-cap-edge)]" />
        <line x1={16} y1={14} x2={16} y2={9} strokeWidth={2} strokeLinecap="round" className="stroke-cm-text" transform={`rotate(${angle} 16 16)`} />
      </svg>
      <span aria-hidden className={cn("-mt-0.5 font-mono text-[9px] font-semibold leading-none text-cm-muted", labelClassName)}>{label}</span>
    </div>
  );
}
