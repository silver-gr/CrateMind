import { type HTMLAttributes, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";
import { usePref } from "../../lib/prefs";

/**
 * Interactive glass surface with a subtle hover lift. With `spotlight`, a
 * cursor-following radial cm-cyan glow is layered on top (react-bits
 * SpotlightCard technique). The spotlight is suppressed under reduced-motion.
 * The glow is written straight to the overlay's style, so a mousemove never
 * re-renders the card; its fade is CSS hover, which v4 gates to hover devices.
 */
export function GlassCard({
  className,
  interactive,
  spotlight,
  children,
  onMouseMove,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean; spotlight?: boolean }) {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const ref = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const useSpot = !!spotlight && !osReduce && !prefReduce;

  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        if (useSpot && ref.current && spotRef.current) {
          const r = ref.current.getBoundingClientRect();
          spotRef.current.style.background = `radial-gradient(220px circle at ${e.clientX - r.left}px ${e.clientY - r.top}px, var(--cm-spotlight), transparent 70%)`;
        }
        onMouseMove?.(e);
      }}
      className={cn(
        "glass group/glass rounded-2xl",
        spotlight && "relative overflow-hidden",
        interactive && "lift cursor-pointer",
        className,
      )}
      {...props}
    >
      {useSpot && (
        <div
          ref={spotRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 ease-out group-hover/glass:opacity-100"
        />
      )}
      {children}
    </div>
  );
}
