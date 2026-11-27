import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { watchKnobFlash } from "@/lib/knobFlash";

const SWEEP = 135; // degrees either side of the top
const DRAG_PX = 200; // pointer travel for the full -1..1 range
const STEP = 0.05;
const FINE = 0.01; // Shift + wheel
const PAGE = 0.25;
const R = 12;
/** Wheel events closer together than this are one gesture; a gesture steps once, then once per WHEEL_PX of travel. */
const WHEEL_GAP_MS = 160;
const WHEEL_PX = 50;
const CUT = "Κομμένο";

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
/** One wheel step up (`up`) or down: STEP, or FINE with Shift. A step that would cross the rest position stops on it. */
export function knobWheelValue(value: number, rest: number, up: boolean, fine: boolean): number {
  const next = clamp(Math.round((value + (up ? 1 : -1) * (fine ? FINE : STEP)) * 100) / 100);
  return (value - rest) * (next - rest) < 0 ? rest : next;
}
/**
 * A wheel event's travel in px along the knob, or 0 when it must not turn it. Without Shift only a mostly vertical gesture
 * counts, so a sideways trackpad swipe passes over the knob; with Shift the Mac turns a mouse wheel sideways, so the larger
 * axis is the turn.
 */
export function knobWheelPx(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }): number {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX);
  return (e.shiftKey ? (vertical ? e.deltaY : e.deltaX) : vertical ? e.deltaY : 0) * scale || 0;
}
/**
 * The value as the pill over the knob's name prints it, short enough for the mixer's 36 px columns: no « dB», no «%» after
 * LP / HP, «−∞» for the LOW kill, the first part of a two-part text, and a real minus sign. Wider knobs keep «25%».
 */
export function knobShortText(text: string): string {
  if (text === CUT) return "−∞";
  if (text === "Κλειστό") return "0";
  return text.split(" · ")[0].replace(/ dB$/, "").replace(/^(LP|HP) (\d+)%$/, "$1 $2").replace(/ %$/, "%").replace(/^-/, "−");
}
const point =(deg: number) => {
  const r = (deg * Math.PI) / 180;
  return `${(16 + R * Math.sin(r)).toFixed(2)} ${(16 - R * Math.cos(r)).toFixed(2)}`;
};
/** SVG arc path between two angles (degrees from the top, clockwise). */
export const knobArc = (from: number, to: number) =>
  `M ${point(from)} A ${R} ${R} 0 ${Math.abs(to - from) > 180 ? 1 : 0} ${to >= from ? 1 : 0} ${point(to)}`;

/**
 * Arc knob (-1..1). Bipolar by default (0 = centre); `unipolar` runs the arc from the left end and rests at -1.
 * `ariaLabel` names it when the visible micro-label is shorter. No transitions: controllers move it at high frequency.
 * With `valueText`, a pill with the short value lies over the name while the pointer is over the knob, while dragging and on
 * keyboard focus; the full text stays the accessible value. The mouse wheel steps it (Shift: fine). A dot in the arc's gap says
 * it is off its rest value (rose: the LOW kill). With `controlId` (lib/knobFlash.ts) the pill also shows while the controller
 * turns that knob, until KNOB_FLASH_MS after its last move.
 */
export function Knob({ label, ariaLabel, value, onChange, valueText, className, labelClassName, unipolar = false, controlId }: { label: string; ariaLabel?: string; value: number; onChange: (v: number) => void; valueText?: (v: number) => string; className?: string; labelClassName?: string; unipolar?: boolean; controlId?: string }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const angle = knobAngle(value);
  const rest = unipolar ? -1 : 0;
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [moved, setMoved] = useState(false);
  useEffect(() => (controlId ? watchKnobFlash(controlId, setMoved) : undefined), [controlId]);
  const text = valueText?.(value);
  const latest = useRef({ value, rest, onChange });
  latest.current = { value, rest, onChange };
  // A native listener: React's wheel listener is passive, and the page must not scroll under the knob.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const gesture = { at: -Infinity, travel: 0 };
    const onWheel = (e: WheelEvent) => {
      const px = knobWheelPx(e);
      if (!px) return; // a sideways swipe is the page's, not the knob's
      e.preventDefault();
      const fresh = e.timeStamp - gesture.at > WHEEL_GAP_MS;
      gesture.at = e.timeStamp;
      if (!fresh) {
        gesture.travel += px;
        if (Math.abs(gesture.travel) < WHEEL_PX) return;
        gesture.travel -= Math.sign(gesture.travel) * WHEEL_PX;
      } else gesture.travel = 0;
      const { value: v, rest: r, onChange: change } = latest.current;
      const next = knobWheelValue(v, r, px < 0, e.shiftKey);
      if (next !== v) change(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const short = text === undefined ? null : knobShortText(text);
  const pill = short !== null && (hover || dragging || focused || moved);
  const off = Math.abs(value - rest) > 0.005;
  const dial = (
      <svg role="slider" tabIndex={0} viewBox="0 0 32 32" aria-label={ariaLabel ?? label} aria-valuemin={-1} aria-valuemax={1}
        aria-valuenow={Number(value.toFixed(2))} aria-valuetext={text} aria-orientation="vertical"
        className="size-[var(--cm-knob,2rem)] cursor-ns-resize touch-none rounded-full outline-none select-none focus-visible:ring-2 focus-visible:ring-cm-cyan"
        onFocus={e => setFocused(e.currentTarget.matches(":focus-visible"))} onBlur={() => setFocused(false)}
        onPointerDown={e => { if (e.button !== 0 || e.ctrlKey) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v: value }; setDragging(true); }}
        onPointerMove={e => { if (drag.current) onChange(knobDragValue(drag.current.v, e.clientY - drag.current.y)); }}
        onPointerUp={() => { drag.current = null; setDragging(false); }} onPointerCancel={() => { drag.current = null; setDragging(false); }}
        onDoubleClick={() => onChange(rest)}
        onKeyDown={e => { const next = knobKeyValue(value, e.key); if (next !== null) { e.preventDefault(); onChange(next); } }}>
        <path d={knobArc(-SWEEP, SWEEP)} fill="none" strokeWidth={2.5} strokeLinecap="round" className="stroke-cm-border-hi" />
        {angle !== knobAngle(rest) && <path d={knobArc(knobAngle(rest), angle)} fill="none" strokeWidth={2.5} strokeLinecap="round" className="stroke-[var(--deck,var(--cm-cyan))]" />}
        {/* The knob body inside the ring, with its pointer running to the cap's edge. */}
        <circle cx={16} cy={16} r={8.25} strokeWidth={0.75} className="fill-[var(--cm-cap)] stroke-[var(--cm-cap-edge)]" />
        <line x1={16} y1={14} x2={16} y2={9} strokeWidth={2} strokeLinecap="round" className="stroke-cm-text" transform={`rotate(${angle} 16 16)`} />
        {off && <circle cx={16} cy={27.5} r={2.3} className={short === "−∞" ? "fill-cm-rose" : "fill-[var(--deck,var(--cm-cyan))]"} />}
      </svg>
  );
  return (
    // The hover covers the dial and its name together.
    <div ref={root} className={cn("flex flex-col items-center", className)}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      {dial}
      {/* The pill lies over the name at a fixed height: nothing moves under a drag and nothing covers the knob above. The name
          is 13 px and the pill 16 px high, sized with the 34-36 px knobs of the mixer and the FX row. */}
      <span aria-hidden className={cn("relative -mt-0.5 font-mono text-[13px] font-semibold leading-none tracking-[-0.03em] text-cm-muted", labelClassName)}>
        <span className={pill ? "invisible" : undefined}>{label}</span>
        {pill && (
          <span className="absolute left-1/2 top-1/2 flex h-4 -translate-x-1/2 -translate-y-1/2 items-center whitespace-nowrap rounded-full bg-cm-bg/75 px-[3px] tracking-[-0.03em] tabular-nums text-cm-text shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--deck,var(--cm-cyan))_55%,transparent),0_1px_3px_#0004] backdrop-blur-sm">
            {short}
          </span>
        )}
      </span>
    </div>
  );
}
