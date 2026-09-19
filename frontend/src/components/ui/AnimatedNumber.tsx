import { useReducedMotion } from "motion/react";
import CountUp from "../CountUp";
import { usePref } from "../../lib/prefs";

/**
 * Animated count-up for a numeric stat. Reduced-motion (OS or in-app pref) →
 * render the final value instantly (Greek-grouped). Never feed a non-number here.
 */
export function AnimatedNumber({
  value,
  className,
  duration = 1.2,
}: {
  value: number;
  className?: string;
  duration?: number;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  if (osReduce || prefReduce) {
    return <span className={className}>{value.toLocaleString("el-GR")}</span>;
  }
  return <CountUp to={value} separator="." duration={duration} className={className} />;
}
