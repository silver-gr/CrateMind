import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("therapy hides DJ-only prefill and facts", () => {
  // The TaggingQueue page module does not load under bun test, so its wiring is checked in the source.
  test("the «Ρόλος» fact row is DJ only", () => {
    const text = source("pages/TaggingQueue.tsx");
    expect(text.includes('if (role && !therapy) rows.push({ label: "Ρόλος"')).toBe(true);
    expect(text.includes("trackFacts(current, profile, keyFormat, therapy)")).toBe(true);
  });

  test("subgenre and role prefill are DJ only; the energy prefill uses the profile's axis label", () => {
    for (const path of ["components/ProfileEditor.tsx", "pages/TaggingQueue.tsx"]) {
      const text = source(path);
      expect([path, text.includes("!therapy && artistPrefill.primary_subgenre &&")]).toEqual([path, true]);
      expect([path, text.includes('`${axisLabel("energy")} OK`')]).toEqual([path, true]);
      expect([path, text.includes('fieldLabel("energy"))')]).toEqual([path, true]);
      expect([path, text.includes('"Ενέργεια OK"')]).toEqual([path, false]);
    }
    expect(source("components/ProfileEditor.tsx").includes("!therapy && prefillRole(artistPrefill) &&")).toBe(true);
    // The not-yet-applied state (the common one) also follows the profile.
    expect(source("pages/TaggingQueue.tsx").includes('`${axisLabel("energy")} OK` : axisLabel("energy")}')).toBe(true);
    expect(source("components/ProfileEditor.tsx").includes('therapy ? "Εφαρμογή διέγερσης" : "Εφαρμογή ενέργειας"')).toBe(true);
  });
});
