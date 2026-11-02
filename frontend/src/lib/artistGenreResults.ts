import type { ArtistProfile, ArtistResearch } from "./types";

export const ARTIST_GENRES = [
  "Goa Trance", "Prog-psy", "Full-On", "Morning Full-On", "Night Full-On", "Twilight",
  "Darkpsy", "Forest", "Hi-Tech", "Psycore", "Zenonesque", "Psydub",
] as const;

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
  if (!research || research.model !== "gpt-6-luna" || research.workflow !== "artist-genre-research-v1"
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
      && ARTIST_GENRES.some(genre => genre === value) && value !== primary))];
  } catch { return []; }
}

function resultFrom(profile: Partial<ArtistProfile>, confirmed: boolean, choice: ArtistGenreResult["choice"]): ArtistGenreResult | null {
  const research = profile.research;
  if (!usableResearch(research)) return null;
  const manualGenre = confirmed && typeof research.manual_genre === "string" ? research.manual_genre.trim() : "";
  const primary = typeof profile.primary_subgenre === "string" ? profile.primary_subgenre.trim() : "";
  if (research.status === "classified" && !manualGenre && !ARTIST_GENRES.some(genre => genre === primary)) return null;
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
  // A timestamp or an old genre estimate alone cannot establish a completed Luna result.
  try {
    const raw = JSON.parse(row.raw_llm_json || "null");
    if (!raw || !usableResearch(raw.research) || raw.research.workflow !== row.research?.workflow
      || raw.research.status !== row.research?.status || raw.research.model !== row.research?.model) return null;
  } catch { return null; }
  return resultFrom(row, false, "current");
}
