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
  test("the reasons run per kind, for before against, each led by one sign, and every reason is still shown", () => {
    const body = text(renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />));
    const forRun = body.indexOf("+γειτονικό key 4a→5a · ίδιο είδος: Hi-Tech");
    const against = body.indexOf("−→ προς B σύγκρουση key 5a→8a · παίχτηκε πρόσφατα");
    expect(forRun).toBeGreaterThan(-1);
    expect(against).toBeGreaterThan(forRun);
    expect(body).not.toContain("+ γειτονικό");
  });
  test("the energy meter shares the actions' line; without energy the action keeps its place at the line's end", () => {
    const html = renderToString(<RecommendationCard rec={rec()} onAdd={() => {}} />);
    expect(html.indexOf('aria-label="Ενέργεια"')).toBeLessThan(html.indexOf("στο set"));
    expect(renderToString(<RecommendationCard rec={rec({ energy: null })} onAdd={() => {}} />)).toContain("ml-auto inline-flex");
  });
});
