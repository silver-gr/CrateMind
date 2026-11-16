import { type ReactNode, useMemo } from "react";
import { useReducedMotion } from "motion/react";
import ElectricBorder from "../ElectricBorder";
import { usePref } from "../../lib/prefs";
import { useTheme } from "../../lib/theme";

/**
 * Animated electric energy frame (react-bits ElectricBorder) for the flagship
 * hero. Reduced-motion (OS or pref) → a static themed glow border instead of the
 * RAF-driven canvas. `borderRadius` must match the wrapped surface (hero = 16).
 * It follows a theme token (default --cm-chartreuse), resolved to a hex
 * on each theme change (ElectricBorder needs a hex for hexToRgba). The fallbacks
 * (default Night #b1ef4a, Solar #2d7000) only apply where no canvas is available.
 * `active` fades the frame in and out; the decks pass their colour token and a thicker line.
 */
function resolveToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  try {
    const token = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
  token = "--cm-chartreuse",
  fallback = { dark: "#b1ef4a", light: "#2d7000" },
  lineWidth,
  glow = 0.3,
  octaves,
  active = true,
  sampleSpacing,
  maxFps,
}: {
  children?: ReactNode;
  borderRadius?: number;
  className?: string;
  token?: string;
  fallback?: { dark: string; light: string };
  lineWidth?: number;
  glow?: number;
  octaves?: number;
  active?: boolean;
  sampleSpacing?: number;
  maxFps?: number;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const [theme] = useTheme();
  // setTheme toggles the <html> class before notifying listeners, so the token is current here.
  const fallbackHex = theme === "light" ? fallback.light : fallback.dark;
  const tone = useMemo(() => resolveToken(token, fallbackHex), [token, fallbackHex, theme]);

  if (osReduce || prefReduce) {
    return (
      <div
        className={className}
        style={{
          borderRadius,
          // Inactive fades only the border and glow, never the children.
          border: `${lineWidth ?? 1}px solid ${active ? `${tone}55` : "transparent"}`,
          boxShadow: `0 0 ${Math.round((22 * glow) / 0.3)}px -8px ${active ? `${tone}88` : "transparent"}`,
          transition: "border-color 300ms ease, box-shadow 300ms ease",
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
      lineWidth={lineWidth}
      glow={glow}
      octaves={octaves}
      active={active}
      sampleSpacing={sampleSpacing}
      maxFps={maxFps}
    >
      {children}
    </ElectricBorder>
  );
}
