// Embedded-tag + filename/folder inference. Exact behavioral port of
// backend/app/services/metadata_reader.py, with ffprobe JSON tags (see
// ffprobe.ts) replacing Mutagen as the embedded-tag source (guide §11 — the
// Deno port has no Mutagen equivalent, so ffprobe supplies both tags and
// stream info from one subprocess call). All filename/folder text-cleaning
// logic below is an unchanged line-for-line port. Read-only: never writes to
// the probed file.

import type { FfprobeJson } from "./ffprobe.ts";

// ---- regex ports (see metadata_reader.py for the exact python patterns) --

const DASH_SPLIT = /\s+[–—-]\s+/;
const LEADING_TRACK_NO_RE = /^\s*\d{1,3}(?:\s*[.)_-]\s*|\s+)/;
const WHITESPACE_RE = /\s+/g;
const DECORATION_RE = /[★☆☠♬ॐ❤🧡💛💚💙💜]+/gu;
const PROMO_RE_G =
  /(?:free[\s_-]*(?:download|dwnld|downloadlink|dl)|freedownload(?:link)?|out now|preview|fulltrack)/gi;
const PROMO_RE =
  /(?:free[\s_-]*(?:download|dwnld|downloadlink|dl)|freedownload(?:link)?|out now|preview|fulltrack)/i;
const BY_LABEL_RE =
  /\s*(?:[-–—]|by)\s+[^-–—()[\]]*(?:records?|recs?\.?|music|media|productions?|prod\.?|creation|mpp)\b[^-–—()[\]]*$/gi;
const TRAILING_BY_RE = /\s+by\s+[^-–—()[\]]+$/gi;
const LABEL_HINT_RE = /\b(?:records?|recs?\.?|music|media|productions?|prod\.?|creation|mpp)\b/i;
const ALBUM_HINT_RE = /\b(?:v\.?\s*a\.?|various artists?)\b/i;
const YEAR_HINT_RE = /\b(?:19|20)\d{2}\b/;
const BITS_HINT_RE = /^(?:16|24|32)\s*(?:bit|bits)?$/i;
const TRAILING_CHUNK_RE = /^(.*?)(?:\s*[\[(]([^\])]+)[\])]\s*)$/;
// A trailing bracket chunk counts as BPM only when it is *just* a number
// (optionally "bpm"): "[192]" / "128 bpm" -> BPM; "Area 88" -> not BPM, so a
// parenthetical containing a number is never misread as tempo and deleted.
const PURE_BPM_RE = /^\s*(\d{2,3})\+?\s*(?:bpm)?\s*$/i;

/** Strips a set of chars (not just whitespace) from both ends — mirrors
 * Python's str.strip(chars), which JS's whitespace-only .trim() cannot do. */
function pyStrip(s: string, chars: string): string {
  const set = new Set(chars);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}

/** Mirrors Python's re.split(pattern, s, maxsplit=1) for a separator-only
 * (no capture groups) pattern: returns [s] if no match, else [before, after]. */
function splitFirst(regex: RegExp, s: string): string[] {
  const m = regex.exec(s);
  if (!m) return [s];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

function cleanFilenameToken(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.normalize("NFKC").replace(/_/g, " ");
  text = text.replace(DECORATION_RE, " ");
  text = text.replace(LEADING_TRACK_NO_RE, "");
  text = pyStrip(text.replace(WHITESPACE_RE, " "), " -–—_");
  return text || null;
}

function isBpmValue(value: number | null): boolean {
  return value !== null && value >= 60 && value <= 260;
}

/** BPM from a trailing bracket chunk — only when the chunk is a pure number
 * (optionally "bpm"), never text-with-a-number like "Area 88". */
function chunkBpm(text: string | null): number | null {
  if (!text) return null;
  const m = PURE_BPM_RE.exec(text);
  if (!m) return null;
  const bpm = parseInt(m[1], 10);
  return isBpmValue(bpm) ? bpm : null;
}

function cleanNoise(text: string | null | undefined): string | null {
  if (!text) return null;
  let value = text.normalize("NFKC").replace(/_/g, " ");
  value = value.replace(PROMO_RE_G, " ");
  value = value.replace(BY_LABEL_RE, " ");
  value = value.replace(TRAILING_BY_RE, " ");
  value = value.replace(DECORATION_RE, " ");
  value = value.replace(/•/g, " ");
  value = value.replace(WHITESPACE_RE, " ");
  value = pyStrip(value, " -–—_*#!+");
  return value || null;
}

/** Peel trailing bracket chunks off a title.
 *
 * gentle=true (embedded tags): strip only promo junk and explicit "NNN bpm"
 * chunks — keep years, label names, bits and every other bracket, because an
 * embedded title tag is authoritative. gentle=false (filenames): strip all of
 * those aggressively. */
function stripTitleWrappers(
  title: string,
  gentle = false,
): [string, number | null, string | null] {
  let bpmHint: number | null = null;
  let albumHint: string | null = null;
  let value = title;

  while (true) {
    const m = TRAILING_CHUNK_RE.exec(value);
    if (!m) break;
    const rawChunk = cleanFilenameToken(m[2]);
    const base = m[1];
    if (!rawChunk) {
      value = base;
      continue;
    }
    if (!gentle && ALBUM_HINT_RE.test(rawChunk)) {
      albumHint = albumHint ?? rawChunk;
      value = base;
      continue;
    }
    const chunk = cleanNoise(rawChunk);
    if (!chunk) {
      value = base;
      continue;
    }
    if (gentle) {
      // Keep every remaining bracket (years, labels, bits, remix/version
      // notes) in an embedded title. An explicit inline "NNN bpm" is still
      // handled later by stripInlineBpm.
      break;
    }
    const cBpm = chunkBpm(chunk);
    if (cBpm !== null) {
      bpmHint = bpmHint ?? cBpm;
      value = base;
      continue;
    }
    if (BITS_HINT_RE.test(chunk)) {
      value = base;
      continue;
    }
    if (YEAR_HINT_RE.test(chunk)) {
      value = base;
      continue;
    }
    if (LABEL_HINT_RE.test(chunk)) {
      value = base;
      continue;
    }
    if (PROMO_RE.test(` ${chunk} `)) {
      value = base;
      continue;
    }
    break;
  }

  return [value, bpmHint, albumHint];
}

function stripInlineBpm(title: string, bpmHintIn: number | null): [string, number | null] {
  let bpmHint = bpmHintIn;
  // An explicit "bpm" keyword trusts any in-range value. A bare number is
  // ambiguous ("Route 66" is a title, not 66 BPM), so it only counts as BPM
  // when > 130 — below that, leave the number in the title untouched.
  const patterns: [RegExp, number][] = [
    [/(?:^|\s)[-–—]?\s*(\d{2,3})(?:\+)?\s*bpm(?=$|\s|[-–—()[\]])/gi, 60],
    // Bare trailing number only at absolute end — NOT before a bracket, so
    // "Nightcall (Area 88)" keeps its parenthetical instead of losing "88".
    [/(?:^|\s)[-–—]?\s*(\d{2,3})(?:\+)?(?=$)/gi, 131],
    [/^(?:\s*)(\d{2,3})(?:\+)?\s*[-–—]\s*/gi, 131],
    [/\s*[-–—]\s*(\d{2,3})(?:\+)?$/gi, 131],
  ];
  let value = title;
  for (const [pattern, minBpm] of patterns) {
    value = value.replace(pattern, (full: string, raw: string) => {
      const bpm = parseInt(raw, 10);
      if (bpm >= minBpm && bpm <= 260) {
        bpmHint = bpmHint ?? bpm;
        return " ";
      }
      return full;
    });
  }
  return [value, bpmHint];
}

function sanitizeInferredTitle(
  title: string,
  gentle = false,
): [string | null, number | null, string | null] {
  const cleaned = cleanFilenameToken(title);
  if (!cleaned) return [null, null, null];
  let [value, bpmHint, albumHint] = stripTitleWrappers(cleaned, gentle);
  value = cleanNoise(value) ?? "";
  const afterInline = stripInlineBpm(value, bpmHint);
  value = afterInline[0];
  bpmHint = afterInline[1];
  const finalValue = cleanNoise(value);
  return [finalValue, bpmHint, albumHint];
}

export function looksLikeLabelName(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = cleanFilenameToken(value);
  if (!text) return false;
  const lowered = text.toLowerCase();
  if (lowered.includes("(official)")) return true;
  return LABEL_HINT_RE.test(text);
}

export function looksLikeTrackIndex(value: string | null | undefined): boolean {
  if (!value) return true;
  return /^\d{1,3}[.-]?$/.test(value.trim());
}

function sanitizeExistingArtist(artist: string | null | undefined): string | null {
  return cleanFilenameToken(artist);
}

function looksLikeArtist(value: string | null): boolean {
  if (!value) return false;
  if ([...value].length < 2) return false;
  if (/^[\d\s.-]+$/.test(value)) return false;
  return true;
}

/** Whether a filename/title-derived `candidate` should override the stored
 * `current` artist. Empty or track-number artists are always replaced; a
 * label-looking artist is replaced only by a genuinely different, non-label
 * name, so a real act whose name contains a label word ("Cosmic Music") is
 * kept while a comp that mis-tagged the label as artist is still corrected. */
function shouldReplaceArtist(
  current: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  if (!candidate) return false;
  if (!current || looksLikeTrackIndex(current)) return true;
  if (looksLikeLabelName(current)) {
    return (
      candidate.trim().toLowerCase() !== current.trim().toLowerCase() &&
      !looksLikeLabelName(candidate)
    );
  }
  return false;
}

export interface InferredFields {
  artist?: string;
  title?: string;
  label?: string;
  bpm?: number;
  album?: string;
}

export function inferTagsFromStem(stem: string, gentle = false): InferredFields {
  if (!stem) return {};
  const out: InferredFields = {};
  const parts = splitFirst(DASH_SPLIT, stem);

  if (parts.length === 2) {
    const artist = cleanFilenameToken(parts[0]);
    const [title, bpmHint, albumHint] = sanitizeInferredTitle(parts[1], gentle);
    if (looksLikeArtist(artist) && title) {
      if (looksLikeLabelName(artist)) {
        const nested = splitFirst(DASH_SPLIT, parts[1]);
        if (nested.length === 2) {
          const nestedArtist = cleanFilenameToken(nested[0]);
          const [nestedTitle, nestedBpm, nestedAlbum] = sanitizeInferredTitle(nested[1], gentle);
          if (looksLikeArtist(nestedArtist) && nestedTitle) {
            out.artist = nestedArtist as string;
            out.title = nestedTitle;
            out.label = artist as string;
            const bpmFinal = nestedBpm !== null ? nestedBpm : bpmHint;
            if (bpmFinal !== null) out.bpm = bpmFinal;
            const finalAlbum = nestedAlbum ?? albumHint;
            if (finalAlbum) out.album = finalAlbum;
            return out;
          }
        }
      }
      out.artist = artist as string;
      out.title = title;
      if (bpmHint !== null) out.bpm = bpmHint;
      if (albumHint) out.album = albumHint;
      return out;
    }
  }

  const [title, bpmHint, albumHint] = sanitizeInferredTitle(stem, gentle);
  if (title) out.title = title;
  if (bpmHint !== null) out.bpm = bpmHint;
  if (albumHint) out.album = albumHint;
  return out;
}

function pathStem(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(0, idx) : base;
}

/** Best-effort fallback from basename. Supported: "Artist - Title.ext",
 * "Artist – Title.ext", "Artist — Title.ext", bare "Title.ext". */
export function inferTagsFromFilename(filePath: string): InferredFields {
  const stem = cleanFilenameToken(pathStem(filePath));
  if (!stem) return {};
  return inferTagsFromStem(stem);
}

function coerceYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d{4})/.exec(raw);
  return m ? parseInt(m[1], 10) : null;
}

function coerceBpm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d+(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---- ffprobe tag lookup (replaces Mutagen's `audio.keys()` lookup) -------

const FIELD_CANDIDATES: Record<string, string[]> = {
  artist: ["artist", "album_artist", "author"],
  title: ["title"],
  album: ["album"],
  label: ["label", "organization", "publisher"],
  genre: ["genre"],
  comment: ["comment", "description"],
  date: ["date", "year"],
  bpm: ["bpm", "tbpm"],
  key_text: ["initialkey", "key"],
};

/** Case-insensitive tag lookup merging stream(audio).tags and format.tags —
 * format-level tags win when both are present, since they're the more
 * commonly populated location for container-level metadata. */
function buildTagLookup(data: FfprobeJson | null): (candidates: string[]) => string | null {
  const merged: Record<string, string> = {};
  const audio = (data?.streams ?? []).find((s) => s.codec_type === "audio");
  for (const [k, v] of Object.entries(audio?.tags ?? {})) merged[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(data?.format?.tags ?? {})) merged[k.toLowerCase()] = v;
  return (candidates: string[]): string | null => {
    for (const cand of candidates) {
      const v = merged[cand.toLowerCase()];
      if (v !== undefined) {
        const s = String(v).trim();
        if (s) return s;
      }
    }
    return null;
  };
}

export interface TagFields {
  artist?: string;
  title?: string;
  album?: string;
  label?: string;
  genre?: string;
  comment?: string;
  year?: number;
  bpm?: number;
  key_text?: string;
  rating?: number;
}

/** Returns normalised embedded tags merged with filename/folder inference.
 * Exact port of metadata_reader.py:read_tags, sourcing tags from ffprobe
 * JSON instead of Mutagen. Never throws — returns {} on nothing usable. */
export function extractTags(data: FfprobeJson | null, filePath: string): TagFields {
  const lookup = buildTagLookup(data);
  const out: Record<string, unknown> = {
    artist: lookup(FIELD_CANDIDATES.artist),
    title: lookup(FIELD_CANDIDATES.title),
    album: lookup(FIELD_CANDIDATES.album),
    label: lookup(FIELD_CANDIDATES.label),
    genre: lookup(FIELD_CANDIDATES.genre),
    comment: lookup(FIELD_CANDIDATES.comment),
    year: coerceYear(lookup(FIELD_CANDIDATES.date)),
    bpm: coerceBpm(lookup(FIELD_CANDIDATES.bpm)),
    key_text: lookup(FIELD_CANDIDATES.key_text),
  };

  const ratingRaw = lookup(["rating"]);
  if (ratingRaw) {
    const n = parseFloat(ratingRaw);
    out.rating = Number.isFinite(n) ? Math.trunc(n) : null;
  }

  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined) delete out[k];
  }

  if ("artist" in out) {
    const sanitized = sanitizeExistingArtist(out.artist as string);
    if (sanitized === null) delete out.artist;
    else out.artist = sanitized;
  }

  let titleHint: string | null = null;
  let bpmHint: number | null = null;
  let albumHint: string | null = null;

  if (out.title) {
    // gentle: the title is an embedded tag, so keep years/labels/brackets.
    const [th, bh, ah] = sanitizeInferredTitle(out.title as string, true);
    titleHint = th;
    bpmHint = bh;
    albumHint = ah;
    const parsedTitle = inferTagsFromStem(out.title as string, true);
    if (parsedTitle.title) titleHint = parsedTitle.title;
    if (shouldReplaceArtist(out.artist as string | undefined, parsedTitle.artist)) {
      out.artist = parsedTitle.artist;
    }
    if (!out.label && parsedTitle.label) out.label = parsedTitle.label;
    if (bpmHint === null && parsedTitle.bpm !== undefined) bpmHint = Math.trunc(parsedTitle.bpm);
    if (!albumHint && parsedTitle.album) albumHint = parsedTitle.album;
  }

  if (titleHint) out.title = titleHint;
  if (!out.album && albumHint) out.album = albumHint;
  if (out.bpm === undefined && bpmHint !== null) out.bpm = bpmHint;

  const inferred = inferTagsFromFilename(filePath);
  if (shouldReplaceArtist(out.artist as string | undefined, inferred.artist)) {
    out.artist = inferred.artist;
  }
  if (!out.label && inferred.label) out.label = inferred.label;
  if (!out.title && inferred.title) out.title = inferred.title;
  if (!out.album && inferred.album) out.album = inferred.album;
  if (out.bpm === undefined && inferred.bpm !== undefined) out.bpm = inferred.bpm;

  return out as TagFields;
}
