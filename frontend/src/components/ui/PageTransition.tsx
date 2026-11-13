import type { ReactNode } from "react";
import { motion, useReducedMotionConfig } from "motion/react";

/** Page enter: fade + 8px lift on the compositor (full transform string, so Motion can hand it to WAAPI).
 *  Off under reduced motion, OS or in-app (AppShell's MotionConfig). `transitionEnd` clears the transform so
 *  this wrapper never becomes the containing block for `position: fixed` children. */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotionConfig();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, transform: "translateY(8px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)", transitionEnd: { transform: "none" } }}
      transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
