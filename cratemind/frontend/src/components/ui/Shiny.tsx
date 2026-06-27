import ShinyText from "../ShinyText";
import { useReducedMotion } from "motion/react";
import { usePref } from "../../lib/prefs";

/**
 * Metallic sheen text (react-bits ShinyText), reduced-motion aware + themed.
 * `color` defaults to cm-text (NOT ShinyText's gray default) so contrast holds;
 * the sheen is cm-cyan. Under reduced-motion the sheen is frozen (text = color).
 */
export function Shiny({
  text,
  className,
  color = "var(--color-cm-text)",
  shineColor = "var(--color-cm-cyan)",
  speed,
}: {
  text: string;
  className?: string;
  color?: string;
  shineColor?: string;
  speed?: number;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  // Reduced-motion: plain text — no frameloop, no background-clip dependency.
  if (osReduce || prefReduce) {
    return (
      <span className={className} style={{ color }}>
        {text}
      </span>
    );
  }
  return (
    <ShinyText text={text} className={className} color={color} shineColor={shineColor} speed={speed} />
  );
}
