import { describe, expect, test } from "bun:test";
import { knobAngle, knobArc, knobDragValue, knobKeyValue } from "../src/components/ui/Knob";
import { NEUTRAL_FX, faderRate, formatPitchPercent, rateBpmText } from "../src/lib/mixer";
import { suppressPlaybackShortcut } from "../src/lib/keyboardGuard";

describe("knob math", () => {
  test("angle spans +-135 degrees and clamps", () => {
    expect(knobAngle(0)).toBe(0);
    expect(knobAngle(1)).toBe(135);
    expect(knobAngle(-1)).toBe(-135);
    expect(knobAngle(5)).toBe(135);
  });
  test("200 px of upward drag covers the full range", () => {
    expect(knobDragValue(-1, -200)).toBe(1);
    expect(knobDragValue(0, -100)).toBeCloseTo(1);
    expect(knobDragValue(0.5, 50)).toBeCloseTo(0);
    expect(knobDragValue(0, 900)).toBe(-1);
  });
  test("arrow keys step 0.05 and clamp; others ignored", () => {
    expect(knobKeyValue(0, "ArrowUp")).toBe(0.05);
    expect(knobKeyValue(0.1, "ArrowLeft")).toBe(0.05);
    expect(knobKeyValue(1, "ArrowRight")).toBe(1);
    expect(knobKeyValue(0, "a")).toBeNull();
  });
  test("arc path is large-arc only past 180 degrees", () => {
    expect(knobArc(0, 90)).toContain("0 0 1");
    expect(knobArc(-135, 135)).toContain("0 1 1");
    expect(knobArc(0, -90)).toContain("0 0 0");
  });
});

describe("pitch readout", () => {
  test("signed one-decimal percent", () => {
    expect(formatPitchPercent(1)).toBe("0.0%");
    expect(formatPitchPercent(1.024)).toBe("+2.4%");
    expect(formatPitchPercent(0.92)).toBe("-8.0%");
  });
  test("fader rate ignores bend; BPM text scales only when not at 1", () => {
    expect(faderRate({ ...NEUTRAL_FX, pitch: 0.3, bend: { dir: 1, since: 0 } })).toBeCloseTo(1.024);
    expect(rateBpmText(128, 1)).toBe("128 BPM");
    expect(rateBpmText(128, 1.024)).toBe("131.1 BPM");
  });
});

describe("hold-key exemption", () => {
  const el = (hold: boolean) => ({ tagName: "BUTTON", closest: (sel: string) => (hold && sel === "[data-hold-key]" ? {} : null) }) as unknown as EventTarget;
  test("Space and Enter on a hold button never reach transport", () => {
    expect(suppressPlaybackShortcut(el(true), "Space")).toBe(true);
    expect(suppressPlaybackShortcut(el(true), "Enter")).toBe(true);
  });
  test("other elements are unaffected", () => {
    expect(suppressPlaybackShortcut(el(false), "Enter")).toBe(false);
  });
});

describe("radio group arrow keys", () => {
  const radio = (inGroup: boolean) => ({
    tagName: "BUTTON",
    closest: (sel: string) => (inGroup && sel.split(",").some(part => part.trim() === '[role="radiogroup"]') ? {} : null),
  }) as unknown as EventTarget;
  test("arrows, Home and End inside a radio group move focus, never seek the deck", () => {
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect([code, suppressPlaybackShortcut(radio(true), code)]).toEqual([code, true]);
    }
  });
  test("arrows outside a radio group still reach the transport", () => {
    expect(suppressPlaybackShortcut(radio(false), "ArrowRight")).toBe(false);
  });
  test("Space on a focused radio chooses the value instead of toggling the deck", () => {
    const at = (onRadio: boolean) => ({
      tagName: "BUTTON",
      closest: (sel: string) => (onRadio && sel === '[role="radiogroup"] [role="radio"]' ? {} : null),
    }) as unknown as EventTarget;
    expect(suppressPlaybackShortcut(at(true), "Space")).toBe(true);
    expect(suppressPlaybackShortcut(at(false), "Space")).toBe(false);
  });
  test("Space on a focused checkbox toggles it instead of the deck", () => {
    const at = (onCheckbox: boolean) => ({
      tagName: "BUTTON",
      closest: (sel: string) => (onCheckbox && sel === '[role="checkbox"]' ? {} : null),
    }) as unknown as EventTarget;
    expect(suppressPlaybackShortcut(at(true), "Space")).toBe(true);
    expect(suppressPlaybackShortcut(at(false), "Space")).toBe(false);
  });
});
