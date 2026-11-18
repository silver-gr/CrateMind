import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serializeTokens, tokenizeQuery, toggleFieldValue } from "../src/lib/queryGrammar";

// The same fixture pins the Python tokenizer (backend/tests/test_query_grammar.py).
const cases = JSON.parse(
  readFileSync(new URL("../../backend/tests/fixtures/query_grammar.json", import.meta.url), "utf8"),
) as { query: string; tokens: unknown[]; serialized: string }[];

describe("shared query grammar", () => {
  for (const [i, c] of cases.entries()) {
    test(`case ${i}: ${JSON.stringify(c.query)}`, () => {
      expect(tokenizeQuery(c.query)).toEqual(c.tokens);
      expect(serializeTokens(tokenizeQuery(c.query))).toBe(c.serialized);
    });
  }
});

describe("toggleFieldValue", () => {
  test("replaces every positive field token, wildcard included, and keeps the rest as typed", () => {
    expect(toggleFieldValue("bpm:140-150 artist:Astrix -artist:Ace artist:*", "artist", "Infected Mushroom"))
      .toBe('bpm:140-150 -artist:Ace artist:"Infected Mushroom"');
    expect(toggleFieldValue("", "artist", "Ace Ventura")).toBe('artist:"Ace Ventura"');
  });

  test("the active value (accent- and case-insensitive) removes every positive field token", () => {
    expect(toggleFieldValue('status:approved artist:"Ψυχή" ARTIST:other -artist:x', "artist", "ψυχη"))
      .toBe("status:approved -artist:x");
  });
});
