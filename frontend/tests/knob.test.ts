import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Knob, knobShortText, knobWheelPx, knobWheelValue } from "../src/components/ui/Knob";

describe("knob wheel steps", () => {
  test("one notch is 0.05 of the travel; Shift is a fine 0.01", () => {
    expect(knobWheelValue(0.2, 0, true, false)).toBe(0.25);
    expect(knobWheelValue(0.2, 0, false, false)).toBe(0.15);
    expect(knobWheelValue(0.2, 0, true, true)).toBe(0.21);
    expect(knobWheelValue(1, 0, true, false)).toBe(1);
    expect(knobWheelValue(-1, 0, false, false)).toBe(-1);
  });
  test("a step that would cross the rest position stops on it", () => {
    expect(knobWheelValue(0.03, 0, false, false)).toBe(0);
    expect(knobWheelValue(-0.02, 0, true, false)).toBe(0);
    expect(knobWheelValue(0, 0, false, false)).toBe(-0.05); // from rest it moves on
    expect(knobWheelValue(-1, -1, true, false)).toBe(-0.95); // a unipolar knob rests at its left end
  });
});

describe("which wheel gestures turn a knob", () => {
  const wheel = (deltaX: number, deltaY: number, shiftKey = false, deltaMode = 0) => knobWheelPx({ deltaX, deltaY, deltaMode, shiftKey });
  test("a mostly vertical gesture turns it, a little sideways drift included", () => {
    expect(wheel(0, -4)).toBe(-4);
    expect(wheel(3, 10)).toBe(10);
    expect(wheel(-2, -3)).toBe(-3);
  });
  test("a sideways trackpad swipe, or one as much sideways as vertical, never turns it", () => {
    expect(wheel(12, 0)).toBe(0);
    expect(wheel(-30, 4)).toBe(0);
    expect(wheel(5, 5)).toBe(0);
  });
  test("with Shift the Mac turns the wheel sideways, so the larger axis turns it (fine steps)", () => {
    expect(wheel(-4, 0, true)).toBe(-4);
    expect(wheel(0, 6, true)).toBe(6);
  });
  test("line and page deltas are scaled to pixels", () => {
    expect(wheel(0, 1, false, 1)).toBe(16);
    expect(wheel(0, -1, false, 2)).toBe(-400);
    expect(wheel(3, 0, false, 1)).toBe(0);
  });
});

describe("the pill's short text", () => {
  test("drops the unit in the mixer's columns", () => {
    expect(knobShortText("+0.0 dB")).toBe("+0.0");
    expect(knobShortText("-7.8 dB")).toBe("−7.8");
    expect(knobShortText("-26.0 dB")).toBe("−26.0");
    expect(knobShortText("Κομμένο")).toBe("−∞");
    expect(knobShortText("LP 40%")).toBe("LP 40");
    expect(knobShortText("HP 100%")).toBe("HP 100");
    expect(knobShortText("Κλειστό")).toBe("0");
  });
  test("wider knobs keep their unit; a two-part text keeps its first part", () => {
    expect(knobShortText("25 %")).toBe("25%");
    expect(knobShortText("75%")).toBe("75%");
    expect(knobShortText("40% cue · 60% master")).toBe("40% cue");
  });
});

describe("knob markup", () => {
  const html = (value: number, valueText?: (v: number) => string, unipolar = false) =>
    renderToString(createElement(Knob, { label: "LOW", value, onChange: () => {}, valueText, unipolar }));
  test("no bubble above the knob any more: the full text is its accessible value, the name shows at rest", () => {
    const out = html(-0.3, () => "-7.8 dB");
    expect(out).toContain('aria-valuetext="-7.8 dB"');
    expect(out).toContain(">LOW<");
    expect(out).not.toContain("−7.8"); // the pill shows only on hover, drag or keyboard focus
  });
  test("the off-rest dot: none at rest, the deck colour off it, rose at the LOW kill", () => {
    expect(html(0, () => "+0.0 dB")).not.toContain("<circle cx=\"16\" cy=\"27.5\"");
    expect(html(-0.3, () => "-7.8 dB")).toContain("fill-[var(--deck,var(--cm-cyan))]");
    expect(html(-1, () => "Κομμένο")).toContain("fill-cm-rose");
    expect(html(-1, undefined, true)).not.toContain("cy=\"27.5\"");
  });
});
