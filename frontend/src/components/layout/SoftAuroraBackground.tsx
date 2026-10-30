import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import SoftAurora from "../SoftAurora";
import { usePref } from "../../lib/prefs";
import { useTheme } from "../../lib/theme";
import { isBackgroundId, type BackgroundId } from "../backgrounds/backgrounds";
import "../backgrounds/Backgrounds.css";

// Only the selected renderer is downloaded and mounted. The original Soft Aurora
// stays the default; each optional choice is the corresponding React Bits source.
const Scanner = lazy(() => import("../backgrounds/Scanner"));
const Grainient = lazy(() => import("../backgrounds/Grainient"));
const Threads = lazy(() => import("../backgrounds/Threads"));
const Particles = lazy(() => import("../backgrounds/Particles"));
const Aurora = lazy(() => import("../backgrounds/Aurora"));
const PrismaticBurst = lazy(() => import("../backgrounds/PrismaticBurst"));
const FaultyTerminal = lazy(() => import("../backgrounds/FaultyTerminal"));
const Iridescence = lazy(() => import("../backgrounds/Iridescence"));

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
  // Preserve requested props; cap DPR/fps during audio playback. Iridescence
  // observes pointer movement passively without intercepting foreground controls.
  switch (background) {
    case "iridescence": return <Iridescence color="#ffffff" hueShift={-119} saturation={1.45} brightness={1} contrast={1} speed={0.75} scale={0.4} detail={8} warp={1.1} rotation={-55} mouseReact amplitude={0} stir={1.55} sheen={0.35} clickSwirl={false} grain={0.45} fade={0} />;
    case "scanner": return <Scanner color1="#06b6d4" color2="#8b5cf6" color3="#b9e54c" speed={0.16} sweepSpeed={0.10} bandDensity={16} lineWidth={1.8} sweepWidth={2.5} trail={0.8} brightness={1.15} scanline={false} grainIntensity={0.025} mouseInteraction={false} clickEffect="none" intro={false} lightMode={light} dpr={1} />;
    case "grainient": return <Grainient colors={["#071318", "#0e7490", "#2dd4bf", "#ccfbf1"]} angle={144} flow={0} bands={1} softness={1} silk={0.35} grainAmount={0.08} grainSize={1.2} grainAnimated={false} speed={0} interactive={false} clickSwirl={false} intro={false} lightMode={light} dpr={1} />;
    case "grainient-aurora": return <Grainient colors={["#05110f", "#065f46", "#34d399", "#ecfccb"]} angle={100} flow={1.1} bands={3} softness={1} silk={0.6} grainAmount={0.08} grainSize={1.2} grainAnimated speed={1} interactive={false} clickSwirl={false} intro={false} lightMode={light} dpr={1} />;
    case "threads": return <Threads color={light ? "#087e96" : "#06b6d4"} accentColor={light ? "#7a56bb" : "#b9e54c"} lineCount={90} amplitude={1.5} distance={1.1} speed={0.16} thickness={1.1} waves={3} enableMouseInteraction={false} parting={0} brightness={1.1} />;
    case "particles": return <Particles particleCount={600} particleColors={light ? ["#087e96", "#809e26", "#7951c7"] : ["#06b6d4", "#b9e54c", "#a78bfa"]} speed={0.16} particleSpread={6} cameraDistance={30} particleBaseSize={4} sizeRandomness={0} alphaParticles moveParticlesOnHover={false} clickBurst={false} connections={false} intro={false} glow={0.35} twinkle={0.15} pixelRatio={1} lightMode={light} />;
    case "aurora": return <Aurora colorStops={["#06b6d4", "#b9e54c", "#8b5cf6"]} speed={0.18} amplitude={0.8} height={0.45} blend={0.65} layers={1} brightness={0.8} mouseInteraction={false} intro={false} lightMode={light} dpr={1} />;
    case "prismatic-burst": return <PrismaticBurst colors={[]} animationType="rotate3d" intensity={2.75} speed={0.7} zoom={1.65} rayWidth={1.45} twist={-0.95} mouseInteraction={false} clickBurst intro rayCount={6} distort={3.1} flow={0.7} centerFade={1.15} glow={0.55} grain={0.75} mouseStrength={0.6} fade={0.25} lightMode={light} dpr={1} />;
    case "faulty-terminal": return <FaultyTerminal tint="#26b910" glyphs="characters" scale={3.3} digitSize={1.25} timeScale={0.35} brightness={0.55} glow={0.6} persistence={0.5} mouseStrength={0.5} mouseGlow={0.6} curvature={0.15} vignette={0.25} clickEffect="glitch" scramble={0.6} scanlineIntensity={0.75} glitchAmount={3} flickerAmount={1.7} noiseAmp={1.3} chromaticAberration={3.1} mouseReact={false} lightMode={light} dpr={1} />;
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
