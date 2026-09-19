// Exact port of backend/app/services/artist_normalizer.py.
// Pure text transforms — no filesystem or network access.

const COLLAB_SEPARATORS_RE = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|vs|x|&|,|;)\s+/i;
const WHITESPACE_RE = /\s+/g;
const ALLOWED_CHARS_RE = /[^0-9A-Za-z .'\-_/()+&]/g;

/** Returns a stable, lower-cased artist key or null when unusable.
 * Port of artist_normalizer.py:normalize_artist_name. */
export function normalizeArtistName(name: string | null | undefined): string | null {
  if (!name) return null;
  let value = name.normalize("NFKC").replace(/_/g, " ").trim();
  if (!value) return null;
  value = value.replace(WHITESPACE_RE, " ");
  value = value.replace(ALLOWED_CHARS_RE, "");
  value = value.trim().toLowerCase();
  return value || null;
}

/** Uses the first artist chunk for v1 collaboration handling.
 * Port of artist_normalizer.py:primary_artist_name. */
export function primaryArtistName(name: string | null | undefined): string | null {
  if (!name) return null;
  const value = name.normalize("NFKC").replace(/_/g, " ").trim();
  if (!value) return null;
  const match = COLLAB_SEPARATORS_RE.exec(value);
  const firstChunk = match ? value.slice(0, match.index) : value;
  const primary = firstChunk.replace(WHITESPACE_RE, " ").trim();
  return primary || null;
}

/** Port of artist_normalizer.py:normalize_primary_artist_name — the
 * entrypoint the scanner uses to derive Track.artist_normalized. */
export function normalizeArtist(name: string | null | undefined): string | null {
  return normalizeArtistName(primaryArtistName(name));
}
