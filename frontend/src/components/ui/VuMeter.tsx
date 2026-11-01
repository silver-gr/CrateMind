import { useEffect, useRef } from "react";
import { deckLevelNow } from "@/lib/deckTelemetry";

/** Vertical green→amber→red level meter. Painted by rAF straight onto a ref (no React state, no transitions). */
export function VuMeter({ deck, className = "" }: { deck: "A" | "B"; className?: string }) {
  const cover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (cover.current) cover.current.style.transform = `scaleY(${1 - deckLevelNow(deck)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck]);
  return (
    <div role="img" aria-label={`VU Deck ${deck}`}
      className={`relative w-2 overflow-hidden rounded-[2px] bg-gradient-to-t from-emerald-500 via-cm-amber to-rose-500 ${className}`}>
      <div ref={cover} className="absolute inset-0 origin-top bg-cm-bg-2" style={{ transform: "scaleY(1)" }} />
    </div>
  );
}
