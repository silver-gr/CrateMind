import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PALETTE_MIN_HEIGHT,
  PALETTE_STEP,
  paletteDragHeight,
  paletteFrame,
  paletteHeight,
  paletteKeyHeight,
  parsePaletteHeight,
} from "../src/lib/paletteHeight";

describe("the ⌘K palette's height", () => {
  test("by default about 70% of the window, below the title bar and clear of the bottom edge", () => {
    const big = paletteFrame(1270, 32);
    expect(big.preferred).toBe(889);
    expect(big.top).toBeGreaterThan(32);
    expect(big.top + big.max).toBe(1270 - 16);
    expect(paletteHeight(null, big)).toBe(889);
    const laptop = paletteFrame(900, 32);
    expect(paletteHeight(null, laptop)).toBe(630);
    expect(laptop.top + paletteHeight(null, laptop)).toBeLessThanOrEqual(900 - 16);
  });

  test("a short window still fits: the minimum gives way to the window", () => {
    const short = paletteFrame(380, 32);
    expect(short.max).toBeLessThan(PALETTE_MIN_HEIGHT);
    expect(short.min).toBe(short.max);
    expect(paletteHeight(null, short)).toBe(short.max);
    expect(paletteHeight(900, short)).toBe(short.max);
    expect(short.top + short.max).toBe(380 - 16);
  });

  test("a stored height is clamped to the window it opens in, and the stored value itself is left alone", () => {
    const stored = parsePaletteHeight("1100");
    expect(stored).toBe(1100);
    expect(paletteHeight(stored, paletteFrame(1270, 32))).toBe(1100);
    expect(paletteHeight(stored, paletteFrame(900, 32))).toBe(paletteFrame(900, 32).max);
    // Back on the big screen the same stored value applies again: nothing was written in between.
    expect(paletteHeight(stored, paletteFrame(1270, 32))).toBe(1100);
    expect(paletteHeight(100, paletteFrame(1270, 32))).toBe(PALETTE_MIN_HEIGHT);
  });

  test("anything but a positive number is no stored height", () => {
    for (const raw of [null, undefined, "", " ", "abc", "-5", "0", "NaN", "Infinity"]) expect(parsePaletteHeight(raw)).toBeNull();
    expect(parsePaletteHeight("640.4")).toBe(640);
  });

  test("the handle's keys: Down grows, Up shrinks, Home and End go to the limits, other keys do nothing", () => {
    const frame = paletteFrame(900, 32);
    expect(paletteKeyHeight("ArrowDown", 600, frame)).toBe(600 + PALETTE_STEP);
    expect(paletteKeyHeight("ArrowUp", 600, frame)).toBe(600 - PALETTE_STEP);
    expect(paletteKeyHeight("ArrowDown", frame.max - 5, frame)).toBe(frame.max);
    expect(paletteKeyHeight("ArrowUp", frame.min + 5, frame)).toBe(frame.min);
    expect(paletteKeyHeight("Home", 600, frame)).toBe(frame.min);
    expect(paletteKeyHeight("End", 600, frame)).toBe(frame.max);
    expect(paletteKeyHeight("Enter", 600, frame)).toBeNull();
    expect(paletteKeyHeight("ArrowLeft", 600, frame)).toBeNull();
  });

  test("a drag follows the pointer within the limits", () => {
    const frame = paletteFrame(900, 32);
    expect(paletteDragHeight(600, 37.4, frame)).toBe(637);
    expect(paletteDragHeight(600, 2000, frame)).toBe(frame.max);
    expect(paletteDragHeight(600, -2000, frame)).toBe(frame.min);
  });

  test("the palette is height-only resizable, remembered, and the handle is a named, focusable separator", () => {
    const palette = readFileSync(new URL("../src/components/CommandPalette.tsx", import.meta.url), "utf8");
    expect(palette).toContain('aria-label="Ύψος παλέτας"');
    expect(palette).toContain("cursor-row-resize");
    expect(palette).toContain("onDoubleClick={size.reset}");
    expect(palette).toContain("preferenceStorage.setItem(PALETTE_HEIGHT_KEY");
    expect(palette).not.toContain("cursor-col-resize");
    // The list fills the box instead of stopping at 300 px.
    expect(palette).toContain('<CommandList className="max-h-none min-h-0 flex-1">');
  });
});
