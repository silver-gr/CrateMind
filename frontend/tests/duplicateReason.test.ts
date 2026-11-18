import { describe, expect, test } from "bun:test";
import { translateDuplicateReason } from "../src/lib/labels";

describe("duplicate group reasons in Greek", () => {
  test("every reason the detector writes is translated", () => {
    expect(translateDuplicateReason("exact: identical quick_hash")).toBe("ακριβές: ίδιο quick_hash");
    expect(translateDuplicateReason("audio: same recording by fingerprint — review"))
      .toBe("ήχος: ίδια ηχογράφηση (αποτύπωμα ήχου, π.χ. preview και πλήρες) — έλεγχος");
  });
});
