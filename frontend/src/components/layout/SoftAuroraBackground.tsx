import { useReducedMotion } from "motion/react";
import SoftAurora from "../SoftAurora";
import { usePref } from "../../lib/prefs";

/**
 * Global animated aurora backdrop — fixed, behind everything, pointer-events-none.
 * Replaces the old `.cm-aurora` grid+orbs CSS background.
 *
 * Reduced-motion (OS `prefers-reduced-motion` OR the in-app `reduceMotion` pref)
 * → render the static `.cm-aurora` CSS fallback and DO NOT mount the WebGL canvas
 * (no GPU loop). Themed to the cm-* cyan/violet hues over the cm-bg void.
 */
export default function SoftAuroraBackground() {
  const osReduce = useReducedMotion();
  const [prefReduce] = usePref("reduceMotion");
  const reduce = osReduce || prefReduce;

  if (reduce) {
    return <div className="cm-aurora" aria-hidden />;
  }

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 bg-cm-bg">
      <SoftAurora
        color1="#06b6d4"
        color2="#10b917"
        speed={1.2}
        scale={1.5}
        brightness={0.8}
        noiseFrequency={4.5}
        noiseAmplitude={3.5}
        bandHeight={0.45}
        bandSpread={0.6}
        octaveDecay={0.36}
        layerOffset={0.75}
        colorSpeed={1}
        enableMouseInteraction={false}
        mouseInfluence={0.1}
      />
    </div>
  );
}
