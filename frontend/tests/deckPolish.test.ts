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
    expect(player).toContain('"rounded-tl-xl border-l pl-7 pr-8"');
    expect(player).toContain('"rounded-tr-xl border-r pr-7 pl-4 xl:pl-8"');
    expect(dock).not.toMatch(/cm-mixer-enter[^"]*border-x/);
  });

  test("the mixer is 308 px with every control kept, and keeps 16 px free under each VU for the headphone-cue button", () => {
    expect(dock).toContain('"cm-mixer-enter relative z-10 flex w-77 shrink-0 flex-col justify-center gap-1 px-1.5 py-1.5"');
    const order = ['label="CUE GAIN"', "<QuantizeChip />", 'label="CUE MIX"', '<DeckHalf deck="A"', '<DeckHalf deck="B"', 'aria-label="Crossfader"'].map(part => dock.indexOf(part, dock.indexOf("function MixerStrip")));
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]))).toBe(true);
    // Outer edge to centre: the EQ column (HIGH above MID above LOW), TRIM above FILTER, the VU and its free 16 px, the fader.
    const half = dock.slice(dock.indexOf("function DeckHalf"), dock.indexOf("function QuantizeChip"));
    const knobs = ['label="HIGH"', 'label="MID"', 'label="LOW"', 'label="TRIM"', 'label="FILTER"', "<VuMeter", "data-pfl-space", "<VolumeFader"].map(part => half.indexOf(part));
    expect(knobs.every((at, i) => at > -1 && (i === 0 || at > knobs[i - 1]))).toBe(true);
    // Room only: no button is drawn before the headphone output exists.
    expect(half).toContain('<span aria-hidden data-pfl-space className="h-4 w-6 shrink-0" />');
    expect(dock).not.toContain("Στα ακουστικά\"");
  });

  test("knobs are half again as large: three 47 px rows (36 px knob, 13 px name) per mixer column, 21 px headphone knobs, a 36 px WET", () => {
    const half = dock.slice(dock.indexOf("function DeckHalf"), dock.indexOf("function QuantizeChip"));
    expect(half).toContain('"flex w-9 flex-col items-center justify-between [--cm-knob:clamp(16px,calc((100cqh-4px)/3-11px),36px)]"');
    expect(half.match(/className=\{column\}/g)).toHaveLength(2);
    expect(dock).toContain('<div className="flex items-center justify-between [--cm-knob:21px]">');
    expect(read("../src/components/FxRackRow.tsx")).toContain('"shrink-0 [--cm-knob:36px]"');
    const knob = read("../src/components/ui/Knob.tsx");
    expect(knob).toContain("font-mono text-[13px] font-semibold leading-none");
    expect(knob).toContain("flex h-4 -translate-x-1/2");
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
