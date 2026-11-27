import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import RecommendationCard from "../src/components/RecommendationCard";
import type { Recommendation } from "../src/lib/types";

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  track_id: 7, artist: "Συνθετικός", title: "Δοκιμαστικό (Extended Mix)", bpm: 174, key: "8A", energy: 6, personal_status: "approved",
  score: 80, match: 75, style: "Hi-Tech", bpm_delta_pct: 0.6,
  reasons: ["- → into B key clash 5a→8a", "+ key adjacent 4a→5a", "played recently", "+ style match Hi-Tech"], ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">");

describe("recommendation card", () => {
  test("the title has its own line (two at most) over the artist, and the facts run the card's full width", () => {
    const html = renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />);
    expect(html).toContain('class="line-clamp-2 text-sm font-medium leading-5 text-cm-text">Δοκιμαστικό (Extended Mix)</div>');
    expect(html).toContain('class="truncate text-xs text-cm-muted">Συνθετικός</div>');
    expect(html).toContain('title="Συνθετικός — Δοκιμαστικό (Extended Mix)"');
  });
  test("each reason is its own chip, for before against, with one sign per chip and Camelot codes in capitals", () => {
    const html = renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />);
    const body = text(html);
    const adjacent = body.indexOf("+γειτονικό key 4A→5A"), style = body.indexOf("+ίδιο είδος Hi-Tech");
    const clash = body.indexOf("−→ προς B σύγκρουση key 5A→8A"), recent = body.indexOf("−παίχτηκε πρόσφατα");
    expect(adjacent).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(adjacent);
    expect(clash).toBeGreaterThan(style);
    expect(recent).toBeGreaterThan(clash);
    expect(html.match(/<li class="inline-flex max-w-full items-baseline gap-1 rounded-md border/g)).toHaveLength(4);
    expect(html).toContain('<span class="font-semibold tabular-nums">Hi-Tech</span>');
    expect(body).not.toContain("+ γειτονικό");
  });
  test("the energy meter shares the actions' line; the actions keep the line's end with or without it", () => {
    const html = renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />);
    expect(html.indexOf('aria-label="Ενέργεια"')).toBeLessThan(html.indexOf("στο set"));
    expect(renderToString(<RecommendationCard rec={rec({ energy: null })} onAdd={() => {}} />)).toContain("flex flex-wrap items-center justify-end");
  });
  test("«A» and «B» load on a deck and show only when the page can load one", () => {
    const calls: string[] = [];
    const html = renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} onDeck={deck => calls.push(deck)} />);
    expect(html).toContain('aria-label="Φόρτωση στο Deck A"');
    expect(html).toContain('aria-label="Φόρτωση στο Deck B"');
    expect(html.indexOf("στο set")).toBeLessThan(html.indexOf("Φόρτωση στο Deck A"));
    expect(renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />)).not.toContain("Φόρτωση στο Deck");
  });
});
