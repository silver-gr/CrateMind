import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RESEARCH_AT_ONCE, SECONDS_PER_ARTIST, durationText, researchAgainDialog } from "../src/lib/researchAgain";
import { translateJobError } from "../src/lib/labels";

test("the page's calls-at-once matches the backend's window", () => {
  const backend = readFileSync(new URL("../../backend/app/services/artist_intelligence.py", import.meta.url), "utf8");
  expect(backend).toContain(`RESEARCH_AGAIN_WIDTH = ${RESEARCH_AT_ONCE}\n`);
  expect(SECONDS_PER_ARTIST).toBe(40);
});

test("duration is about 40 seconds each, three at a time, in Greek", () => {
  expect(durationText(1)).toBe("περίπου 1 λεπτό");
  expect(durationText(45)).toBe("περίπου 10 λεπτά");
  expect(durationText(90)).toBe("περίπου 20 λεπτά");
  expect(durationText(270)).toBe("περίπου 1 ώρα");
  expect(durationText(459)).toBe("περίπου 1 ώρα και 42 λεπτά");
  expect(durationText(1080)).toBe("περίπου 4 ώρες");
});

test("the dialog states count, model, duration, the confirmed rule, the keep-old rule and the stop", () => {
  const dialog = researchAgainDialog(459, "claude-opus-5-5");
  expect(dialog.canStart).toBe(true);
  const text = dialog.lines.join("\n");
  expect(text).toContain("459 καλλιτέχνες θα ερευνηθούν ξανά με το μοντέλο «claude-opus-5-5».");
  expect(text).toContain("Διάρκεια: περίπου 1 ώρα και 42 λεπτά (περίπου 40 δευτερόλεπτα ο καθένας, 3 μαζί).");
  expect(text).toContain("Τα είδη που έχεις επιβεβαιώσει δεν αλλάζουν.");
  expect(text).toContain("μένει το παλιό");
  expect(text).toContain("να τη διακόψεις");
  expect(text).toContain("να τη συνεχίσεις αργότερα");
  expect(text).not.toMatch(/Luna/);
  expect(researchAgainDialog(1, "m").lines[0]).toBe("1 καλλιτέχνης θα ερευνηθεί ξανά με το μοντέλο «m».");
  expect(researchAgainDialog(1234, "m").lines[0]).toStartWith("1.234 καλλιτέχνες");
});

test("nothing to do, or no model, cannot start", () => {
  const done = researchAgainDialog(0, "claude-opus-5-5");
  expect(done.canStart).toBe(false);
  expect(done.lines[0]).toContain("Δεν μένει κανείς");
  for (const model of [null, undefined, "", "  "]) {
    const none = researchAgainDialog(10, model);
    expect(none.canStart).toBe(false);
    expect(none.lines[0]).toContain("Μοντέλο AI");
  }
});

test("the job's Greek failure reasons reach the toast as they are", () => {
  const error = "Ευρήματα έτοιμα για έλεγχο: 0 · αποτυχίες: 3 (συχνότερος λόγος: Ο πάροχος απέρριψε το αίτημα "
    + "(HTTP 400 · invalid_request_error)) · Η έρευνα σταμάτησε μόνη της: οι πρώτες 3 κλήσεις απέτυχαν· δεν ερευνήθηκαν 14 καλλιτέχνες.";
  expect(translateJobError(error, "Αποτυχία έρευνας ειδών")).toBe(error);
  expect(translateJobError("LLM request failed (HTTP 400).", "Αποτυχία έρευνας ειδών")).toBe("Αποτυχία έρευνας ειδών");
});
