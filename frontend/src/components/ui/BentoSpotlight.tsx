import { type ReactNode, useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "motion/react";
import { usePref } from "../../lib/prefs";

/**
 * Coordinated grid spotlight — forked from react-bits MagicBento (GlobalSpotlight
 * + border-glow only; tilt/particles/magnetism/aspect dropped). A cursor-following
 * glow sweeps the grid and lights each `.bento-card`'s border by proximity.
 * Themed to cm-cyan; suppressed under reduced-motion.
 *
 * Children must be `.bento-card` tiles (give them `rounded-2xl` so the glow ring
 * matches their corners). Wrap the existing grid; pass the grid classes as `className`.
 */
const GLOW = "0, 224, 245"; // cm-cyan sRGB
const RADIUS = 320;

function GlobalSpotlight({
  gridRef,
  disabled,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
}) {
  useEffect(() => {
    if (disabled || !gridRef.current) return;

    const spotlight = document.createElement("div");
    spotlight.style.cssText = `
      position: fixed; width: 720px; height: 720px; border-radius: 50%;
      pointer-events: none; z-index: 200; opacity: 0;
      transform: translate(-50%, -50%); mix-blend-mode: screen;
      background: radial-gradient(circle,
        rgba(${GLOW}, 0.12) 0%, rgba(${GLOW}, 0.06) 18%, rgba(${GLOW}, 0.03) 35%,
        rgba(${GLOW}, 0.015) 55%, transparent 70%);
    `;
    document.body.appendChild(spotlight);

    const proximity = RADIUS * 0.5;
    const fadeDistance = RADIUS * 0.75;

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
        gsap.to(spotlight, { opacity: 0, duration: 0.3, ease: "power2.out" });
        cards.forEach((c) => c.style.setProperty("--glow-intensity", "0"));
        return;
      }

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
        card.style.setProperty("--glow-radius", `${RADIUS}px`);
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
      gridRef.current
        ?.querySelectorAll<HTMLElement>(".bento-card")
        .forEach((c) => c.style.setProperty("--glow-intensity", "0"));
      gsap.to(spotlight, { opacity: 0, duration: 0.3, ease: "power2.out" });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      spotlight.parentNode?.removeChild(spotlight);
    };
  }, [gridRef, disabled]);

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
  const disabled = osReduce || prefReduce;
  const gridRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bento-section relative">
      <GlobalSpotlight gridRef={gridRef} disabled={disabled} />
      <div ref={gridRef} className={className}>
        {children}
      </div>
      {!disabled && (
        <style>{`
          .bento-section { --glow-x:50%; --glow-y:50%; --glow-intensity:0; --glow-radius:${RADIUS}px; }
          .bento-card { position: relative; }
          .bento-card::after {
            content:''; position:absolute; inset:0; padding:1.5px; border-radius:inherit;
            background: radial-gradient(var(--glow-radius) circle at var(--glow-x) var(--glow-y),
              rgba(${GLOW}, calc(var(--glow-intensity) * 0.7)) 0%,
              rgba(${GLOW}, calc(var(--glow-intensity) * 0.3)) 35%, transparent 65%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: xor;
            mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            mask-composite: exclude;
            pointer-events:none; z-index:2; transition: opacity .3s ease;
          }
        `}</style>
      )}
    </div>
  );
}
