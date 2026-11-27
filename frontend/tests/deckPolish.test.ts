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
    expect(player).toContain('"rounded-tl-xl border-l pl-7 pr-4"');
    expect(player).toContain('"rounded-tr-xl border-r pr-7 pl-4"');
    // The same 12 px between the columns and 16 px outer inset at every window width; the pads take what the others leave.
    expect(player).toContain('twoDeck ? "items-stretch gap-3" :');
    expect(player).toContain('"flex h-full min-h-0 min-w-[120px] max-w-[380px] flex-[1_1_0%] items-center py-[25px]"');
    // BPM and key are in the facts row: the two-deck dock passes only the error or loading sign.
    expect(player).toContain("status={deckStatus}");
    expect(player).not.toContain("tempo={bpmKey}");
    expect(dock).not.toMatch(/cm-mixer-enter[^"]*border-x/);
  });

  test("the mixer is 250 px: a full-height knob column per deck outside, the headphone row, the channels and a short crossfader between", () => {
    expect(dock).toContain('"cm-mixer-enter relative z-10 grid w-[250px] shrink-0 grid-cols-[46px_minmax(0,1fr)_46px] grid-rows-[auto_minmax(0,1fr)_auto] gap-x-1 gap-y-1 px-1.5 py-1"');
    const mixer = dock.slice(dock.indexOf("function MixerStrip"));
    const order = ['<KnobColumn deck="A" area="[grid-area:1/1/4/2]" />', 'label="CUE GAIN"', "<QuantizeChip />", 'label="CUE MIX"', '<Channel deck="A"', '<Channel deck="B"', 'aria-label="Crossfader"', '<KnobColumn deck="B" area="[grid-area:1/3/4/4]" />'].map(part => mixer.indexOf(part));
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]))).toBe(true);
    // The knob columns run the mixer's three rows; the crossfader sits only in the middle column, under the faders, with no «A» / «B».
    expect(mixer).toContain("[grid-area:1/2] [--cm-knob:21px]");
    expect(mixer).toContain("[grid-area:2/2]");
    expect(mixer).toContain("flex h-5 items-center px-1 [grid-area:3/2]");
    expect(mixer).not.toContain('text-cm-deck-a">A<');
    expect(mixer).not.toContain('text-cm-deck-b">B<');
    // Top to bottom: TRIM, HIGH, MID, LOW, FILTER.
    const column = dock.slice(dock.indexOf("function KnobColumn"), dock.indexOf("function Channel"));
    const knobs = ['label="TRIM"', 'label="HIGH"', 'label="MID"', 'label="LOW"', 'label="FILTER"'].map(part => column.indexOf(part));
    expect(knobs.every((at, i) => at > -1 && (i === 0 || at > knobs[i - 1]))).toBe(true);
    // Outer edge to centre: the VU, its free 16 px, the fader. Room only: no button is drawn before the headphone output exists.
    const channel = dock.slice(dock.indexOf("function Channel"), dock.indexOf("function QuantizeChip"));
    const parts = ["<VuMeter", "data-pfl-space", "<VolumeFader"].map(part => channel.indexOf(part));
    expect(parts.every((at, i) => at > -1 && (i === 0 || at > parts[i - 1]))).toBe(true);
    expect(channel).toContain('<span aria-hidden data-pfl-space className="h-4 w-6 shrink-0" />');
    expect(dock).not.toContain("Στα ακουστικά\"");
  });

  test("five knobs fill the column: a row is the knob plus 9 px (30.6 px at the 208 px dock, at most 36); 21 px headphone knobs, a 36 px WET", () => {
    const column = dock.slice(dock.indexOf("function KnobColumn"), dock.indexOf("function Channel"));
    expect(column).toContain("[container-type:size] [--cm-knob:clamp(16px,calc((100cqh-45px)/5),36px)]");
    expect(column).toContain('const label = "-mt-[3px] -mb-px [@container(max-height:130px)]:hidden";');
    expect(column.match(/labelClassName=\{label\}/g)).toHaveLength(5);
    expect(column).toContain("w-[46px]");
    expect(dock).toContain('<div className="flex items-center justify-between [grid-area:1/2] [--cm-knob:21px]">');
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
