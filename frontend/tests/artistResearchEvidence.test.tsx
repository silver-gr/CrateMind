import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtistResearchEvidence, canAcceptArtistCandidate, safeArtistSourceUrl } from "../src/components/ArtistResearchEvidence";
import type { ArtistResearch } from "../src/lib/types";

const research = (status: ArtistResearch["status"] = "classified"): ArtistResearch => ({
  workflow: "artist_genre_research_v1",
  status,
  sources: [{ url: "https://artist.example/releases/one", evidence: "Η επίσημη κυκλοφορία αναφέρει Forest." }],
  reason: "Η κυκλοφορία και ο κατάλογος του label συμφωνούν στο είδος.",
  model: "gpt-6-luna",
  reasoning_effort: "max",
});

test("research evidence renders source context with safe external links and no provider internals", () => {
  const html = renderToStaticMarkup(<ArtistResearchEvidence research={research()} />);
  expect(html).toContain("Πρόταση είδους από πηγές");
  expect(html).toContain("Η κυκλοφορία και ο κατάλογος του label συμφωνούν στο είδος.");
  expect(html).toContain('href="https://artist.example/releases/one"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Η επίσημη κυκλοφορία αναφέρει Forest.");
  expect(html).not.toContain("gpt-6-luna");
  expect(html).not.toContain("reasoning_effort");
});

test("research links reject local services, credentials, executable schemes and IP literals", () => {
  for (const value of [
    "javascript:alert(1)", "data:text/html,test", "file:///tmp/evidence", "/relative",
    "https://user:password@artist.example/", "http://localhost:8317/v1", "https://artist.localhost./",
    "http://127.0.0.1:8000", "http://2130706433/", "http://0x7f000001/", "https://[::1]/",
    "https://192.168.1.5/", "https://service.local/", "https://service.internal/", "https://service/",
  ]) expect(safeArtistSourceUrl(value)).toBeNull();
  expect(safeArtistSourceUrl("https://artist.example/releases?q=Forest")?.href).toBe("https://artist.example/releases?q=Forest");
  expect(safeArtistSourceUrl("http://label.example/catalogue")?.protocol).toBe("http:");
  const unsafe = research();
  unsafe.sources = [{ url: "javascript:alert(1)", evidence: "invalid" }];
  const html = renderToStaticMarkup(<ArtistResearchEvidence research={unsafe} />);
  expect(html).not.toContain("href=");
  expect(html).toContain("Δεν υπάρχουν διαθέσιμοι σύνδεσμοι πηγών.");
});

test("outside-list and unresolved findings are explained in Greek and require manual review", () => {
  const outside = { ...research("outside_list"), outside_genre: "Glitch-Hop" };
  const html = renderToStaticMarkup(<ArtistResearchEvidence research={outside} needsReview />);
  expect(html).toContain("Είδος εκτός της διαθέσιμης λίστας");
  expect(html).toContain("Είδος που βρέθηκε: Glitch-Hop");
  expect(html).toContain("όρισε το είδος χειροκίνητα");
  const unresolved = renderToStaticMarkup(<ArtistResearchEvidence research={research("unresolved")} needsReview />);
  expect(unresolved).toContain("Δεν προέκυψε ασφαλής ταξινόμηση");
  expect(unresolved).toContain("όρισε το είδος χειροκίνητα");
  const confirmed = renderToStaticMarkup(<ArtistResearchEvidence research={outside} />);
  expect(confirmed).toContain("Είδος εκτός της διαθέσιμης λίστας");
  expect(confirmed).not.toContain("όρισε το είδος χειροκίνητα");
});

test("only classified research with a primary genre can be accepted, preserving legacy review", () => {
  expect(canAcceptArtistCandidate(undefined)).toBe(false);
  expect(canAcceptArtistCandidate(null)).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Forest", research: research() })).toBe(true);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Forest", research: research() }, "ready")).toBe(true);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Forest", research: research() }, "pending")).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Forest", research: research() }, "error")).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "", research: research() })).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "  ", research: research() })).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Glitch-Hop", research: research("outside_list") })).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "Forest", research: research("unresolved") })).toBe(false);
  expect(canAcceptArtistCandidate({ primary_subgenre: "legacy free text" })).toBe(true);
  expect(canAcceptArtistCandidate({ primary_subgenre: null, notes: "Legacy candidate" })).toBe(true);
});

test("manual confirmation keeps evidence and distinguishes the human genre from the initial research", () => {
  const finding = { ...research("outside_list"), outside_genre: "Bass music", manual_genre: "Glitch-Hop" };
  const html = renderToStaticMarkup(<ArtistResearchEvidence research={finding} />);
  expect(html).toContain("Χειροκίνητα επιβεβαιωμένο είδος: Glitch-Hop");
  expect(html).toContain("Αρχικό εύρημα έρευνας: Είδος εκτός της διαθέσιμης λίστας");
  expect(html).toContain("Είδος που βρέθηκε: Bass music");
  expect(html).toContain(`Αρχικό σκεπτικό έρευνας: ${finding.reason}`);
  expect(html).toContain('href="https://artist.example/releases/one"');
  expect(html).toContain(finding.sources[0].evidence);
  expect(html).not.toContain("όρισε το είδος χειροκίνητα");
});
