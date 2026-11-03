import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gridStyle } from "../src/lib/gridStyle";
import { DEFAULT_PREFS } from "../src/lib/prefs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("deck beatgrid style", () => {
  test("the default grid is subtle: thin yellow bars, faint white beats, small dim numbers", () => {
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
});

describe("waveform panel toggles", () => {
  test("both toggles default off in the prefs blob", () => {
    expect(DEFAULT_PREFS.waveformStrongGrid).toBe(false);
    expect(DEFAULT_PREFS.waveformTranslucent).toBe(false);
  });

  const wave = source("components/DeckScrollWaveform.tsx");
  test("the deck waveform renders both toggles bottom right with Greek labels and aria-pressed", () => {
    const pill = wave.match(/<div className="absolute bottom-1 right-1[^"]*"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(pill).toContain("onPointerDown={e => e.stopPropagation()}");
    expect(pill).toContain('aria-label="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('title="Διαφανές πάνελ κυματομορφών"');
    expect(pill).toContain('aria-label="Έντονο beatgrid"');
    expect(pill).toContain('title="Έντονο beatgrid"');
    expect(pill).toContain("aria-pressed={translucent}");
    expect(pill).toContain("aria-pressed={strongGrid}");
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
  test("MiniPlayer's load effect still depends only on the track, token and autoplay", () => {
    expect(source("components/MiniPlayer.tsx")).toContain("}, [current?.id, token, autoPlay]);");
  });
});
