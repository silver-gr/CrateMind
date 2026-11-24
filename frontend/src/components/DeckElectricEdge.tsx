import { ElectricFrame } from "./ui/ElectricFrame";
import { usePref } from "../lib/prefs";
import type { DeckId } from "../lib/player";

/** Hex fallbacks of --cm-deck-a / --cm-deck-b (styles/deck.css), used only where no canvas can resolve the token. */
const DECK_FALLBACK = {
  A: { dark: "#00e0f5", light: "#00639a" },
  B: { dark: "#60ee53", light: "#00700f" },
} as const;

/** How far the frame runs past the deck's bottom and outer (window-side) edges, so those sides and their corners fall outside the clip. */
const RUN_OFF = 24;
/** How far the glow may paint past the deck. The frame's blurred layer is scaled to 110%, so on a wide deck it reaches about 150px. */
const GLOW_REACH = 160;

/**
 * Where the playing deck's edge may paint, relative to the overlay: only the top and the mixer side. The bottom and the
 * outer side are cut at the deck's own edges; the glow fades out on its own above the deck and under the mixer (z-10, so it sits on top),
 * and the top is cut just past the stroke when the waveform panel sits right above the dock.
 */
export function deckEdgeClip(deck: DeckId, panelBelowDock: boolean): string {
  const top = panelBelowDock ? "-5px" : `-${GLOW_REACH}px`;
  return deck === "A" ? `inset(${top} -${GLOW_REACH}px ${RUN_OFF}px ${RUN_OFF}px)` : `inset(${top} ${RUN_OFF}px ${RUN_OFF}px -${GLOW_REACH}px)`;
}

/**
 * Two-deck electric border in the deck colour, lit while the deck plays. Always mounted as a decorative overlay
 * inside the deck root (never a wrapper: the root holds the deck's <audio>), behind the deck's content and badge.
 * It traces the deck's own top and inner borders (-1px puts the stroke on the border line; the inner top corner is rounded-xl).
 */
export function DeckElectricEdge({ deck, active }: { deck: DeckId; active: boolean }) {
  const [deckViewPosition] = usePref("deckViewPosition");
  const box = deck === "A" ? { top: -1, right: -1, bottom: -RUN_OFF, left: -RUN_OFF } : { top: -1, left: -1, bottom: -RUN_OFF, right: -RUN_OFF };
  return (
    <div aria-hidden data-deck-electric-edge={deck} className="pointer-events-none absolute -z-10" style={{ ...box, clipPath: deckEdgeClip(deck, deckViewPosition === "bottom") }}>
      {/* The big outward glow: an outer box-shadow paints only outside the box, so it does not tint the deck's own glass. */}
      <div className="absolute inset-0 rounded-[12px] transition-opacity duration-300 ease-out"
        style={{ opacity: active ? 1 : 0, boxShadow: `0 0 60px 10px color-mix(in oklch, var(${deck === "A" ? "--cm-deck-a" : "--cm-deck-b"}) 65%, transparent)` }} />
      <ElectricFrame
        token={deck === "A" ? "--cm-deck-a" : "--cm-deck-b"}
        fallback={DECK_FALLBACK[deck]}
        borderRadius={12}
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
