import { describe, expect, test } from "bun:test";
import { presetLoadedText, rewrittenSearchesText } from "../src/components/VocabularySettings";

describe("vocabulary toasts", () => {
  test("preset load agrees in number and says when nothing was added", () => {
    expect(presetLoadedText(8, 47)).toBe("Προστέθηκαν 8 λεξιλόγια και 47 τιμές.");
    expect(presetLoadedText(1, 1)).toBe("Προστέθηκαν 1 λεξιλόγιο και 1 τιμή.");
    expect(presetLoadedText(0, 1)).toBe("Προστέθηκε 1 τιμή.");
    expect(presetLoadedText(0, 3)).toBe("Προστέθηκαν 3 τιμές.");
    expect(presetLoadedText(1, 0)).toBe("Προστέθηκε 1 λεξιλόγιο.");
    expect(presetLoadedText(0, 0)).toBe("Το προτεινόμενο λεξιλόγιο υπάρχει ήδη.");
  });

  test("renamed searches agree in number", () => {
    expect(rewrittenSearchesText(1)).toBe("Ενημερώθηκε 1 αποθηκευμένη αναζήτηση.");
    expect(rewrittenSearchesText(3)).toBe("Ενημερώθηκαν 3 αποθηκευμένες αναζητήσεις.");
  });
});
