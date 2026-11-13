import { type ReactNode, useMemo } from "react";
import { useReducedMotion } from "motion/react";
import ElectricBorder from "../ElectricBorder";
import { usePref } from "../../lib/prefs";
import { useTheme } from "../../lib/theme";

/**
 * Animated electric energy frame (react-bits ElectricBorder) for the flagship
 * hero. Reduced-motion (OS or pref) → a static themed glow border instead of the
 * RAF-driven canvas. `borderRadius` must match the wrapped surface (hero = 16).
 * It follows the theme's --cm-chartreuse token, resolved to a hex
 * on each theme change (ElectricBorder needs a hex for hexToRgba). The fallbacks
 * (Night #b1ef4a, Solar #2d7000) only apply where no canvas is available.
 */
function resolveChartreuse(fallback: string): string {
  if (typeof document === "undefined") return fallback;
  try {
    const token = getComputedStyle(document.documentElement).getPropertyValue("--cm-chartreuse").trim();
    const ctx = token ? document.createElement("canvas").getContext("2d") : null;
    if (!ctx) return fallback;
    ctx.fillStyle = fallback;
    ctx.fillStyle = token; // an unparsable token leaves the fallback in place
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return fallback;
  }
}

export function ElectricFrame({
  children,
  borderRadius = 16,
  className,
}: {
  children: ReactNode;
  borderRadius?: number;
  className?: string;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const [theme] = useTheme();
  // setTheme toggles the <html> class before notifying listeners, so the token is current here.
  const tone = useMemo(() => resolveChartreuse(theme === "light" ? "#2d7000" : "#b1ef4a"), [theme]);

  if (osReduce || prefReduce) {
    return (
      <div
        className={className}
        style={{
          borderRadius,
          border: `1px solid ${tone}55`,
          boxShadow: `0 0 22px -8px ${tone}88`,
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <ElectricBorder
      color={tone}
      borderRadius={borderRadius}
      speed={0.7}
      chaos={0.08}
      className={className}
    >
      {children}
    </ElectricBorder>
  );
}
