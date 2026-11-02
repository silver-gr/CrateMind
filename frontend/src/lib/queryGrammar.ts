/**
 * The search query grammar, shared with backend/app/services/query_grammar.py.
 * backend/tests/fixtures/query_grammar.json pins both implementations. Only double
 * quotes quote, there are no escapes, and apostrophes are literal (Greek elision).
 */
export interface QueryToken {
  neg: boolean;
  field: string | null;
  value: string;
  quoted: boolean;
}

// The union of Python's str.isspace() and JavaScript's \s, plus U+FEFF. Never use
// \s or \S: the two languages disagree on U+0085 and U+FEFF.
const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const TOKEN = new RegExp(`(-)?(?:([^${WS}:"]+):)?(?:"([^"]*)"|([^${WS}]+))`, "g");
const HAS_WS = new RegExp(`[${WS}]`);

export function tokenizeQuery(query: string | null | undefined): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const m of (query ?? "").matchAll(TOKEN)) {
    const quoted = m[3] !== undefined;
    tokens.push({ neg: m[1] !== undefined, field: m[2] ?? null, value: quoted ? m[3] : m[4], quoted });
  }
  return tokens;
}

export function serializeTokens(tokens: readonly QueryToken[]): string {
  return tokens
    .map((t) => {
      const value = t.quoted || t.value === "" || HAS_WS.test(t.value) ? `"${t.value}"` : t.value;
      return `${t.neg ? "-" : ""}${t.field ? `${t.field}:` : ""}${value}`;
    })
    .join(" ");
}
