import { type ReactNode, useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "motion/react";
import { usePref } from "../../lib/prefs";
import { type Theme, useTheme } from "../../lib/theme";

/**
 * Coordinated grid spotlight — forked from react-bits MagicBento (GlobalSpotlight
 * + border-glow only; tilt/particles/magnetism/aspect dropped). A cursor-following
 * glow sweeps the grid and lights each `.bento-card`'s border by proximity.
 * Themed to cm-cyan through the token (no copied hex); suppressed under reduced-motion.
 * The border-glow CSS lives in styles/dashboard.css (`.bento-section[data-glow]`).
 *
 * Children must be `.bento-card` tiles (give them `rounded-2xl` so the glow ring
 * matches their corners). Wrap the existing grid; pass the grid classes as `className`.
 */
const RADIUS = 320; // keep in sync with --glow-radius in styles/dashboard.css
/** cm-cyan at an alpha, resolved from the live token so it follows the theme. */
const cyan = (alpha: number) => `oklch(from var(--cm-cyan) l c h / ${alpha})`;

function GlobalSpotlight({
  gridRef,
  disabled,
  theme,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  theme: Theme;
}) {
  useEffect(() => {
    if (disabled || !gridRef.current) return;

    const spotlight = document.createElement("div");
    spotlight.style.cssText = `
      position: fixed; width: 720px; height: 720px; border-radius: 50%;
      pointer-events: none; z-index: 200; opacity: 0;
      transform: translate(-50%, -50%);
      mix-blend-mode: ${theme === "light" ? "multiply" : "screen"};
      background: radial-gradient(circle,
        ${cyan(0.12)} 0%, ${cyan(0.06)} 18%, ${cyan(0.03)} 35%,
        ${cyan(0.015)} 55%, transparent 70%);
    `;
    document.body.appendChild(spotlight);

    const proximity = RADIUS * 0.5;
    const fadeDistance = RADIUS * 0.75;
    // Outside the grid, hide once and then ignore further moves (no tween per event).
    let hidden = true;

    const handleMouseMove = (e: MouseEvent) => {
      const grid = gridRef.current;
      if (!grid) return;
      const section = grid.closest(".bento-section");
      const rect = section?.getBoundingClientRect();
      const inside =
        !!rect &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      const cards = grid.querySelectorAll<HTMLElement>(".bento-card");
      if (!inside) {
        if (hidden) return;
        hidden = true;
        gsap.to(spotlight, { opacity: 0, duration: 0.3, ease: "power2.out" });
        cards.forEach((c) => c.style.setProperty("--glow-intensity", "0"));
        return;
      }
      hidden = false;

      let minDistance = Infinity;
      cards.forEach((card) => {
        const r = card.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const distance =
          Math.hypot(e.clientX - cx, e.clientY - cy) - Math.max(r.width, r.height) / 2;
        const eff = Math.max(0, distance);
        minDistance = Math.min(minDistance, eff);

        let intensity = 0;
        if (eff <= proximity) intensity = 1;
        else if (eff <= fadeDistance) intensity = (fadeDistance - eff) / (fadeDistance - proximity);

        const relX = ((e.clientX - r.left) / r.width) * 100;
        const relY = ((e.clientY - r.top) / r.height) * 100;
        card.style.setProperty("--glow-x", `${relX}%`);
        card.style.setProperty("--glow-y", `${relY}%`);
        card.style.setProperty("--glow-intensity", intensity.toString());
      });

      gsap.to(spotlight, { left: e.clientX, top: e.clientY, duration: 0.1, ease: "power2.out" });
      const targetOpacity =
        minDistance <= proximity
          ? 0.8
          : minDistance <= fadeDistance
            ? ((fadeDistance - minDistance) / (fadeDistance - proximity)) * 0.8
            : 0;
      gsap.to(spotlight, {
        opacity: targetOpacity,
        duration: targetOpacity > 0 ? 0.2 : 0.5,
        ease: "power2.out",
      });
    };

    const handleMouseLeave = () => {
      hidden = true;
      gridRef.current
        ?.querySelectorAll<HTMLElement>(".bento-card")
        .forEach((c) => c.style.setProperty("--glow-intensity", "0"));
      gsap.to(spotlight, { opacity: 0, duration: 0.3, ease: "power2.out" });
    };

    // Coalesce document-wide moves to one layout read per frame.
    let frame = 0;
    let lastEvent: MouseEvent | null = null;
    const onMove = (e: MouseEvent) => {
      lastEvent = e;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (lastEvent) handleMouseMove(lastEvent);
        });
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      if (frame) cancelAnimationFrame(frame);
      gsap.killTweensOf(spotlight);
      spotlight.parentNode?.removeChild(spotlight);
    };
  }, [gridRef, disabled, theme]);

  return null;
}

export function BentoSpotlight({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const disabled = Boolean(osReduce || prefReduce);
  const [theme] = useTheme();
  const gridRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bento-section relative" data-glow={disabled ? undefined : ""}>
      <GlobalSpotlight gridRef={gridRef} disabled={disabled} theme={theme} />
      <div ref={gridRef} className={className}>
        {children}
      </div>
    </div>
  );
}
