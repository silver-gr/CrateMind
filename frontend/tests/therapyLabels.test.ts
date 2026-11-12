import { describe, expect, test } from "bun:test";
import { axisLabel, editorStatus, fieldLabel, statusLabel, statusValues, writesOnlyShownStatus } from "../src/lib/labels";
import { readFileSync } from "node:fs";
import { numFields } from "../src/lib/profileFields";

describe("profile-aware axis and status labels", () => {
  test("editors show a DJ weapon as approved in therapy", () => {
    expect(editorStatus("weapon", "therapy")).toBe("approved");
    expect(editorStatus("weapon", "dj")).toBe("weapon");
    expect(editorStatus("testing", "therapy")).toBe("testing");
    expect(editorStatus(null, "therapy")).toBe("");
    const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    expect(source("components/ProfileEditor.tsx").includes("active={editorStatus(draft.personal_status) === s}")).toBe(true);
    const queue = source("pages/TaggingQueue.tsx");
    expect(queue.includes("value={editorStatus(profile?.personal_status)}")).toBe(true);
    expect(queue.includes('field === "personal_status" ? editorStatus(profile.personal_status)')).toBe(true);
  });

  test("clicking or keying the status already shown never rewrites a DJ weapon as approved", () => {
    const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    // Only the shown-only status is skipped, so a retry after a failed optimistic write still writes.
    expect(source("components/ProfileEditor.tsx").includes("if (writesOnlyShownStatus(draft.personal_status, status)) return;")).toBe(true);
    const queue = source("pages/TaggingQueue.tsx");
    // Before the current track's profile loads, the queue row's stored status decides.
    const shown = "const shownStatus = profile?.track_id === current.id ? profile.personal_status : current.personal_status;";
    expect(queue.split(shown).length - 1).toBe(2);
    expect(queue.includes("const shownOnly = writesOnlyShownStatus(shownStatus, a.patch.personal_status);")).toBe(true);
    expect(queue.includes("onClick={() => { if (!shownOnly) rate(a.patch, a.flash); }}")).toBe(true);
    expect(queue.includes("const shownOnly = writesOnlyShownStatus(shownStatus, tag.patch.personal_status);")).toBe(true);
    expect(queue.includes("if (shownOnly) { e.preventDefault(); return; }")).toBe(true);
    expect(queue.includes("}, [current, profile, apply, rate, move]);")).toBe(true);
  });

  test("writesOnlyShownStatus: only a write of the status merely shown (therapy weapon as approved) is skipped", () => {
    expect(writesOnlyShownStatus("weapon", "approved", "therapy")).toBe(true);
    expect(writesOnlyShownStatus("weapon", "approved", "dj")).toBe(false);
    expect(writesOnlyShownStatus("approved", "approved", "therapy")).toBe(false);
    expect(writesOnlyShownStatus("testing", "approved", "therapy")).toBe(false);
    expect(writesOnlyShownStatus("weapon", undefined, "therapy")).toBe(false);
    expect(writesOnlyShownStatus(null, "approved", "therapy")).toBe(false);
  });

  test("axisLabel per profile", () => {
    expect(["energy", "darkness", "valence"].map(a => axisLabel(a as "energy", "dj")))
      .toEqual(["Ενέργεια", "Σκοτεινότητα", "Σθένος"]);
    expect(["energy", "darkness", "valence"].map(a => axisLabel(a as "energy", "therapy")))
      .toEqual(["Διέγερση", "Σκοτεινότητα", "Συναισθηματικό σθένος"]);
  });

  test("statusLabel uses the therapy wording and shows weapon as approved", () => {
    expect(statusLabel("approved", "dj")).toBe("εγκεκριμένο");
    expect(statusLabel("approved", "therapy")).toBe("Εγκεκριμένο");
    expect(statusLabel("unknown", "therapy")).toBe("Αταξινόμητο");
    expect(statusLabel("testing", "therapy")).toBe("Υπό δοκιμή");
    expect(statusLabel("retired", "therapy")).toBe("Αποσυρμένο");
    expect(statusLabel("avoid", "therapy")).toBe("Αποφυγή");
    expect(statusLabel("weapon", "therapy")).toBe("Εγκεκριμένο");
    expect(statusLabel("weapon", "dj")).toBe("banger");
  });

  test("statusValues drops weapon in therapy", () => {
    expect(statusValues("therapy")).toEqual(["unknown", "testing", "approved", "retired", "avoid"]);
    expect(statusValues("dj")).toEqual(["unknown", "testing", "approved", "weapon", "retired", "avoid"]);
  });

  test("fieldLabel lower-cases the axis label", () => {
    expect(fieldLabel("energy", "therapy")).toBe("διέγερση");
    expect(fieldLabel("valence", "therapy")).toBe("συναισθηματικό σθένος");
    expect(fieldLabel("energy", "dj")).toBe("ενέργεια");
    expect(fieldLabel("energy")).toBe("ενέργεια");
    expect(fieldLabel("melody", "therapy")).toBe("μελωδία");
  });
});

describe("numFields", () => {
  test("DJ keeps the eight sliders in order", () => {
    expect(numFields("dj").map(f => f.key))
      .toEqual(["energy", "intensity", "darkness", "melody", "weirdness", "chaos_level", "mixability", "confidence"]);
    expect(numFields("dj")[0].label).toBe("Ενέργεια");
  });

  test("therapy shows arousal and valence first and no darkness", () => {
    const fields = numFields("therapy");
    expect(fields.map(f => f.key))
      .toEqual(["energy", "valence", "intensity", "melody", "weirdness", "chaos_level", "mixability", "confidence"]);
    expect(fields[0].label).toBe("Διέγερση");
    expect(fields[1].label).toBe("Συναισθηματικό σθένος");
  });

  test("valence starts at 1, as the API refuses 0", () => {
    expect(numFields("therapy").find(f => f.key === "valence")?.min).toBe(1);
    expect(numFields("therapy").filter(f => f.key !== "valence").every(f => f.min === undefined)).toBe(true);
    const editor = readFileSync(new URL("../src/components/ProfileEditor.tsx", import.meta.url), "utf8");
    expect(editor).toMatch(/min=\{\w+\.min \?\? 0\}/);
    expect(editor.includes('if (await save()) toast.success("Το προφίλ αποθηκεύτηκε")')).toBe(true);
  });

  test("every max is 10 except mixability and confidence", () => {
    for (const profile of ["dj", "therapy"] as const) {
      for (const f of numFields(profile)) {
        expect(f.max).toBe(f.key === "mixability" || f.key === "confidence" ? 5 : 10);
      }
    }
  });
});
