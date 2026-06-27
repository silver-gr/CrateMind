import { type HTMLAttributes, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";
import { usePref } from "../../lib/prefs";

/**
 * Interactive glass surface with a subtle hover lift. With `spotlight`, a
 * cursor-following radial cm-cyan glow is layered on top (react-bits
 * SpotlightCard technique). The spotlight is suppressed under reduced-motion.
 */
export function GlassCard({
  className,
  interactive,
  spotlight,
  children,
  onMouseMove,
  onMouseEnter,
  onMouseLeave,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean; spotlight?: boolean }) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const ref = useRef<HTMLDivElement>(null);
  const [glow, setGlow] = useState({ x: 0, y: 0, o: 0 });
  const useSpot = !!spotlight && !osReduce && !prefReduce;

  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        if (useSpot && ref.current) {
          const r = ref.current.getBoundingClientRect();
          setGlow((g) => ({ ...g, x: e.clientX - r.left, y: e.clientY - r.top }));
        }
        onMouseMove?.(e);
      }}
      onMouseEnter={(e) => {
        if (useSpot) setGlow((g) => ({ ...g, o: 1 }));
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (useSpot) setGlow((g) => ({ ...g, o: 0 }));
        onMouseLeave?.(e);
      }}
      className={cn(
        "glass rounded-2xl",
        spotlight && "relative overflow-hidden",
        interactive &&
          "cursor-pointer transition duration-200 hover:-translate-y-0.5 hover:border-cm-cyan/30",
        className,
      )}
      {...props}
    >
      {useSpot && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{
            opacity: glow.o,
            background: `radial-gradient(220px circle at ${glow.x}px ${glow.y}px, rgba(0, 224, 245, 0.12), transparent 70%)`,
          }}
        />
      )}
      {children}
    </div>
  );
}
