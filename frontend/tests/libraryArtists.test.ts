import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { awaitingReview, filterArtists } from "../src/lib/libraryArtists";
import type { ArtistProfile, ArtistResearch } from "../src/lib/types";

const research: ArtistResearch = {
  model: "gpt-6-luna", reasoning_effort: "max", workflow: "artist-genre-research-v1", status: "classified",
  reason: "Η επίσημη κυκλοφορία τεκμηριώνει το μουσικό είδος.",
  sources: [{ url: "https://label.example/artist", evidence: "Επίσημη αναφορά στο είδος." }],
  outside_genre: null,
};

function artist(id: number, name: string, review?: "ready" | "confirmed"): ArtistProfile {
  const row: ArtistProfile = {
    id, normalized_name: name.toLowerCase(), canonical_name: name, track_count: 3, needs_review: false,
  };
  if (review === "ready") row.review = { state: "ready", current: { ...row }, candidate: { primary_subgenre: "Forest", research } };
  if (review === "confirmed") {
    Object.assign(row, { primary_subgenre: "Darkpsy", research });
    row.review = { state: "confirmed", current: { ...row }, confirmed_choice: "candidate" };
  }
  return row;
}

test("awaitingReview is true only for an unconfirmed Luna result", () => {
  expect(awaitingReview(artist(1, "Waiting", "ready"))).toBe(true);
  expect(awaitingReview(artist(2, "Confirmed", "confirmed"))).toBe(false);
  expect(awaitingReview(artist(3, "Plain"))).toBe(false);
});

test("filterArtists matches names without accents or case and keeps the server order", () => {
  const rows = [artist(1, "Ελεύθερος"), artist(2, "Astral Projection"), artist(3, "Άστρο"), artist(4, "Infected Mushroom")];
  expect(filterArtists(rows, "")).toBe(rows);
  expect(filterArtists(rows, "   ")).toBe(rows);
  expect(filterArtists(rows, "ASTR").map(row => row.id)).toEqual([2]);
  expect(filterArtists(rows, "αστρ").map(row => row.id)).toEqual([3]);
  expect(filterArtists(rows, " ελευθεροσ ").map(row => row.id)).toEqual([1]);
  expect(filterArtists(rows, "room").map(row => row.id)).toEqual([4]);
  expect(filterArtists(rows, "zzz")).toEqual([]);
});

test("the tab never reads the URL and the page keeps its URL-driven search", () => {
  const hook = readFileSync(new URL("../src/lib/useArtists.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/Artists.tsx", import.meta.url), "utf8");
  expect(hook).not.toContain("useSearchParams");
  expect(page).toContain("useArtists({ enabled: true, q: query, toastOnError: true })");
});

test("the tab hooks latch their first load: a later enabled: false never refetches or drops the rows", () => {
  for (const file of ["useArtists.ts", "usePlayHistoryList.ts"]) {
    const hook = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    expect(hook).toContain("if (enabled && !started) setStarted(true);");
    // `enabled` itself is never an effect dependency, so switching tabs back and forth fetches nothing.
    expect(hook).not.toMatch(/\[[^\]]*\benabled\b[^\]]*\]\);/);
  }
  expect(readFileSync(new URL("../src/lib/useArtists.ts", import.meta.url), "utf8")).toContain("}, [started, load]);");
});
