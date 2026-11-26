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
    .toBe("Προστέθηκαν: 5, Ενημερώθηκαν: 0, Αμετάβλητα: 2, Λείπουν: 0, Παραλείφθηκαν διπλότυπα: 0 (η ανάλυση νέων tracks απέτυχε)");
});

test("an identity anchor never shows its raw method key", () => {
  expect(identityAnchorLabel({ method: "existing_exact_metadata" })).toBe("ίδια μεταδεδομένα");
  expect(identityAnchorLabel({ status: "rejected" })).toBe("προηγούμενη απόρριψη");
  expect(identityAnchorLabel({ method: "some_future_method" })).toBe("υπάρχουσα απόφαση");
});

test("merged moved files read in Greek in the scan message", () => {
  expect(translateJobMessage("added 9, updated 0, unchanged 5, missing 9, skipped duplicates 0, merged moved 9, analyzed 9, analysis failed 0"))
    .toBe("Προστέθηκαν: 9, Ενημερώθηκαν: 0, Αμετάβλητα: 5, Λείπουν: 9, Παραλείφθηκαν διπλότυπα: 0, Συγχωνεύτηκαν μετακινημένα: 9, Αναλύθηκαν: 9, Αποτυχίες ανάλυσης: 0");
});

test("new recommender reasons read in Greek", () => {
  expect(translateRecommendationReason("+ style match Hi-Tech")).toBe("+ ίδιο είδος: Hi-Tech");
  expect(translateRecommendationReason("+ style near Darkpsy->Forest")).toBe("+ κοντινό είδος: Darkpsy → Forest");
});

test("bridge tempo path reasons round BPM and draw arrows", () => {
  expect(translateRecommendationReason("+ BPM between A and B: 140->144.3->148"))
    .toBe("+ BPM ανάμεσα σε A και B: 140→144→148");
  expect(translateRecommendationReason("- BPM off the A-B path: 140->160->148"))
    .toBe("- BPM εκτός διαδρομής A→B: 140→160→148");
});

test("bridge-leg reasons keep the into-B prefix", () => {
  expect(translateRecommendationReason("+ → into B style near Darkpsy->Forest"))
    .toBe("+ → προς B κοντινό είδος: Darkpsy → Forest");
});

test("a half or double tempo match and an uncertain key are explained in Greek", () => {
  expect(translateRecommendationReason("+ BPM close at half tempo: 138->276.2"))
    .toBe("+ BPM πολύ κοντά: 138->276 (στο μισό tempo)");
  expect(translateRecommendationReason("+ → into B BPM near at double tempo: 140->71"))
    .toMatch(/BPM κοντά: 140->71 \(στο διπλό tempo\)$/);
  expect(translateRecommendationReason("+ BPM between A and B at half tempo: 138->280->142"))
    .toBe("+ BPM ανάμεσα σε A και B: 138→280→142 (στο μισό tempo)");
  expect(translateRecommendationReason("+ key adjacent 8a->9a (uncertain key)")).toBe("+ γειτονικό key 8a->9a (αβέβαιο key)");
  expect(translateRecommendationReason("- → into B key clash 8a->2b (uncertain key)"))
    .toMatch(/σύγκρουση key 8a->2b \(αβέβαιο key\)$/);
});
