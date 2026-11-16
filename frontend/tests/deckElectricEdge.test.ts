import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deckEdgeClip } from "../src/components/DeckElectricEdge";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("playing deck electric edge", () => {
  test("only the top and the mixer side show: bottom and window side are cut at the deck edge, the glow runs under the mixer", () => {
    expect(deckEdgeClip("A", false)).toBe("inset(-72px -72px 24px 24px)");
    expect(deckEdgeClip("B", false)).toBe("inset(-72px 24px 24px -72px)");
  });

  test("with the waveform panel right above the dock, the top is cut just past the stroke", () => {
    expect(deckEdgeClip("A", true)).toBe("inset(-5px -72px 24px 24px)");
    expect(deckEdgeClip("B", true)).toBe("inset(-5px 24px 24px -72px)");
  });

  test("the overlay is a sibling inside the deck root after <audio>, never a wrapper, and the mixer stays above it", () => {
    const player = read("../src/components/MiniPlayer.tsx");
    expect(player).toMatch(/\{audio\}[\s\S]{0,600}\{twoDeck && <DeckElectricEdge deck=\{deck\} active=\{playing && !error\} \/>\}/);
    expect(player).not.toContain("var(--deck)_30%");
    expect(read("../src/components/DeckDock.tsx")).toContain("cm-mixer-enter relative z-10");
    expect(read("../src/components/layout/AppShell.tsx")).toContain("relative flex h-full flex-col overflow-clip");
  });

  test("toggling active only starts or stops the loop; setup never depends on it", () => {
    const border = read("../src/components/ElectricBorder.tsx");
    expect(border).toContain("}, [color, speed, chaos, borderRadius, lineWidth, octaves, sampleSpacing, maxFps, octavedNoise, getRoundedRectPoint]);");
    expect(border).toContain("if (animationRef.current || !visible || !activeRef.current) return;");
  });
});
