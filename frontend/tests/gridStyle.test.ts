import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gridStyle, GRID_BAR_COLOR, GRID_BEAT_COLOR } from "../src/lib/gridStyle";
import { DEFAULT_PREFS } from "../src/lib/prefs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("deck beatgrid style", () => {
  test("the default grid is subtle: thin chartreuse bars, faint white beats, small dim numbers", () => {
    expect(gridStyle(false)).toEqual({
      bar: { width: 1, alpha: 0.55, halo: 0.3 },
      beat: { width: 1, alpha: 0.28, halo: 0.18 },
      label: { size: 9, weight: 500, alpha: 0.55, box: 0.35 },
    });
  });
  test("the strong grid is bolder but keeps the new label style", () => {
    expect(gridStyle(true)).toEqual({
      bar: { width: 2, alpha: 1, halo: 0.75 },
      beat: { width: 1, alpha: 0.75, halo: 0.5 },
      label: { size: 10, weight: 500, alpha: 0.8, box: 0.5 },
    });
  });
  test("strong is at least as strong as the default on every line field, and stronger on the alphas", () => {
    const soft = gridStyle(false), strong = gridStyle(true);
    for (const line of ["bar", "beat"] as const) {
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
    expect(wave).toContain("GRID_BAR_COLOR");
  });
});

describe("waveform panel toggles", () => {
  test("both toggles default off in the prefs blob", () => {
    expect(DEFAULT_PREFS.waveformStrongGrid).toBe(false);
    expect(DEFAULT_PREFS.waveformTranslucent).toBe(false);
  });

  const wave = source("components/DeckScrollWaveform.tsx");
  test("the view toggles render once, bottom right of the whole panel, with Greek labels and aria-pressed", () => {
    const slot = source("components/DeckViewSlot.tsx");
    const pill = slot.match(/<div data-waveform-view-toggles[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(pill).toContain("absolute bottom-1 right-1");
    expect(pill).toContain("onPointerDown={e => e.stopPropagation()}");
    expect(pill).toContain('aria-label="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('title="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('aria-label="Έντονο beatgrid"');
    expect(pill).toContain('title="Έντονο beatgrid"');
    expect(pill).toContain("aria-pressed={translucent}");
    expect(pill).toContain("aria-pressed={strongGrid}");
    expect(slot.match(/data-waveform-view-toggles/g)?.length).toBe(1);
    expect(slot).toMatch(/mode === "full" && \(\s*<div data-waveform-view-toggles/);
    expect(wave).not.toContain("Διαφανές πάνελ κυματομορφών\"");
    expect(wave).not.toContain('aria-label="Έντονο beatgrid"');
    expect(wave).not.toContain("setStrongGrid");
    expect(wave).not.toContain("setTranslucent");
  });
  test("the big waveform has a top border matching the panel edge", () => {
    expect(wave).toContain("data-deck-wave-top-border");
    expect(wave).toMatch(/data-deck-wave-top-border[^>]*border-t-2 border-cm-line\/50 dark:border-white\/20/);
  });
  test("pad number tags turn white on the light theme's dark pad colours", () => {
    expect(wave).toContain('ctx.fillStyle = theme === "light" ? "#ffffff" : "#000000";');
  });
  test("pad number tags are placed clear of the top-right overlay", () => {
    expect(wave).toContain("cueTagTop(x / dpr, 12, overlayBox.current)");
    expect(wave).toContain('<div ref={overlay} className="absolute right-1 top-1');
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
    expect(slot).toContain('translucent && mode === "full" ? "bg-cm-bg-2/25 *:bg-cm-bg-2/40" : "bg-cm-bg-2/60"');
  });
  test("MiniPlayer's load effect still depends only on the track, token and autoplay", () => {
    expect(source("components/MiniPlayer.tsx")).toContain("}, [current?.id, token, autoPlay]);");
  });
});
