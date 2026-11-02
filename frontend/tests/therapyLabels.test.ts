import { describe, expect, test } from "bun:test";
import { axisLabel, fieldLabel, statusLabel, statusValues } from "../src/lib/labels";

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
