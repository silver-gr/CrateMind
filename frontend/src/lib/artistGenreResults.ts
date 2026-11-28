import type { ArtistProfile, ArtistResearch } from "./types";

// The genres research may pick and the correction offers; twin of ALLOWED_ARTIST_GENRES in backend/app/artist_vocab.py.
export const ARTIST_GENRES = [
  "Goa Trance", "Prog-psy", "Full-On", "Morning Full-On", "Night Full-On", "Twilight",
  "Darkpsy", "Forest", "Hi-Tech", "Psycore", "Zenonesque",
] as const;
// No longer picked, but a stored one still loads and shows (twin of RETIRED_ARTIST_GENRES).
export const RETIRED_ARTIST_GENRES = ["Psydub"] as const;
const KNOWN_ARTIST_GENRES: readonly string[] = [...ARTIST_GENRES, ...RETIRED_ARTIST_GENRES];
const isKnownGenre = (value: string) => KNOWN_ARTIST_GENRES.includes(value);

/** The manual correction's choices: the pickable genres, plus the artist's current genre when it is a retired one. */
export function genreChoices(current: string | null | undefined): string[] {
  return current && !ARTIST_GENRES.some(genre => genre === current) && isKnownGenre(current) ? [...ARTIST_GENRES, current] : [...ARTIST_GENRES];
}

export interface ArtistGenreResult {
  research: ArtistResearch;
  primaryGenre: string | null;
  secondaryGenres: string[];
  confidence: string | null;
  confirmed: boolean;
  choice: "candidate" | "current";
}

export function isUnknownArtist(row: ArtistProfile): boolean {
  return row.normalized_name.trim().toLowerCase() === "unknown artist";
}

function usableResearch(research: ArtistResearch | null | undefined): research is ArtistResearch {
  // Any model the owner configured counts; the finding names it. A finding without a model is an old one.
  if (!research || typeof research.model !== "string" || !research.model.trim() || research.workflow !== "artist-genre-research-v1"
    || !["classified", "outside_list", "unresolved"].includes(research.status)
    || typeof research.reason !== "string" || !research.reason.trim()
    || !Array.isArray(research.sources)
    || !research.sources.every(source => source && typeof source.url === "string" && typeof source.evidence === "string")) return false;
  if (research.status === "unresolved") return true;
  return research.sources.some(source => {
    try {
      const url = new URL(source.url);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !!source.evidence.trim();
    } catch { return false; }
  });
}

function secondaryGenres(raw: string | null | undefined, primary: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string"
      && isKnownGenre(value) && value !== primary))];
  } catch { return []; }
}

function resultFrom(profile: Partial<ArtistProfile>, confirmed: boolean, choice: ArtistGenreResult["choice"]): ArtistGenreResult | null {
  const research = profile.research;
  if (!usableResearch(research)) return null;
  const manualGenre = confirmed && typeof research.manual_genre === "string" ? research.manual_genre.trim() : "";
  const primary = typeof profile.primary_subgenre === "string" ? profile.primary_subgenre.trim() : "";
  if (research.status === "classified" && !manualGenre && !isKnownGenre(primary)) return null;
  const primaryGenre = manualGenre || (research.status === "classified" ? primary : null);
  return {
    research, primaryGenre,
    secondaryGenres: research.status === "classified" && !manualGenre ? secondaryGenres(profile.secondary_subgenres_json, primaryGenre) : [],
    confidence: research.status === "classified" && !manualGenre && ["high", "medium", "low"].includes(profile.confidence_label || "") ? profile.confidence_label! : null,
    confirmed, choice,
  };
}

export function getLunaGenreResult(row: ArtistProfile): ArtistGenreResult | null {
  if (isUnknownArtist(row)) return null;
  if (row.review?.state === "confirmed") return resultFrom(row, true, "current");
  if (row.review) return row.review.state === "ready" && row.review.candidate ? resultFrom(row.review.candidate, false, "candidate") : null;
  // A timestamp or an old genre estimate alone cannot establish a completed research finding.
  try {
    const raw = JSON.parse(row.raw_llm_json || "null");
    if (!raw || !usableResearch(raw.research) || raw.research.workflow !== row.research?.workflow
      || raw.research.status !== row.research?.status || raw.research.model !== row.research?.model) return null;
  } catch { return null; }
  return resultFrom(row, false, "current");
}
