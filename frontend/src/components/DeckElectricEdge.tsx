import { ElectricFrame } from "./ui/ElectricFrame";
import { usePref } from "../lib/prefs";
import type { DeckId } from "../lib/player";

/** Hex fallbacks of --cm-deck-a / --cm-deck-b (styles/deck.css), used only where no canvas can resolve the token. */
const DECK_FALLBACK = {
  A: { dark: "#00e0f5", light: "#00639a" },
  B: { dark: "#60ee53", light: "#00700f" },
} as const;

/**
 * Where the playing deck's glow may paint, relative to the inset-1 overlay: up to 72px out, except the mixer side,
 * which is cut at the deck's own edge (-4px, so the stroke stays whole), and the top when the waveform panel sits right above the dock.
 */
export function deckEdgeClip(deck: DeckId, panelBelowDock: boolean): string {
  const top = panelBelowDock ? "-4px" : "-72px";
  return deck === "A" ? `inset(${top} -4px -72px -72px)` : `inset(${top} -72px -72px -4px)`;
}

/**
 * Two-deck electric border in the deck colour, lit while the deck plays. Always mounted as a decorative overlay
 * inside the deck root (never a wrapper: the root holds the deck's <audio>), behind the deck's content and badge.
 */
export function DeckElectricEdge({ deck, active }: { deck: DeckId; active: boolean }) {
  const [deckViewPosition] = usePref("deckViewPosition");
  return (
    <div aria-hidden data-deck-electric-edge={deck} className="pointer-events-none absolute inset-1 -z-10" style={{ clipPath: deckEdgeClip(deck, deckViewPosition === "bottom") }}>
      {/* The big outward glow: an outer box-shadow paints only outside the box, so it does not tint the deck's own glass. */}
      <div className="absolute inset-0 rounded-[10px] transition-opacity duration-300 ease-out"
        style={{ opacity: active ? 1 : 0, boxShadow: `0 0 60px 10px color-mix(in oklch, var(${deck === "A" ? "--cm-deck-a" : "--cm-deck-b"}) 65%, transparent)` }} />
      <ElectricFrame
        token={deck === "A" ? "--cm-deck-a" : "--cm-deck-b"}
        fallback={DECK_FALLBACK[deck]}
        borderRadius={10}
        lineWidth={2.5}
        glow={0.22}
        octaves={4}
        sampleSpacing={4}
        maxFps={30}
        active={active}
        className="h-full w-full"
      />
    </div>
  );
}
