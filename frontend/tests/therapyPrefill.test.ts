import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("therapy hides DJ-only facts", () => {
  // The TaggingQueue page module does not load under bun test, so its wiring is checked in the source.
  test("the «Ρόλος» fact row is DJ only", () => {
    const text = source("pages/TaggingQueue.tsx");
    expect(text.includes('if (role && !therapy) rows.push({ label: "Ρόλος"')).toBe(true);
    expect(text.includes("trackFacts(current, profile, keyFormat, therapy)")).toBe(true);
  });
});
