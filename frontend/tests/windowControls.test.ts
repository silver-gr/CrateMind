import { expect, test } from "bun:test";
import { captionButtons, hasCustomTitlebar } from "../src/lib/windowControls";

test("captionButtons order, labels, glyphs and commands", () => {
  const b = captionButtons(false);
  expect(b.map((x) => x.id)).toEqual(["minimize", "maximize", "close"]);
  expect(b.map((x) => x.label)).toEqual(["Ελαχιστοποίηση", "Μεγιστοποίηση", "Κλείσιμο"]);
  expect(b.map((x) => x.glyph)).toEqual(["\uE921", "\uE922", "\uE8BB"]);
  expect(b.map((x) => x.command)).toEqual(["plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close"]);
});

test("captionButtons shows restore when maximized", () => {
  const m = captionButtons(true)[1];
  expect(m.label).toBe("Επαναφορά");
  expect(m.glyph).toBe("\uE923");
  expect(m.command).toBe("plugin:window|toggle_maximize");
});

test("hasCustomTitlebar only for the custom marker", () => {
  expect(hasCustomTitlebar({ dataset: { nativeTitlebar: "custom" } })).toBe(true);
  expect(hasCustomTitlebar({ dataset: { nativeTitlebar: "overlay" } })).toBe(false);
  expect(hasCustomTitlebar({ dataset: {} })).toBe(false);
});
