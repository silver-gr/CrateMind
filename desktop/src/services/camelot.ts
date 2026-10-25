// Camelot wheel key mapping and key-compatibility scoring.
// Port of backend/app/services/recommender.py: _CAMELOT, to_camelot, key_fit.

const CAMELOT_MAP: Record<string, string> = {
  "abm": "1a", "g#m": "1a", "b": "1b", "ebm": "2a", "d#m": "2a", "f#": "2b",
  "gb": "2b", "bbm": "3a", "a#m": "3a", "db": "3b", "c#": "3b", "fm": "4a",
  "ab": "4b", "g#": "4b", "cm": "5a", "eb": "5b", "d#": "5b", "gm": "6a",
  "bb": "6b", "a#": "6b", "dm": "7a", "f": "7b", "am": "8a", "c": "8b",
  "em": "9a", "g": "9b", "bm": "10a", "d": "10b", "f#m": "11a", "gbm": "11a",
  "a": "11b", "c#m": "12a", "dbm": "12a", "e": "12b",
  "b#": "8b", "cb": "1b", "e#": "7b", "fb": "12b",
  "b#m": "5a", "cbm": "10a", "e#m": "4a", "fbm": "9a",
};

const CAMELOT_RE = /^(?:[1-9]|1[0-2])[ab]$/;

/** Metadata wins when nonblank, including unrecognized metadata. */
export function effectiveKeyText(
  keyText: string | null | undefined,
  keyAnalyzed: string | null | undefined,
): string | null {
  return keyText?.trim() || keyAnalyzed?.trim() || null;
}

/** Canonical wheel code shared by SQL filtering and catalog statistics. */
export function canonicalKeyOf(keyText: string | null | undefined): string | null {
  if (!keyText) return null;
  const compact = keyText.normalize("NFKC").trim().replace(/\s+/g, "").replaceAll("♯", "#").replaceAll("♭", "b");
  let k = compact.toLowerCase();
  if (CAMELOT_RE.test(k)) return k.toUpperCase();
  const openKey = k.match(/^([1-9]|1[0-2])([md])$/);
  if (openKey) {
    const number = (Number(openKey[1]) + 6) % 12 + 1;
    return `${number}${openKey[2] === "m" ? "A" : "B"}`;
  }
  // The conventional uppercase M suffix means major; lowercase m means minor.
  if (compact.endsWith("M")) k = `${k.slice(0, -1)}major`;
  k = k.replace(/-?sharp/g, "#").replace(/-?flat/g, "b");
  const musical = k.match(/^([a-g](?:#|b)?)(minor|min|moll|m|major|maj|dur)?$/);
  if (!musical) return null;
  const minor = ["minor", "min", "moll", "m"].includes(musical[2]);
  return CAMELOT_MAP[`${musical[1]}${minor ? "m" : ""}`]?.toUpperCase() ?? null;
}

/** Converts a free-text musical key ("Am", "F# minor", "8B") to Camelot
 * notation ("8a"). Port of recommender.py:to_camelot. Returns null for
 * blank or unrecognized input. */
export function camelotOf(keyText: string | null | undefined): string | null {
  return canonicalKeyOf(keyText)?.toLowerCase() ?? null;
}

/** Camelot-wheel fit between a previous key and a candidate key: score plus
 * the human-readable reason text (reason is null when either key is
 * unrecognized). Port of recommender.py:key_fit. */
export function keyFit(
  prev: string | null | undefined,
  cand: string | null | undefined,
): { score: number; reason: string | null } {
  const a = camelotOf(prev);
  const b = camelotOf(cand);
  if (a === null || b === null) return { score: 0.0, reason: null };
  if (a === b) return { score: 10.0, reason: `key match ${b}` };
  const na = parseInt(a.slice(0, -1), 10);
  const la = a.slice(-1);
  const nb = parseInt(b.slice(0, -1), 10);
  const lb = b.slice(-1);
  // adjacent on the wheel (same letter, +/-1 mod 12)
  if (la === lb && (Math.abs(na - nb) === 1 || Math.abs(na - nb) === 11)) {
    return { score: 7.0, reason: `key adjacent ${a}->${b}` };
  }
  // relative major/minor (same number, different letter)
  if (na === nb && la !== lb) {
    return { score: 6.0, reason: `key relative ${a}->${b}` };
  }
  return { score: -3.0, reason: `key clash ${a}->${b}` };
}

/** Camelot-wheel compatibility score only (no reason text) — the T3 contract
 * surface for callers that just need the number. */
export function keyCompatibility(
  prev: string | null | undefined,
  cand: string | null | undefined,
): number {
  return keyFit(prev, cand).score;
}
