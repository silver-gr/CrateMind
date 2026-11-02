import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serializeTokens, tokenizeQuery } from "../src/lib/queryGrammar";

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
