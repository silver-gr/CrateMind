import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ARTIST_GENRES, getLunaGenreResult, isUnknownArtist } from "../src/lib/artistGenreResults";
import { ArtistGenreResultCard } from "../src/components/ArtistGenreResultCard";
import type { ArtistProfile, ArtistResearch } from "../src/lib/types";

const research = (status: ArtistResearch["status"] = "classified"): ArtistResearch => ({
  model: "gpt-6-luna", reasoning_effort: "max", workflow: "artist-genre-research-v1", status,
  reason: "Η επίσημη κυκλοφορία τεκμηριώνει το μουσικό είδος.",
  sources: [{ url: "https://label.example/artist", evidence: "Επίσημη αναφορά στο είδος." }],
  outside_genre: status === "outside_list" ? "Glitch-Hop" : null,
});

function artist(candidate: Partial<ArtistProfile> | null = { primary_subgenre: "Forest", secondary_subgenres_json: '["Darkpsy"]', confidence_label: "high", research: research() }): ArtistProfile {
  const row: ArtistProfile = {
    id: 1, normalized_name: "example", canonical_name: "Example", track_count: 12, needs_review: true,
    primary_subgenre: "OLD_GENRE", secondary_subgenres_json: '["OLD_SECONDARY"]',
    scene_cluster: "OLD_SCENE", confidence_label: "OLD_CONFIDENCE", notes: "OLD_BIOGRAPHY",
    typical_bpm_min: 999, energy_min: 999,
  };
  row.review = { state: "ready", current: { ...row }, candidate };
  return row;
}

function render(row: ArtistProfile) {
  const result = getLunaGenreResult(row);
  expect(result).not.toBeNull();
  return renderToStaticMarkup(<ArtistGenreResultCard artist={row} result={result!} onLibrary={() => {}} onConfirm={() => {}} />);
}

test("selector uses only the ready Luna finding and never old active metadata", () => {
  const result = getLunaGenreResult(artist());
  expect(result?.primaryGenre).toBe("Forest");
  expect(result?.secondaryGenres).toEqual(["Darkpsy"]);
  expect(result?.confidence).toBe("high");
  expect(result?.choice).toBe("candidate");
  expect(result?.confirmed).toBe(false);
  for (const model of ["legacy-model", "gpt-6-luna-other", "GPT-6-LUNA", ""]) {
    expect(getLunaGenreResult(artist({ primary_subgenre: "Forest", research: { ...research(), model } }))).toBeNull();
  }
  expect(getLunaGenreResult(artist({ primary_subgenre: "Forest", notes: "Legacy" }))).toBeNull();
  expect(getLunaGenreResult(artist(null))).toBeNull();
});

test("pending, error and rejected candidates cannot reappear as final findings", () => {
  for (const state of ["pending", "error", "skipped"]) {
    const row = artist();
    row.review!.state = state;
    expect(getLunaGenreResult(row)).toBeNull();
  }
  const rejected = artist();
  rejected.review!.state = "confirmed";
  rejected.review!.confirmed_choice = "current";
  expect(getLunaGenreResult(rejected)).toBeNull();
  rejected.research = { ...research(), model: "another-model" };
  expect(getLunaGenreResult(rejected)).toBeNull();
});

test("confirmed results come from active Luna metadata and preserve human genre corrections", () => {
  const row = artist();
  row.review!.state = "confirmed";
  row.review!.confirmed_choice = "candidate";
  row.research = research();
  row.primary_subgenre = "Psydub";
  row.secondary_subgenres_json = '["Forest"]';
  const result = getLunaGenreResult(row);
  expect(result?.primaryGenre).toBe("Psydub");
  expect(result?.confirmed).toBe(true);
  expect(result?.choice).toBe("current");
  row.research = { ...research("outside_list"), manual_genre: "Glitch-Hop" };
  expect(getLunaGenreResult(row)?.primaryGenre).toBe("Glitch-Hop");
  expect(getLunaGenreResult(row)?.secondaryGenres).toEqual([]);
  expect(getLunaGenreResult(row)?.confidence).toBeNull();
});

test("completed outside-list and unresolved findings never inherit old genre or confidence", () => {
  for (const status of ["outside_list", "unresolved"] as const) {
    const row = artist({ primary_subgenre: "OLD_CANDIDATE_GENRE", confidence_label: "high", research: research(status) });
    const result = getLunaGenreResult(row);
    expect(result).not.toBeNull();
    expect(result?.primaryGenre).toBeNull();
    expect(result?.secondaryGenres).toEqual([]);
    expect(result?.confidence).toBeNull();
    const html = render(row);
    expect(html).toContain("Ορισμός είδους");
    expect(html).not.toContain("OLD_CANDIDATE_GENRE");
    expect(html).not.toContain("Επιβεβαίωση είδους");
    expect(html).toContain(status === "outside_list" ? "Είδος εκτός της διαθέσιμης λίστας" : "Δεν προέκυψε ασφαλής ταξινόμηση");
  }
});

test("malformed secondary JSON is harmless and valid genres are deduplicated", () => {
  for (const secondary_subgenres_json of ["broken", "null", "{}", "123", '"Forest"']) {
    const result = getLunaGenreResult(artist({ primary_subgenre: "Forest", secondary_subgenres_json, research: research() }));
    expect(result?.secondaryGenres).toEqual([]);
  }
  const result = getLunaGenreResult(artist({ primary_subgenre: "Forest", research: research(), secondary_subgenres_json: '["Forest",null,"Darkpsy","Darkpsy",123,"OTHER"]' }));
  expect(result?.secondaryGenres).toEqual(["Darkpsy"]);
  expect(ARTIST_GENRES).toHaveLength(12);
  expect(ARTIST_GENRES).toContain("Psydub");
});

test("active unreviewed Luna results require a genuine matching raw research envelope", () => {
  const row = artist();
  delete row.review;
  row.research = research();
  row.primary_subgenre = "Forest";
  expect(getLunaGenreResult(row)).toBeNull();
  row.raw_llm_json = JSON.stringify({ research: research() });
  expect(getLunaGenreResult(row)?.choice).toBe("current");
  row.raw_llm_json = JSON.stringify({ research: { ...research(), model: "legacy" } });
  expect(getLunaGenreResult(row)).toBeNull();
  row.normalized_name = "Unknown Artist";
  expect(isUnknownArtist(row)).toBe(true);
  expect(getLunaGenreResult(row)).toBeNull();
});

test("incomplete or unsupported research metadata does not produce a result", () => {
  for (const invalid of [
    { ...research(), reason: " " }, { ...research(), workflow: "legacy" },
    { ...research(), sources: [] }, { ...research(), sources: [{ url: "javascript:alert(1)", evidence: "Unsafe" }] },
  ]) expect(getLunaGenreResult(artist({ primary_subgenre: "Forest", research: invalid }))).toBeNull();
  expect(getLunaGenreResult(artist({ primary_subgenre: "OLD_GENRE", research: research() }))).toBeNull();
});

test("single-result card keeps evidence and correction controls collapsed and excludes old profile data", () => {
  const html = render(artist());
  expect(html).toContain("Example");
  expect(html).toContain("Βιβλιοθήκη");
  expect(html).toContain("Forest");
  expect(html).toContain("Συγγενικά είδη: Darkpsy");
  expect(html).toContain("Βεβαιότητα έρευνας: υψηλή");
  expect(html).toContain("Επιβεβαίωση είδους");
  expect(html).toContain("Διόρθωση");
  expect(html).toContain("Αιτιολόγηση και πηγές (1)");
  expect(html).toContain('<details class=');
  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(html).not.toContain('role="combobox"');
  expect(html).not.toContain("Άλλο μουσικό είδος");
  expect(html).toContain('href="https://label.example/artist"');
  for (const absent of ["OLD_GENRE", "OLD_SECONDARY", "OLD_SCENE", "OLD_CONFIDENCE", "OLD_BIOGRAPHY", "BPM", "Ενέργεια", "Διατήρηση:", "Νέο:"]) expect(html).not.toContain(absent);
});

test("confirmed manual card keeps sources, displays its seal and has no acceptance controls", () => {
  const row = artist();
  row.review!.state = "confirmed";
  row.review!.confirmed_choice = "manual";
  row.research = { ...research("outside_list"), manual_genre: "Glitch-Hop" };
  const html = render(row);
  expect(html).toContain("Glitch-Hop");
  expect(html).toContain("Επιβεβαιωμένο · προστατεύεται από enrichment");
  expect(html).toContain("Χειροκίνητα επιβεβαιωμένο είδος: Glitch-Hop");
  expect(html).toContain('href="https://label.example/artist"');
  expect(html).not.toContain("Επιβεβαίωση είδους");
  expect(html).not.toContain("Διόρθωση");
  expect(html).not.toContain("Βεβαιότητα έρευνας");
});
