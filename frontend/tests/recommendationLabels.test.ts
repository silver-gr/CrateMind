import { expect, test } from "bun:test";
import { translateRecommendationReason } from "../src/lib/labels";

test("recommendation tempo explanations display whole BPM values", () => {
  expect(translateRecommendationReason("+ BPM close: 180->179.98"))
    .toBe("+ BPM πολύ κοντά: 180->180");
  expect(translateRecommendationReason("+ → into B BPM near: 179.98->185.2"))
    .toBe("+ → προς B BPM κοντά: 180->185");
});

test("rounding tempo does not round unrelated recommendation values", () => {
  expect(translateRecommendationReason("+ energy on target: 7.5"))
    .toBe("+ ενέργεια στον στόχο: 7.5");
  expect(translateRecommendationReason("+ tempo bridge score 0.75"))
    .toBe("+ score γέφυρας tempo 0.75");
});
