import { expect, test } from "bun:test";
import { translateJobError } from "../src/lib/labels";

const fallback = "Η σάρωση απέτυχε";

test("scan identity-sync failures are explained in Greek with their cause", () => {
  expect(translateJobError("Catalog scan saved; identity synchronization failed: database or disk is full", fallback))
    .toBe("Η σάρωση αποθηκεύτηκε, αλλά ο συγχρονισμός των ταυτοτήτων απέτυχε (ο δίσκος είναι γεμάτος). Τρέξε ξανά τη σάρωση.");
  expect(translateJobError("Catalog scan saved; identity synchronization failed: attempt to write a readonly database", fallback))
    .toContain("κάνε επανεκκίνηση της εφαρμογής");
});

test("Greek errors pass through and unknown English errors fall back", () => {
  expect(translateJobError("Η εργασία διακόπηκε.", fallback)).toBe("Η εργασία διακόπηκε.");
  expect(translateJobError("insufficient rhythmic evidence", fallback)).toBe(fallback);
  expect(translateJobError(null, fallback)).toBe(fallback);
  expect(translateJobError("database is locked", fallback)).toBe("Η σάρωση απέτυχε: η βάση είναι απασχολημένη από άλλη εργασία.");
});
