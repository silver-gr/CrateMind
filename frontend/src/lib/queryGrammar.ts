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

/** The query-side fold of backend text_fold.fold_text: NFKD, no combining marks, lower case, ς -> σ. */
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
}

interface TokenSpan {
  token: QueryToken;
  text: string;
}

function tokenSpans(query: string): TokenSpan[] {
  return [...query.matchAll(TOKEN)].map(m => {
    const quoted = m[3] !== undefined;
    return { token: { neg: m[1] !== undefined, field: m[2] ?? null, value: quoted ? m[3] : m[4], quoted }, text: m[0] };
  });
}

/** Rebuild a query without the dropped tokens; kept tokens stay byte-for-byte, then `extra` is appended. */
function rebuild(query: string, drop: (token: QueryToken) => boolean, extra?: QueryToken): string {
  const kept = tokenSpans(query).filter(span => !drop(span.token)).map(span => span.text);
  if (extra) kept.push(serializeTokens([extra]));
  return kept.join(" ");
}

function positiveField(token: QueryToken, field: string): boolean {
  return !token.neg && token.field?.toLowerCase() === field;
}

function isFacetValue(token: QueryToken, key: string, value: string): boolean {
  return positiveField(token, key) && token.value !== "*" && foldText(token.value) === foldText(value);
}

/** True when the query holds a positive `key:value` token (accent- and case-insensitive, like the backend). */
export function facetTokenActive(query: string, key: string, value: string): boolean {
  return tokenizeQuery(query).some(token => isFacetValue(token, key, value));
}

/**
 * Remove `key:value` when present, else add it. In `single` mode, positive tokens of
 * the `siblings` values are replaced. Negated tokens, `key:*` and every other token stay as typed.
 */
export function toggleFacetToken(
  query: string, key: string, value: string, opts: { single: boolean; siblings: string[] },
): string {
  if (facetTokenActive(query, key, value)) return rebuild(query, token => isFacetValue(token, key, value));
  const replaced = opts.single ? opts.siblings : [];
  return rebuild(
    query,
    token => replaced.some(sibling => isFacetValue(token, key, sibling)),
    { neg: false, field: key, value, quoted: true },
  );
}

const RANGE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

/** The last positive `field:lo-hi` range in the query, or null (single values and open ranges are not ranges). */
export function rangeFromQuery(query: string, field: string): [number, number] | null {
  let found: [number, number] | null = null;
  for (const token of tokenizeQuery(query)) {
    const m = positiveField(token, field) ? token.value.match(RANGE) : null;
    if (m) found = [Number(m[1]), Number(m[2])];
  }
  return found;
}

const BOUND = /^(\d+(?:\.\d+)?)([+-]?)$/;

/**
 * What the last positive `field:` token filters, as [lo, hi] on a [min, max] scale:
 * `lo-hi`, `N` → [N, N], `N+` → [N, max] and `N-` → [min, N]. Null when no such token.
 */
export function boundsFromQuery(query: string, field: string, min: number, max: number): [number, number] | null {
  let found: [number, number] | null = null;
  for (const token of tokenizeQuery(query)) {
    if (!positiveField(token, field)) continue;
    const range = token.value.match(RANGE);
    const bound = token.value.match(BOUND);
    if (range) found = [Number(range[1]), Number(range[2])];
    else if (bound) {
      const n = Number(bound[1]);
      found = bound[2] === "+" ? [n, max] : bound[2] === "-" ? [min, n] : [n, n];
    }
  }
  return found;
}

/** Replace every positive `field:` token with `field:lo-hi`, or remove them for `null`. Negated tokens stay. */
export function setRangeToken(query: string, field: string, range: [number, number] | null): string {
  return rebuild(
    query,
    token => positiveField(token, field),
    range ? { neg: false, field, value: `${range[0]}-${range[1]}`, quoted: false } : undefined,
  );
}
