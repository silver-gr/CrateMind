import { expect, test } from "bun:test";
import { translateApiError, translateJobError, translateJobMessage } from "../src/lib/labels";

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

test("job result messages are fully Greek", () => {
  expect(translateJobMessage("groups 4")).toBe("Βρέθηκαν 4 ομάδες διπλοτύπων");
  expect(translateJobMessage("groups 1")).toBe("Βρέθηκε 1 ομάδα διπλοτύπων");
  expect(translateJobMessage("groups 0")).toBe("Δεν βρέθηκαν διπλότυπα");
  expect(translateJobMessage("fingerprinted 12")).toBe("Δημιουργήθηκαν fingerprints για 12 tracks");
  expect(translateJobMessage("matched 5, added 2, updated 1, unchanged 2"))
    .toBe("αντιστοιχίστηκαν 5, προστέθηκαν 2, ενημερώθηκαν 1, αμετάβλητα 2");
  expect(translateJobMessage("added 0, updated 0, unchanged 3, missing 0; /Volumes/X: missing-file detection skipped ([Errno 2] No such file or directory: '/Volumes/X') (artist rebuild failed: boom)"))
    .toBe("προστέθηκαν 0, ενημερώθηκαν 0, αμετάβλητα 3, λείπουν 0; /Volumes/X: δεν ελέγχθηκε για αρχεία που λείπουν (ο φάκελος δεν βρέθηκε) (η ενημέρωση των καλλιτεχνών απέτυχε)");
});

test("backend error details become Greek, with a status fallback for unknown English", () => {
  expect(translateApiError(404, "track not found")).toBe("Το track δεν βρέθηκε");
  expect(translateApiError(404, "Artist comparison not found.")).toBe("Η σύγκριση καλλιτέχνη δεν βρέθηκε");
  expect(translateApiError(422, "out_anchor_s exceeds track duration")).toBe("Το σημείο εξόδου είναι μετά το τέλος του track");
  expect(translateApiError(415, "unsupported audio format for in-browser audition: .wma")).toBe("Το format .wma δεν παίζει μέσα στην εφαρμογή");
  expect(translateApiError(400, "essentia BPM is unavailable")).toBe("Δεν υπάρχει BPM από την πηγή essentia");
  expect(translateApiError(409, "Μια ανάλυση BPM/key εκτελείται ήδη.")).toBe("Μια ανάλυση BPM/key εκτελείται ήδη.");
  expect(translateApiError(422, "Field required · Input should be greater than 0")).toBe("Τα στοιχεία δεν είναι έγκυρα");
  expect(translateApiError(500, "Internal Server Error")).toBe("Σφάλμα της υπηρεσίας");
});
