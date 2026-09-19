import { type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import ElectricBorder from "../ElectricBorder";
import { usePref } from "../../lib/prefs";

/**
 * Animated electric energy frame (react-bits ElectricBorder) for the flagship
 * hero. Reduced-motion (OS or pref) → a static themed glow border instead of the
 * RAF-driven canvas. `borderRadius` must match the wrapped surface (hero = 16).
 */
export function ElectricFrame({
  children,
  color = "#b1ef4a", // cm-chartreuse
  borderRadius = 16,
  className,
}: {
  children: ReactNode;
  color?: string;
  borderRadius?: number;
  className?: string;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");

  if (osReduce || prefReduce) {
    return (
      <div
        className={className}
        style={{
          borderRadius,
          border: `1px solid ${color}55`,
          boxShadow: `0 0 22px -8px ${color}88`,
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <ElectricBorder
      color={color}
      borderRadius={borderRadius}
      speed={0.7}
      chaos={0.08}
      className={className}
    >
      {children}
    </ElectricBorder>
  );
}
