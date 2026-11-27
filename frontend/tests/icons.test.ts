import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

// The owner banned the sparkles glyph (2026-11-27): no icon with sparkles anywhere in the app.
test("no sparkles icon is exported or imported", () => {
  expect(readFileSync(new URL("../src/lib/icons.ts", import.meta.url), "utf8")).not.toMatch(/Sparkle/);
  const root = new URL("../src/", import.meta.url).pathname;
  const hits = [...new Glob("**/*.{ts,tsx}").scanSync(root)].filter(f => /Sparkle/.test(readFileSync(root + f, "utf8")));
  expect(hits).toEqual([]);
});
