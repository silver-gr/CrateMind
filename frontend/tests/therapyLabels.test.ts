import { describe, expect, test } from "bun:test";
import { axisLabel, fieldLabel, statusLabel, statusValues } from "../src/lib/labels";
import { numFields } from "../src/lib/profileFields";

describe("profile-aware axis and status labels", () => {
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
    expect(statusLabel("weapon", "dj")).toBe("όπλο");
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

  test("every max is 10 except mixability and confidence", () => {
    for (const profile of ["dj", "therapy"] as const) {
      for (const f of numFields(profile)) {
        expect(f.max).toBe(f.key === "mixability" || f.key === "confidence" ? 5 : 10);
      }
    }
  });
});
