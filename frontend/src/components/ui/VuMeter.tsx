import { useEffect, useRef } from "react";
import { deckLevelNow } from "@/lib/deckTelemetry";

/** Vertical green→amber→red level meter. Painted by rAF straight onto a ref (no React state, no transitions).
 *  The gradient layer is clipped to the level over a dark track. (A dark cover scaled over a gradient
 *  background let the gradient bleed through the antialiased rounded corners: red/green specks at rest.) */
export function VuMeter({ deck, className = "" }: { deck: "A" | "B"; className?: string }) {
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const tick = () => {
      const clip = `inset(${((1 - deckLevelNow(deck)) * 100).toFixed(2)}% 0 0 0)`;
      if (fill.current && clip !== last) fill.current.style.clipPath = last = clip;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <div role="img" aria-label={`VU Deck ${deck}`}
      className={`relative w-2 overflow-hidden rounded-[2px] bg-cm-bg-2 ${className}`}>
      <div ref={fill} className="absolute inset-0 bg-gradient-to-t from-emerald-500 via-cm-amber to-rose-500" style={{ clipPath: "inset(100% 0 0 0)" }} />
      <div aria-hidden className="cm-vu-segments pointer-events-none absolute inset-0" />
    </div>
  );
}
