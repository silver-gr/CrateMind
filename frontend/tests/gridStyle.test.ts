import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gridColors, gridStyle, GRID_BAR_COLOR, GRID_BEAT_COLOR } from "../src/lib/gridStyle";
import { DEFAULT_PREFS } from "../src/lib/prefs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("deck beatgrid style", () => {
  test("the default grid is subtle: thin chartreuse bars, faint white beats, small dim numbers", () => {
    expect(gridStyle(false)).toEqual({
      bar: { width: 1, alpha: 0.55, halo: 0.3 },
      beat: { width: 1, alpha: 0.28, halo: 0.18 },
      phrase: { width: 1, alpha: 0.85, halo: 0.4 },
      label: { size: 9, weight: 500, alpha: 0.55, box: 0.35 },
    });
  });
  test("the strong grid is bolder but keeps the new label style", () => {
    expect(gridStyle(true)).toEqual({
      bar: { width: 2, alpha: 1, halo: 0.75 },
      beat: { width: 1, alpha: 0.75, halo: 0.5 },
      phrase: { width: 3, alpha: 1, halo: 0.85 },
      label: { size: 10, weight: 500, alpha: 0.8, box: 0.5 },
    });
  });
  test("strong is at least as strong as the default on every line field, and stronger on the alphas", () => {
    const soft = gridStyle(false), strong = gridStyle(true);
    for (const line of ["bar", "beat", "phrase"] as const) {
      expect(strong[line].width).toBeGreaterThanOrEqual(soft[line].width);
      expect(strong[line].alpha).toBeGreaterThan(soft[line].alpha);
      expect(strong[line].halo).toBeGreaterThan(soft[line].halo);
    }
    expect(strong.bar.width).toBeGreaterThan(soft.bar.width);
    expect(strong.label.alpha).toBeGreaterThan(soft.label.alpha);
    expect(strong.label.box).toBeGreaterThan(soft.label.box);
  });
  test("bars and bar numbers use the dark-theme chartreuse in both themes; beats stay white", () => {
    // The grid is light-on-black (halos, label boxes): the light theme's dark chartreuse would be unreadable on it.
    const darkToken = source("index.css").match(/--cm-chartreuse: (oklch\([^)]*\));/)?.[1];
    expect(GRID_BAR_COLOR).toBe(darkToken!);
    expect(GRID_BAR_COLOR).not.toContain("var(");
    expect(GRID_BEAT_COLOR).toBe("#ffffff");
    const wave = source("components/DeckScrollWaveform.tsx");
    expect(wave).not.toContain("#facc15");
    expect(wave).toContain("gridColors(live.current.light)");
  });
  test("the white Solar Void screen takes the light chartreuse bars and ink beats on white halos", () => {
    expect(gridColors(false)).toEqual({ bar: GRID_BAR_COLOR, beat: GRID_BEAT_COLOR, halo: "#000000" });
    const light = source("index.css").match(/\[data-theme="light"\],\s*\.light \{[\s\S]*?--cm-chartreuse: (oklch\([^)]*\));/)?.[1];
    expect(gridColors(true).bar).toBe(light!);
    expect(gridColors(true).halo).toBe("#ffffff");
  });
});

describe("waveform panel toggles", () => {
  test("both toggles default off in the prefs blob", () => {
    expect(DEFAULT_PREFS.waveformStrongGrid).toBe(false);
    expect(DEFAULT_PREFS.waveformTranslucent).toBe(false);
  });

  const wave = source("components/DeckScrollWaveform.tsx");
  test("the view toggles render once, in the centre cell of the facts row under the screen, with Greek labels and aria-pressed", () => {
    const slot = source("components/DeckViewSlot.tsx");
    const pill = slot.match(/<div data-waveform-view-toggles[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(slot).toContain("data-deck-spine");
    expect(slot).toMatch(/<div data-deck-spine[^>]*onPointerDown=\{e => e\.stopPropagation\(\)\}/);
    expect(pill).toContain('aria-label="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('title="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('aria-label="Έντονο beatgrid"');
    expect(pill).toContain('title="Έντονο beatgrid"');
    expect(pill).toContain("aria-pressed={translucent}");
    expect(pill).toContain("aria-pressed={strongGrid}");
    expect(slot.match(/data-waveform-view-toggles/g)?.length).toBe(1);
    expect(slot).toMatch(/mode === "full" && \(\s*<div data-waveform-view-toggles/);
    // The centre cell is 132 px under the playhead; the fold button stays when the lanes are folded, and the cell's
    // toggles go only where the row keeps its numbers alone.
    expect(slot).toContain('<div data-deck-spine onPointerDown={e => e.stopPropagation()} className="relative flex w-[132px] shrink-0 flex-col items-center py-[2px]">');
    expect(slot).toContain('aria-label={collapsed ? "Εμφάνιση κυματομορφών" : "Απόκρυψη κυματομορφών"}');
    expect(slot).toContain('{mode !== "compact" && (');
    expect(wave).not.toContain("Διαφανές πάνελ κυματομορφών\"");
    expect(wave).not.toContain('aria-label="Έντονο beatgrid"');
    expect(wave).not.toContain("setStrongGrid");
    expect(wave).not.toContain("setTranslucent");
  });
  test("both lanes stack in one dark screen; only B draws the seam", () => {
    const slot = source("components/DeckViewSlot.tsx");
    expect(wave).not.toContain("data-deck-wave-top-border");
    expect(slot).toContain("data-deck-screen");
    expect(slot).toContain("shadow-[inset_0_1px_0_var(--cm-wave-seam)]");
    expect(slot).not.toContain("data-deck-info-slot"); // each deck's info lives in the dock
    expect(source("components/MiniPlayer.tsx")).toMatch(/twoDeck && <DeckHeader[\s\S]{0,400}coverSize=\{coverSize\}/);
    expect(slot).toContain("[&:has(>[data-deck-scroll-waveform])>[data-deck-empty]]:hidden");
    expect(source("components/MiniPlayer.tsx")).toMatch(/edge=\{deck === "A" \? "top" : "bottom"\}/);
  });
  test("pad number digits are black on the dark screen and white on the white Solar Void screen, where the pads keep their deep hues", () => {
    expect(wave).toContain('ctx.fillStyle = L.light ? "#ffffff" : "#000000";');
    expect(source("styles/deck.css")).not.toContain('[data-theme="light"] [data-deck-screen]');
  });
  test("the playhead is cyan, and while cueing it turns deck B's neon green over a beat", () => {
    expect(wave).toContain("color(onBeat ? PLAYHEAD_ON_BEAT : PLAYHEAD)");
    expect(wave).toContain('const PLAYHEAD = "var(--cm-playhead)";');
    expect(wave).toContain('const PLAYHEAD_ON_BEAT = "var(--cm-deck-b)";');
    // One token for every drawing of the playhead (lanes, caps, overview line), the app's cyan in both themes.
    expect(source("styles/deck.css").match(/--cm-playhead: var\(--cm-cyan\);/g)).toHaveLength(2);
    expect(source("components/MiniPlayer.tsx")).toContain("cueing: a.paused || jogRef.current != null");
  });
  test("the downbeat overlay sits on the lane's outer edge, clear of the seam", () => {
    expect(wave).toContain('<div ref={overlay} className={cn("absolute right-1');
    expect(wave).toContain('edge === "top" ? "top-1" : "bottom-1"');
  });
  test("the DOWNBEAT tools show only with the pointer over their lane or keyboard focus on one of them; the grid's tag stays", () => {
    expect(wave).toContain('data-deck-scroll-waveform className={cn("group/lane relative');
    const tools = wave.match(/<span data-downbeat-tools className="([^"]*)">/)?.[1] ?? "";
    // Hidden from sight but still reachable with Tab; touch screens have no hover, so they always show.
    for (const part of ["sr-only", "group-hover/lane:not-sr-only", "group-hover/lane:flex", "focus-within:not-sr-only", "focus-within:flex", "[@media(hover:none)]:not-sr-only"]) expect(tools).toContain(part);
    const block = wave.slice(wave.indexOf("<span data-downbeat-tools"), wave.indexOf("</span>\n        )}\n      </div>"));
    for (const label of ["DOWNBEAT", "Ορισμός downbeat στη θέση αναπαραγωγής", "Downbeat ένα beat νωρίτερα", "Downbeat ένα beat αργότερα", "Επαναφορά downbeat"]) expect(block).toContain(label);
    expect(block).not.toContain("εκτίμηση");
    // With no tag to show, the chip itself is out of sight until then.
    expect(wave).toContain('!gridTag && "opacity-0 focus-within:opacity-100 group-hover/lane:opacity-100 [@media(hover:none)]:opacity-100"');
  });
  test("each deck's half of the facts row is its own slot, a size container framed in the deck's colour", () => {
    const slot = source("components/DeckViewSlot.tsx");
    expect(slot).toContain("ref={deck === \"A\" ? factsA : factsB} data-deck-facts={deck}");
    expect(slot).toContain("setDeckView({ factsA: el })");
    expect(slot).toContain("setDeckView({ factsB: el })");
    // The frame: the lane's 3 px rail at both edges of the half and a 2 px line along its bottom, drawn over the padding
    // (the row stays 60 px); under the centre cell the bottom line runs from deck A's colour to deck B's.
    expect(slot).toContain('absolute inset-y-0 left-0 w-[3px] bg-[var(--deck)]');
    expect(slot).toContain('absolute inset-y-0 right-0 w-[3px] bg-[var(--deck)]');
    expect(slot).toContain('data-deck-facts-base className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[var(--deck)]');
    expect(slot).toContain('bottom-0 h-[2px] bg-linear-to-r from-[var(--cm-deck-a)] to-[var(--cm-deck-b)]');
    expect(slot).toContain('relative flex min-w-0 flex-1 px-[11px] py-[2px]');
    expect(slot).toContain("[&:has(>[data-deck-facts-half])>[data-deck-facts-empty]]:hidden");
    // Screen first, then the row, in both positions; the row stays when the lanes are folded.
    expect(slot).toMatch(/\{facts\("A"\)\}\s*\{centre\}\s*\{facts\("B"\)\}/);
    expect(slot).not.toMatch(/mode === "full" && \(?\s*<div data-deck-facts-row/);
  });
  test("MiniPlayer passes the pad layout to the big waveform too", () => {
    const mini = source("components/MiniPlayer.tsx");
    expect(mini).toMatch(/<DeckScrollWaveform[^>]*cueSlots=\{padLayout\.slots\}/);
  });
  test("draw reads both prefs from the live ref, never a stale closure", () => {
    expect(wave).toMatch(/live\.current = \{[^}]*strongGrid[^}]*translucent[^}]*\}/);
    expect(wave).toContain("gridStyle(live.current.strongGrid)");
    expect(wave).toContain("ctx.globalAlpha = live.current.translucent ? 0.7 : 1;");
  });
  test("the panel area lightens in translucent mode", () => {
    const slot = source("components/DeckViewSlot.tsx");
    expect(slot).toContain('usePref("waveformTranslucent")');
  });
  test("translucency applies only in full mode, where the toggle that turns it off is visible", () => {
    const slot = source("components/DeckViewSlot.tsx");
    expect(slot).toContain('translucent ? "bg-[var(--cm-wave-bg-translucent)]" : "bg-[var(--cm-wave-bg)]"');
    expect(slot).toMatch(/mode === "full" && \([\s\S]{0,200}<div data-deck-screen/);
  });
  test("MiniPlayer's load effect still depends only on the track, token and autoplay", () => {
    expect(source("components/MiniPlayer.tsx")).toContain("}, [current?.id, token, autoPlay]);");
  });
});
