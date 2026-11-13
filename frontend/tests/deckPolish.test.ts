import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const pads = read("../src/components/CuePads.tsx");
const player = read("../src/components/MiniPlayer.tsx");
const dock = read("../src/components/DeckDock.tsx");
const pitch = read("../src/components/PitchStrip.tsx");
const css = read("../src/index.css") + read("../src/styles/deck.css");

describe("deck hardware look", () => {
  test("two decks round off their inner top corner beside the mixer, which draws no side borders", () => {
    expect(player).toContain('"rounded-tl-xl border-l pl-7 pr-3 md:pr-6"');
    expect(player).toContain('"rounded-tr-xl border-r pr-7 pl-3 md:pl-6"');
    expect(dock).not.toMatch(/cm-mixer-enter[^"]*border-x/);
  });

  test("empty pads show only their number, and the settings icon appears on hover or focus", () => {
    expect(pads).not.toContain("—:—");
    expect(pads).toContain("group-hover/pad:opacity-100");
    expect(pads).toContain("focus-visible:opacity-100");
    expect(pads).toContain("[@media(hover:none)]:opacity-100");
  });

  test("faders share one cap style; bipolar ones drop the fill, and keyboard focus stays visible", () => {
    expect(dock).toContain('"cm-fader cursor-pointer"');
    expect(dock).toContain("cm-fader-bipolar");
    expect(pitch).toContain("cm-fader cm-fader-bipolar");
    expect(css).toContain('.cm-fader-bipolar [data-slot="slider-range"] { background: transparent; }');
    expect(css).toContain('.cm-fader [data-slot="slider-thumb"]:focus-visible { outline: 2px solid var(--cm-cyan);');
  });

  test("deck colour runs through the mixer: knob arcs, fader caps and crossfader ends", () => {
    expect(read("../src/components/ui/Knob.tsx")).toContain("stroke-[var(--deck,var(--cm-cyan))]");
    expect(css).toContain("var(--deck, var(--cm-cyan))");
    expect(dock).toContain("cm-fader-xfade");
    expect(dock).toContain('"--deck"');
  });
});
