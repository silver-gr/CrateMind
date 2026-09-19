// Track search mini-syntax parser — exact port of backend/app/services/search.py's
// tokenizer + `_build_query` filter logic, minus the FTS5 lookups (which need a
// DB handle and live in searchExecutor.ts). Field filters, numeric specs, and
// bare-word flags compile down to SQL predicate fragments + bound params;
// unrecognized `field:value` tokens and unrecognized bare words become free-text
// / exclude-text terms resolved against `track_search` by the executor.
//
// Column/table aliases used throughout: t = tracks, p = track_dj_profile
// (LEFT JOIN on p.track_id = t.id), ap = artist_profiles (LEFT JOIN on
// ap.normalized_name = t.artist_normalized). All column names interpolated
// into SQL come only from the hard-coded maps below (PROFILE_NUM, TRACK_NUM,
// STR_FIELDS) — never from raw user input.

export interface CompiledQuery {
  /** SQL predicate fragments (each already parenthesized) to AND together. */
  conditions: string[];
  /** Bound params for `conditions`, in order. */
  params: (string | number)[];
  /** Free-text terms (AND-quoted-phrase match against track_search). */
  freeTerms: string[];
  /** Excluded-text terms (OR-quoted-phrase match against track_search, then
   * NOT IN'd from the result). */
  excludeTerms: string[];
}

// ---- field maps (verbatim port of search.py's _PROFILE_NUM/_TRACK_NUM/_STR_FIELDS) ----

const PROFILE_NUM = new Set([
  "energy",
  "intensity",
  "darkness",
  "melody",
  "weirdness",
  "mixability",
  "confidence",
  "chaos_level",
  "tempo_bridge_score",
]);

const TRACK_NUM = new Set(["bpm", "year", "rating"]);

type StrFieldModel = "profile" | "track" | "artist";
type StrFieldKind = "exact" | "contains" | "review";

const STR_FIELDS: Record<string, [StrFieldModel, string, StrFieldKind]> = {
  role: ["profile", "set_role", "contains"],
  transition: ["profile", "transition_role", "contains"],
  substyle: ["profile", "psy_substyle", "contains"],
  groove: ["profile", "groove_type", "contains"],
  break: ["profile", "breakdown_profile", "contains"],
  drop: ["profile", "drop_profile", "contains"],
  bassline: ["profile", "bassline_type", "contains"],
  lead: ["profile", "lead_character", "contains"],
  festival: ["profile", "festival_time", "contains"],
  crowd: ["profile", "crowd_risk", "contains"],
  vocal: ["profile", "vocal_density", "contains"],
  tolerance: ["profile", "bpm_jump_tolerance", "contains"],
  status: ["profile", "personal_status", "exact"],
  key: ["track", "key_text", "exact"],
  genre: ["track", "genre", "contains"],
  artist: ["track", "artist", "contains"],
  label: ["track", "label", "contains"],
  album: ["track", "album", "contains"],
  artist_scene: ["artist", "scene_cluster", "contains"],
  artist_subgenre: ["artist", "primary_subgenre", "contains"],
  artist_confidence: ["artist", "confidence_label", "exact"],
  artist_review: ["artist", "needs_review", "review"],
};

const MODEL_ALIAS: Record<StrFieldModel, string> = { profile: "p", track: "t", artist: "ap" };

const STATUS_VALUES = new Set(["unknown", "testing", "approved", "weapon", "retired", "avoid"]);

// ---- tokenizer (shlex-like quotes, whitespace fallback) ----

/** Quote-aware whitespace tokenizer approximating Python's `shlex.split`
 * (posix mode): single quotes are fully literal, double quotes allow `\"`
 * and `\\` escapes, and a bare backslash outside quotes escapes the next
 * character. Throws on an unterminated quote so the caller can fall back to
 * a plain whitespace split — mirrors `search.py`'s `except ValueError`. */
function shlexSplit(input: string): string[] {
  const tokens: string[] = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;

    let token = "";
    let inSingle = false;
    let inDouble = false;

    while (i < n) {
      const ch = input[i];
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
          i++;
          continue;
        }
        token += ch;
        i++;
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
          i++;
          continue;
        }
        if (ch === "\\" && i + 1 < n && (input[i + 1] === '"' || input[i + 1] === "\\")) {
          token += input[i + 1];
          i += 2;
          continue;
        }
        token += ch;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "\\" && i + 1 < n) {
        token += input[i + 1];
        i += 2;
        continue;
      }
      token += ch;
      i++;
    }

    if (inSingle || inDouble) {
      throw new Error("unterminated quote");
    }
    tokens.push(token);
  }

  return tokens;
}

function tokenize(query: string): string[] {
  const q = query ?? "";
  try {
    return shlexSplit(q);
  } catch {
    return q.split(/\s+/).filter((s) => s.length > 0);
  }
}

// ---- numeric spec parsing (verbatim port of search.py's _parse_numeric) ----

type NumericSpec =
  | { kind: "gte"; value: number }
  | { kind: "lte"; value: number }
  | { kind: "between"; lo: number; hi: number }
  | { kind: "eq"; value: number };

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const RANGE_RE = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/;

/** Strict float parse matching Python's `float(str)` for the plain decimal /
 * exponent forms this domain uses — rejects "" (unlike JS `Number("")`),
 * trailing garbage (unlike `parseFloat`), and hex/Infinity/NaN literals. */
function toFloat(raw: string): number | null {
  if (!FLOAT_RE.test(raw)) return null;
  const v = Number(raw);
  return Number.isNaN(v) ? null : v;
}

/** Python's `raw[:-1].replace(".", "", 1).isdigit()` guard for the trailing
 * "-" (<=) spec: strips at most one "." then requires the remainder to be
 * non-empty and all-digits (so a leading "-" disqualifies it — falls through
 * to the a-b range check instead). */
function isPlainNumberForTrailingMinus(s: string): boolean {
  const dot = s.indexOf(".");
  const stripped = dot === -1 ? s : s.slice(0, dot) + s.slice(dot + 1);
  return stripped.length > 0 && /^[0-9]+$/.test(stripped);
}

function parseNumericSpec(rawInput: string): NumericSpec | null {
  const raw = rawInput.trim();

  if (raw.endsWith("+")) {
    const v = toFloat(raw.slice(0, -1));
    return v === null ? null : { kind: "gte", value: v };
  }
  if (raw.endsWith("-") && isPlainNumberForTrailingMinus(raw.slice(0, -1))) {
    const v = toFloat(raw.slice(0, -1));
    return v === null ? null : { kind: "lte", value: v };
  }
  const m = raw.match(RANGE_RE);
  if (m) {
    return { kind: "between", lo: Number(m[1]), hi: Number(m[2]) };
  }
  const v = toFloat(raw);
  return v === null ? null : { kind: "eq", value: v };
}

function numericCondition(
  colSql: string,
  spec: NumericSpec,
): { sql: string; params: number[] } {
  switch (spec.kind) {
    case "gte":
      return { sql: `${colSql} >= ?`, params: [spec.value] };
    case "lte":
      return { sql: `${colSql} <= ?`, params: [spec.value] };
    case "between":
      return { sql: `${colSql} BETWEEN ? AND ?`, params: [spec.lo, spec.hi] };
    case "eq":
      return { sql: `${colSql} = ?`, params: [spec.value] };
  }
}

/** Python's strict `int(str)` — rejects "", decimals, and non-digit content
 * (unlike `parseInt`, which stops at the first invalid character). */
function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

// ---- main compiler ----

/** Compiles a search-mini-syntax query string into SQL predicate fragments +
 * free/exclude FTS term lists. Pure — does not touch the database; the FTS
 * term lists are resolved against `track_search` by searchExecutor.ts. */
export function compileQuery(query: string): CompiledQuery {
  const tokens = tokenize(query);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const freeTerms: string[] = [];
  const excludeTerms: string[] = [];

  const pushCond = (sql: string, neg: boolean, condParams: (string | number)[]) => {
    conditions.push(neg ? `NOT (${sql})` : `(${sql})`);
    params.push(...condParams);
  };

  for (const tok of tokens) {
    const neg = tok.startsWith("-");
    const body = neg ? tok.slice(1) : tok;

    const colonIdx = body.indexOf(":");
    if (colonIdx !== -1) {
      const field = body.slice(0, colonIdx).toLowerCase();
      const val = body.slice(colonIdx + 1);

      if (PROFILE_NUM.has(field)) {
        const spec = parseNumericSpec(val);
        if (spec) {
          const cond = numericCondition(`p.${field}`, spec);
          pushCond(cond.sql, neg, cond.params);
        }
        continue;
      }
      if (TRACK_NUM.has(field)) {
        const spec = parseNumericSpec(val);
        if (spec) {
          const cond = numericCondition(`t.${field}`, spec);
          pushCond(cond.sql, neg, cond.params);
        }
        continue;
      }
      if (field in STR_FIELDS) {
        const [model, colName, kind] = STR_FIELDS[field];
        const colSql = `${MODEL_ALIAS[model]}.${colName}`;
        if (kind === "exact") {
          pushCond(`${colSql} = ?`, neg, [val]);
        } else if (kind === "review") {
          const truthy = ["1", "true", "yes", "needs_review", "review"].includes(
            val.toLowerCase(),
          );
          if (truthy) {
            pushCond(`${colSql} = ?`, neg, [1]);
          } else {
            // ap is LEFT-joined; tracks with no ArtistProfile row have NULL
            // needs_review — count them as "not needing review" rather than
            // silently dropping them.
            pushCond(`(${colSql} = ? OR ${colSql} IS NULL)`, neg, [0]);
          }
        } else {
          pushCond(`LOWER(${colSql}) LIKE LOWER(?)`, neg, [`%${val}%`]);
        }
        continue;
      }
      if (field === "not_recent" || field === "played_recently") {
        const days = parseIntStrict(val);
        if (days === null) continue;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        if (field === "not_recent") {
          pushCond(`(t.last_played_at IS NULL OR t.last_played_at < ?)`, neg, [cutoff]);
        } else {
          pushCond(`(t.last_played_at IS NOT NULL AND t.last_played_at >= ?)`, neg, [cutoff]);
        }
        continue;
      }

      // Unrecognized field:value -> free text on the *value* only (field name
      // dropped), matching search.py's `(exclude_terms if neg else free_terms).append(val)`.
      (neg ? excludeTerms : freeTerms).push(val);
      continue;
    }

    const low = body.toLowerCase();
    if (low === "untagged" && !neg) {
      conditions.push(`(p.track_id IS NULL)`);
      continue;
    }
    if (low === "weapons") {
      pushCond(`p.personal_status = ?`, neg, ["weapon"]);
      continue;
    }
    if (low === "approved") {
      pushCond(`p.personal_status = ?`, neg, ["approved"]);
      continue;
    }
    if (low === "missing") {
      conditions.push(`(t.missing = ?)`);
      params.push(neg ? 0 : 1);
      continue;
    }
    if (low === "never_played") {
      conditions.push(neg ? `(t.play_count != 0)` : `(t.play_count = 0)`);
      continue;
    }
    if (low === "dramatic" || low === "dramatic_transition_candidate") {
      pushCond(`p.dramatic_transition_candidate = 1`, neg, []);
      continue;
    }
    if (low === "can_cut_into") {
      pushCond(`p.can_cut_into = 1`, neg, []);
      continue;
    }
    if (low === "can_cut_out_of") {
      pushCond(`p.can_cut_out_of = 1`, neg, []);
      continue;
    }
    if (STATUS_VALUES.has(low)) {
      pushCond(`p.personal_status = ?`, neg, [low]);
      continue;
    }

    // Fallback: unrecognized bare word -> free/exclude text, original case
    // preserved (mirrors search.py appending `body`, not `low`). This is
    // also how `-untagged` is handled: the "untagged" special-case above
    // only fires when `!neg`, so a negated "-untagged" falls all the way
    // through to here and becomes an FTS exclusion term instead of a
    // profile-presence filter.
    (neg ? excludeTerms : freeTerms).push(body);
  }

  return { conditions, params, freeTerms, excludeTerms };
}
