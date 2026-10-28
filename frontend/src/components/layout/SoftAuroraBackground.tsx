import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import SoftAurora from "../SoftAurora";
import { usePref } from "../../lib/prefs";
import { useTheme } from "../../lib/theme";
import { isBackgroundId, type BackgroundId } from "../backgrounds/backgrounds";
import "../backgrounds/Backgrounds.css";

// Only the selected renderer is downloaded and mounted. The original Soft Aurora
// stays the default; each optional choice is the corresponding React Bits source.
const Scanner = lazy(() => import("../backgrounds/Scanner"));
const Ferrofluid = lazy(() => import("../backgrounds/Ferrofluid"));
const Grainient = lazy(() => import("../backgrounds/Grainient"));
const Threads = lazy(() => import("../backgrounds/Threads"));
const Particles = lazy(() => import("../backgrounds/Particles"));
const Aurora = lazy(() => import("../backgrounds/Aurora"));

function StaticBackground({ reason }: { reason: string }) {
  return <div className="cm-background-static" data-background-fallback={reason} />;
}

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <StaticBackground reason="renderer-error" /> : this.props.children;
  }
}

function SelectedRenderer({ background, light }: { background: BackgroundId; light: boolean }) {
  // Full-screen decoration needs no pointer interactions or introductory effects.
  // DPR 1 plus a 30fps source cap bounds background work during audio playback.
  switch (background) {
    case "scanner": return <Scanner color1="#06b6d4" color2="#8b5cf6" color3="#b9e54c" speed={0.16} sweepSpeed={0.10} bandDensity={8} scanline={false} grainIntensity={0.025} mouseInteraction={false} clickEffect="none" intro={false} lightMode={light} dpr={1} />;
    case "ferrofluid": return <Ferrofluid colors={["#dff1ff", "#67cde5", "#aaa0ee"]} brightness={0.85} scale={1.6} spikeHeight={1} sharpness={2.5} tilt={48} turbulence={1} fluidity={0.5} speed={0.24} magnetism={1} flowDirection="down" mouseInteraction={false} clickPulse={false} intro={false} lightMode={light} color={light ? "#f4f6fa" : "#0d0b19"} dpr={1} />;
    case "grainient": return <Grainient colors={["#111127", "#0e7490", "#2dd4bf", "#ccfbf1"]} angle={144} flow={0} bands={1} softness={1} silk={0.35} grainAmount={0.08} grainSize={1.2} grainAnimated={false} speed={0} interactive={false} clickSwirl={false} intro={false} lightMode={light} dpr={1} />;
    case "threads": return <Threads color={light ? "#087e96" : "#06b6d4"} accentColor={light ? "#7a56bb" : "#b9e54c"} lineCount={24} amplitude={0.8} distance={0.35} speed={0.16} thickness={1.1} waves={3} enableMouseInteraction={false} parting={0} brightness={0.8} />;
    case "particles": return <Particles particleCount={90} particleColors={light ? ["#087e96", "#809e26", "#7951c7"] : ["#06b6d4", "#b9e54c", "#a78bfa"]} speed={0.16} particleSpread={10} particleBaseSize={65} alphaParticles moveParticlesOnHover={false} clickBurst={false} connections={false} intro={false} glow={0.25} twinkle={0.15} pixelRatio={1} lightMode={light} />;
    case "aurora": return <Aurora colorStops={["#06b6d4", "#b9e54c", "#8b5cf6"]} speed={0.18} amplitude={0.8} height={0.45} blend={0.65} layers={1} brightness={0.8} mouseInteraction={false} intro={false} lightMode={light} dpr={1} />;
    default: return <SoftAurora color1="#06b6d4" color2="#b9e54c" speed={0.35} scale={1.5} brightness={0.8} noiseFrequency={4.5} noiseAmplitude={3.5} bandHeight={0.45} bandSpread={0.6} octaveDecay={0.36} layerOffset={0.75} colorSpeed={1} enableMouseInteraction={false} mouseInfluence={0.1} />;
  }
}

function GuardedRenderer({ background, light }: { background: BackgroundId; light: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const container = ref.current;
    const onLost = (event: Event) => { event.preventDefault(); setLost(true); };
    // Context loss does not bubble; capture observes every selected canvas.
    container?.addEventListener("webglcontextlost", onLost, true);
    return () => container?.removeEventListener("webglcontextlost", onLost, true);
  }, []);
  return (
    <div ref={ref} className="cm-background-renderer">
      {lost ? <StaticBackground reason="context-lost" /> : (
        <RendererBoundary>
          <Suspense fallback={<StaticBackground reason="loading" />}>
            <SelectedRenderer background={background} light={light} />
          </Suspense>
        </RendererBoundary>
      )}
    </div>
  );
}

/** Global decorative background, shared by web and desktop. */
export default function SoftAuroraBackground() {
  const [osReduce, setOsReduce] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [prefReduce] = usePref("reduceMotion");
  const [selected] = usePref("background");
  const [theme] = useTheme();
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setOsReduce(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const background = isBackgroundId(selected) ? selected : "soft-aurora";
  const reduce = Boolean(osReduce || prefReduce);
  return (
    <div aria-hidden className="cm-background" data-background={background}>
      {reduce || !visible ? <StaticBackground reason={reduce ? "reduced-motion" : "page-hidden"} /> : <GuardedRenderer key={background} background={background} light={theme === "light"} />}
    </div>
  );
}
