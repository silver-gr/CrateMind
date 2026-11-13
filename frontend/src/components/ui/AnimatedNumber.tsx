import { useEffect, useLayoutEffect, useRef } from "react";
import { animate, useReducedMotionConfig } from "motion/react";

const fmt = new Intl.NumberFormat("el-GR");

/**
 * Count-up for a numeric stat: 0 → value on mount, then from the shown value to
 * each new value (e.g. after a scan). Fixed duration with a strong ease-out,
 * whatever the size. Reduced motion (OS or the in-app pref, via AppShell's
 * MotionConfig) shows the value at once. The text is written imperatively, so the span has no React
 * children. Never feed a non-number here.
 */
export function AnimatedNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const reduce = useReducedMotionConfig();

  // First text before paint, so the span is never empty.
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = fmt.format(reduce ? value : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      shown.current = value;
      el.textContent = fmt.format(value);
      return;
    }
    const controls = animate(shown.current, value, {
      duration: 0.8,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: (v) => {
        shown.current = v;
        el.textContent = fmt.format(Math.round(v) || 0); // `|| 0` turns -0 into 0
      },
    });
    return () => controls.stop();
  }, [value, reduce]);

  return <span ref={ref} className="tabular-nums" />;
}
