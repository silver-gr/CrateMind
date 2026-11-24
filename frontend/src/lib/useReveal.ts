import { useLayoutEffect, type RefObject } from "react";
import { getPref } from "./prefs";

const STAGGER_MS = 50;

/**
 * Fades and lifts the scope's `[data-reveal]` blocks in, one after the other, on mount and whenever `key` changes.
 * Nothing with reduced motion (OS or pref). The blocks end on their own styles: nothing is left inline.
 */
export function useReveal(scope: RefObject<HTMLElement | null>, key?: unknown): void {
  useLayoutEffect(() => {
    if (getPref("reduceMotion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const blocks = scope.current?.querySelectorAll<HTMLElement>("[data-reveal]") ?? [];
    const runs = Array.from(blocks, (block, i) => block.animate(
      [{ offset: 0, opacity: 0, transform: "translateY(12px)" }],
      { duration: 400, delay: i * STAGGER_MS, easing: "cubic-bezier(0.215, 0.61, 0.355, 1)", fill: "backwards" },
    ));
    return () => runs.forEach(run => run.cancel());
  }, [scope, key]);
}
