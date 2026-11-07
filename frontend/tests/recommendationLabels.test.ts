import { expect, test } from "bun:test";
import { identityAnchorLabel, translateJobMessage, translateRecommendationReason } from "../src/lib/labels";

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

test("a failed new-track analysis reads fully in Greek in the scan message", () => {
  expect(translateJobMessage("added 5, updated 0, unchanged 2, missing 0, skipped duplicates 0 (new-track analysis failed)"))
    .toBe("προστέθηκαν 5, ενημερώθηκαν 0, αμετάβλητα 2, λείπουν 0, παραλείφθηκαν διπλότυπα 0 (η ανάλυση νέων tracks απέτυχε)");
});

test("an identity anchor never shows its raw method key", () => {
  expect(identityAnchorLabel({ method: "existing_exact_metadata" })).toBe("ίδια μεταδεδομένα");
  expect(identityAnchorLabel({ status: "rejected" })).toBe("προηγούμενη απόρριψη");
  expect(identityAnchorLabel({ method: "some_future_method" })).toBe("υπάρχουσα απόφαση");
});

test("merged moved files read in Greek in the scan message", () => {
  expect(translateJobMessage("added 9, updated 0, unchanged 5, missing 9, skipped duplicates 0, merged moved 9, analyzed 9, analysis failed 0"))
    .toBe("προστέθηκαν 9, ενημερώθηκαν 0, αμετάβλητα 5, λείπουν 9, παραλείφθηκαν διπλότυπα 0, συγχωνεύτηκαν μετακινημένα 9, αναλύθηκαν 9, αποτυχίες ανάλυσης 0");
});
