import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Subtle page-enter fade + lift. No-ops under prefers-reduced-motion. */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.16, ease: "easeOut" }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
